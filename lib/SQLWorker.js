/*
  Engine9 client SQL worker.

  A slim, portable SQL layer sharing the exact table upsert logic used by the
  Engine9 server (see ./sql/shared.js).  Supports three connection modes:

    1. Cloudflare D1:      new SQLWorker({ accountId, d1: env.DB })
    2. SQLite (node):      new SQLWorker({ accountId, auth: { database_connection: 'sqlite:///path/db.sqlite' } })
    3. MySQL (node):       new SQLWorker({ accountId, auth: { database_connection: 'mysql://user:pass@host/db' } })

  D1 and sqlite:// use the shared SQLite dialect; everything else uses MySQL.
  knex/better-sqlite3/mysql2 are optional peers only needed for node modes.
*/
import debug$0 from 'debug';
import sqliteDialect from './sql/dialects/SQLite.js';
import sqlShared from './sql/shared.js';
import { buildCreateTable, buildAlterTable } from './sql/sqliteDDL.js';
import { ObjectError, bool, parseRegExp } from './utilities.js';

const debug = debug$0('client:SQLWorker');
const info = debug$0('info:client:SQLWorker');

const SELECTISH = /^\s*(select|with|pragma|explain|show)\b/i;

/* Wraps a Cloudflare D1Database binding with a knex.raw-compatible surface,
   returning better-sqlite3 shaped results so the SQLite dialect's
   parseQueryResults works unchanged. */
class D1Connection {
  constructor(d1) {
    this.d1 = d1;
    this.sqlVersion = 'sqlite-d1';
  }
  async raw(sql, values = []) {
    let stmt = this.d1.prepare(sql);
    if (values && values.length > 0) stmt = stmt.bind(...values);
    if (SELECTISH.test(sql)) {
      const { results } = await stmt.all();
      return results || [];
    }
    const r = await stmt.run();
    return {
      changes: r?.meta?.changes ?? 0,
      lastInsertRowid: r?.meta?.last_row_id
    };
  }
}

function Worker(config = {}) {
  this.accountId = config.accountId || 'client';
  // Optional Durable Object namespace for compact person-id lookups (wrangler PERSON_IDS)
  this.personIds = config.personIds || config.PERSON_IDS || null;
  if (config.d1) {
    this.d1 = config.d1;
    this.dialect = sqliteDialect;
    this.connection = new D1Connection(config.d1);
  } else if (config.knex) {
    this.knex = config.knex;
    this.connection = config.knex;
    this.auth = config.auth || {};
    this.dialect = config.dialect || sqliteDialect;
  } else if (config.auth?.database_connection) {
    this.auth = { ...config.auth };
    if (this.auth.database_connection.indexOf('sqlite://') === 0) {
      this.dialect = sqliteDialect;
    }
    // MySQL dialect is loaded lazily in connect() -- it requires mysql2
  } else {
    throw new Error('SQLWorker requires one of: d1 (Cloudflare binding), knex, or auth.database_connection');
  }
}

Worker.prototype.info = function () {
  return {
    driver: this.dialect?.driver || (this.dialect?.name === 'MySQL' ? 'mysql' : 'unknown'),
    dialect: this.dialect
  };
};

Worker.prototype.connect = async function () {
  if (this.connection) return this.connection;
  const s = this.auth?.database_connection;
  if (!s) throw new Error('No database_connection configured');
  if (s.match(/[#{}]+/)) throw new Error('Invalid connection string, contains some unescaped characters');
  const { default: Knex } = await import('knex');
  if (this.dialect === sqliteDialect) {
    const knex = Knex(this.dialect.getKnexConfig(s));
    knex.sqlVersion = await this.dialect.getSqlVersion(knex);
    this.connection = knex;
    this.knex = knex;
    return knex;
  }
  const { default: mysqlDialect } = await import('./sql/dialects/MySQL.js');
  this.dialect = this.dialect || mysqlDialect;
  const knex = Knex({
    client: 'mysql2',
    connection: s,
    pool: { min: 0, max: 5 }
  });
  const [[{ sqlVersion }]] = await knex.raw('select version() as sqlVersion');
  knex.sqlVersion = sqlVersion;
  this.connection = knex;
  this.knex = knex;
  return knex;
};

Worker.prototype.destroy = async function () {
  if (this.knex?.destroy) await this.knex.destroy();
  this.connection = null;
  this.knex = null;
};

Worker.prototype.parseQueryResults = function ({ sql, results, includeColumns }) {
  if (this.dialect?.parseQueryResults) {
    const o = this.dialect.parseQueryResults({ sql, results, includeColumns });
    if (results && !Array.isArray(results) && results.lastInsertRowid !== undefined) {
      o.lastInsertRowid = results.lastInsertRowid;
    }
    return o;
  }
  // MySQL via knex
  let data;
  let records;
  let modified;
  if (Array.isArray(results)) {
    [data] = results;
    if (Array.isArray(data)) {
      records = data.length;
    } else {
      // OkPacket
      records = data.affectedRows;
      modified = data.changedRows;
      const lastInsertRowid = data.insertId;
      data = [];
      return { data, records, modified, lastInsertRowid };
    }
  } else {
    data = [];
    records = results?.changes;
    modified = results?.changes;
  }
  return { data, records, modified };
};

const columnNameMatch = /^[a-zA-Z0-9_]+$/;
Worker.prototype.escapeColumn = function (f) {
  if (!f.match(columnNameMatch)) throw new Error(`Invalid field name: ${f}`);
  return this.dialect.escapeColumn(f);
};
Worker.prototype.escapeValue = function (t) {
  return this.dialect.escapeValue(t);
};
const tableNameMatch = /^[a-zA-Z0-9_]+$/;
Worker.prototype.escapeTable = function (t) {
  if (!t.match(tableNameMatch)) throw new Error(`Invalid table name: ${t}`);
  return t;
};
Worker.prototype.addLimit = function (sql, limit, offset) {
  return this.dialect.addLimit(sql, limit, offset);
};

Worker.prototype.query = async function (options) {
  let opts = options;
  if (typeof options === 'string') opts = { sql: options };
  if (!opts.sql) throw new Error('No sql provided');
  const connection = await this.connect();
  try {
    const results = await connection.raw(opts.sql, opts.values || []);
    return this.parseQueryResults({ sql: opts.sql, results, includeColumns: opts.includeColumns });
  } catch (e) {
    info('Error running query for account:', this.accountId, opts.sql?.slice(0, 500), e.message);
    throw e;
  }
};

Worker.prototype.ok = async function () {
  const { data } = await this.query('select 1 as ok');
  return data[0];
};

Worker.prototype.tables = async function (options = {}) {
  let d;
  if (this.dialect?.introspection?.tableNames) {
    d = await this.dialect.introspection.tableNames(this, options);
  } else {
    const { data } = await this.query('select TABLE_NAME from information_schema.tables where table_schema=database()');
    d = data.map((t) => t.TABLE_NAME || t.table_name);
  }
  d.sort((a, b) => (a < b ? -1 : 1));
  if (options.filter) {
    const filters = options.filter.split(',').map((r) => parseRegExp(r));
    d = d.filter((t) => filters.some((r) => t.match(r)));
  }
  if (!bool(options.includeTemp, false)) {
    d = d.filter((t) => t.indexOf('temp_') !== 0);
  }
  return { tables: d, records: d.length };
};

Worker.prototype.describe = async function (opts) {
  const { table } = opts;
  if (!table) throw new Error(`No table provided to describe with opts ${Object.keys(opts)}`);
  await this.connect();
  if (this.dialect?.introspection?.describe) {
    return this.dialect.introspection.describe(this, opts);
  }
  // MySQL information_schema path
  const sql = `select database() as DB,
  COLUMN_NAME,COLUMN_TYPE,DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_MAXIMUM_LENGTH,EXTRA
   FROM information_schema.columns WHERE table_schema = Database() AND table_name = '${this.escapeTable(table)}' order by ORDINAL_POSITION`;
  const r = await this.query({ sql });
  const cols = r.data;
  if (cols.length === 0) throw new ObjectError({ message: `Could not find table ${table}`, code: 'DOES_NOT_EXIST' });
  cols.forEach((c) => {
    Object.keys(c).forEach((k) => {
      c[k.toUpperCase()] = c[k];
    });
  });
  const results = { table, database: cols[0].DB };
  results.columns = cols.map((d) => {
    let defaultValue = d.COLUMN_DEFAULT;
    if (defaultValue === 'NULL') defaultValue = null;
    else if (defaultValue === null) defaultValue = undefined;
    const o = {
      name: d.COLUMN_NAME,
      column_type: d.COLUMN_TYPE,
      length: d.CHARACTER_MAXIMUM_LENGTH,
      nullable: d.IS_NULLABLE.toUpperCase() === 'YES',
      extra: d.EXTRA,
      default_value: defaultValue,
      auto_increment: (d.EXTRA || '').toUpperCase().indexOf('AUTO_INCREMENT') >= 0
    };
    return this.dialect.dialectToStandard(o, {});
  });
  return results;
};

Worker.prototype.indexes = async function ({ table, unique, primary }) {
  await this.connect();
  if (this.dialect?.introspection?.indexes) {
    return this.dialect.introspection.indexes(this, { table, unique, primary });
  }
  let sql = `SELECT index_name,group_concat(column_name order by seq_in_index) as columns, not(non_unique) as \`unique\`
    FROM INFORMATION_SCHEMA.STATISTICS where TABLE_SCHEMA = database()
    and table_name='${this.escapeTable(table)}'`;
  if (bool(unique, false)) sql += ' and non_unique=0';
  if (bool(primary, false)) sql += " and index_name='PRIMARY'";
  sql += ' group by table_name,index_name,`unique`';
  const { data } = await this.query(sql);
  return data.map((i) => ({
    index_name: i.INDEX_NAME || i.index_name,
    columns: (i.columns || '').split(','),
    primary: (i.INDEX_NAME || i.index_name) === 'PRIMARY',
    unique: !!i.unique
  }));
};

Worker.prototype.tableType = async function (options) {
  await this.connect();
  const sql = this.dialect?.introspection?.getTypeQuery
    ? this.dialect.introspection.getTypeQuery(this, options.table)
    : `SELECT TABLE_TYPE as type FROM information_schema.tables where table_schema = Database() AND table_name = ${this.escapeValue(options.table)}`;
  const { data } = await this.query(sql);
  if (!data[0]) {
    const error = new Error(`tableType: Could not find type of table ${options.table}`);
    error.does_not_exist = true;
    throw error;
  }
  const test = data[0].type || data[0].TYPE;
  switch (test) {
    case 'BASE TABLE':
    case 'TABLE':
      return 'table';
    case 'VIEW':
      return 'view';
    default:
      throw new Error(`tableType does not recognize type ${test}`);
  }
};

Worker.prototype.drop = async function ({ table }) {
  if (!table) throw new Error('table is required');
  try {
    const type = await this.tableType({ table });
    return await this.query(`drop ${type} if exists ${this.escapeTable(table)}`);
  } catch (e) {
    if (e.does_not_exist) return e;
    throw e;
  }
};

Worker.prototype.truncate = async function ({ table }) {
  if (!table) throw new Error('table is required');
  if (this.dialect?.getTruncateSQL) {
    return this.query(this.dialect.getTruncateSQL(this.escapeTable(table)));
  }
  return this.query(`truncate table ${this.escapeTable(table)}`);
};

/* DDL.  SQLite/D1 uses native DDL generation; MySQL uses knex.schema. */
Worker.prototype.createTable = async function (opts) {
  const { table, columns, indexes = [] } = opts;
  if (!columns || columns.length === 0) throw new Error('columns are required to createTable');
  await this.connect();
  if (this.dialect === sqliteDialect) {
    const { statements } = buildCreateTable({ table, columns, indexes });
    for (const sql of statements) {
      await this.query(sql);
    }
    return { created: true, table };
  }
  const knex = this.knex;
  if (!knex) throw new Error('createTable for MySQL requires a knex connection');
  await knex.schema.createTable(table, (t) => {
    columns.forEach((c) => {
      const { method, args, nullable, unsigned, default_value, defaultRaw } = this.dialect.standardToKnex(
        c,
        knex.sqlVersion
      );
      const column = t[method].apply(t, [c.name, ...args]);
      if (unsigned) column.unsigned();
      if (nullable) column.nullable();
      else column.notNullable();
      if (defaultRaw !== undefined) column.defaultTo(knex.raw(defaultRaw));
      else if (default_value !== undefined) column.defaultTo(default_value);
    });
    (indexes || []).forEach((x) => {
      const cols = typeof x.columns === 'string' ? x.columns.split(',').map((c) => c.trim()) : x.columns;
      if (x.primary) {
        const autoIncrement = columns.find((c) => c.auto_increment);
        if (!autoIncrement || cols.join(',') !== autoIncrement.name) t.primary(cols);
      } else if (x.unique) t.unique(cols);
      else t.index(cols);
    });
  });
  return { created: true, table };
};

Worker.prototype.alterTable = async function (opts) {
  const { table, columns = [], indexes = [] } = opts;
  await this.connect();
  if (this.dialect === sqliteDialect) {
    const { statements, skipped } = buildAlterTable({ table, columns, indexes });
    for (const sql of statements) {
      await this.query(sql);
    }
    if (skipped.length > 0) debug(`alterTable ${table}: skipped in-place column modifications`, skipped);
    return { altered: true, table, skipped };
  }
  const knex = this.knex;
  if (!knex) throw new Error('alterTable for MySQL requires a knex connection');
  await knex.schema.alterTable(table, (t) => {
    columns.forEach((c) => {
      const { method, args, nullable, unsigned, default_value, defaultRaw } = this.dialect.standardToKnex(
        c,
        knex.sqlVersion
      );
      const column = t[method].apply(t, [c.name, ...args]);
      if (unsigned) column.unsigned();
      if (nullable) column.nullable();
      else column.notNullable();
      if (defaultRaw !== undefined) column.defaultTo(knex.raw(defaultRaw));
      else if (default_value !== undefined) column.defaultTo(default_value);
      if (c.differences !== 'new') column.alter();
    });
    (indexes || []).forEach((x) => {
      const cols = typeof x.columns === 'string' ? x.columns.split(',').map((c) => c.trim()) : x.columns;
      if (x.primary) t.primary(cols);
      else if (x.unique) t.unique(cols);
      else t.index(cols);
    });
  });
  return { altered: true, table };
};

Worker.prototype.createView = async function (options) {
  const table = options.name || options.table;
  let { sql } = options;
  if (!sql) throw new Error('createView requires sql');
  if (bool(options.replace, false)) {
    if (this.dialect?.replaceViewRequiresDrop) {
      await this.query(`drop view if exists ${table}`);
      sql = `CREATE VIEW ${table} AS ${sql}`;
    } else {
      sql = `CREATE OR REPLACE VIEW ${table} AS ${sql}`;
    }
  } else {
    sql = `CREATE VIEW ${table} AS ${sql}`;
  }
  await this.query(sql);
  return { table };
};

/* Insert an array of rows (optionally upserting).  Uses the shared
   buildInsertSql/stringToType logic so SQL output matches the server. */
Worker.prototype.insertArray = async function ({ table, array, upsert = false, batchSize = 300 }) {
  if (!Array.isArray(array)) throw new Error('insertArray requires an array');
  if (array.length === 0) return { table, records: 0 };
  const desc = await this.describe({ table });
  const ignore = ['created_at', 'modified_at'];
  let records = 0;
  for (let i = 0; i < array.length; i += batchSize) {
    const batch = array.slice(i, i + batchSize);
    const columns = desc.columns.filter((f) => {
      if (ignore.indexOf(f.name) >= 0) return false;
      return batch[0][f.name] !== undefined;
    });
    if (columns.length === 0) {
      throw new Error(
        `insertArray to table ${table}: No columns found in object with keys ${Object.keys(batch[0])} matching table columns ${desc.columns.map((d) => d.name).join(',')}`
      );
    }
    const rows = batch.map((o) => {
      const values = columns.map((def) => {
        const v = this.stringToType(o[def.name], def.column_type, def.length, def.nullable, def.default_value);
        return String(this.escapeValue(v)).replace(/\?/g, '\\u003F');
      });
      return `(${values.join(',')})`;
    });
    const sql = this.buildInsertSql({ table: this.escapeTable(table), columns, rows, upsert });
    await this.query({ sql });
    records += batch.length;
  }
  return { table, records };
};

/* Insert a single row and return the auto-increment id (when applicable) */
Worker.prototype.insertOne = async function ({ table, row }) {
  const desc = await this.describe({ table });
  const ignore = ['created_at', 'modified_at'];
  const columns = desc.columns.filter((f) => ignore.indexOf(f.name) < 0 && row[f.name] !== undefined);
  if (columns.length === 0) {
    // e.g. `insert into person (id) values (null)` -- pick the auto-increment column
    const autoCol = desc.columns.find((c) => c.auto_increment);
    if (!autoCol) throw new Error(`insertOne to ${table}: no matching columns and no auto_increment column`);
    const r = await this.query(
      `insert into ${this.escapeTable(table)} (${this.escapeColumn(autoCol.name)}) values (NULL)`
    );
    return { id: r.lastInsertRowid };
  }
  const rows = [
    `(${columns
      .map((def) => {
        const v = this.stringToType(row[def.name], def.column_type, def.length, def.nullable, def.default_value);
        return String(this.escapeValue(v)).replace(/\?/g, '\\u003F');
      })
      .join(',')})`
  ];
  const sql = this.buildInsertSql({ table: this.escapeTable(table), columns, rows, upsert: false });
  const r = await this.query({ sql });
  return { id: r.lastInsertRowid };
};

/* The exact shared upsert logic used by the server */
Worker.prototype.onDuplicate = sqlShared.onDuplicate;
Worker.prototype.onDuplicateFieldValue = sqlShared.onDuplicateFieldValue;
Worker.prototype.buildInsertSql = sqlShared.buildInsertSql;
Worker.prototype.stringToType = sqlShared.stringToType;
Worker.prototype.getSQLName = sqlShared.getSQLName;
Worker.prototype.upsertArray = sqlShared.upsertArray;
Worker.prototype.upsertTables = sqlShared.upsertTables;

export default Worker;
