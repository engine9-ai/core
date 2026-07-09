import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { ObjectError, bool } from '../../utilities.js';

/*
  SQLite dialect for using SQLite as a core (per-account) data store.
  Mirrors the export surface of ./MySQL.js, plus optional capability hooks
  that SQLWorker consults (falling back to MySQL behavior when absent):
    driver, getKnexConfig, parseQueryResults, onDuplicate, onDuplicateFieldValue,
    insertIgnoreModifier, allowedDefaultRaws, getPostCreateStatements,
    introspection.{describe,tableNames,indexes,getTypeQuery,getNativeCreateTable,getCreateView},
    getQueryColumnNames, showProcessList, getEngineStatus,
    getDatabasesSQL, getTruncateSQL, buildDeleteUnmatchedSQL,
    replaceViewRequiresDrop, streamsViaBuffering, isDuplicateKeyError
*/
export const types = [
  {
    type: 'id',
    column_type: 'int',
    nullable: false,
    auto_increment: true,
    // knex emits: integer not null primary key autoincrement
    knex_method: 'bigIncrements'
  },
  {
    type: 'person_id',
    column_type: 'bigint',
    nullable: false,
    default_value: 0,
    knex_method: 'bigint'
  },
  {
    type: 'foreign_id',
    column_type: 'bigint',
    nullable: true,
    knex_method: 'bigint'
  },
  {
    type: 'source_code_id',
    column_type: 'bigint',
    nullable: false,
    default_value: 0,
    knex_method: 'bigint'
  },
  {
    type: 'id_string',
    column_type: 'varchar',
    length: 128,
    nullable: false,
    default_value: '',
    knex_method: 'string',
    knex_args: (o) => [o.length || 255]
  },
  {
    type: 'id_uuid',
    column_type: 'uuid',
    knex_method: 'specificType',
    knex_args: () => ['char(36)'],
    nullable: false
  },
  {
    type: 'string',
    column_type: 'varchar',
    length: 255,
    knex_method: 'string',
    knex_args: (o) => [o.length || 255]
  },
  {
    type: 'hash',
    column_type: 'varchar',
    length: 64,
    nullable: false,
    default_value: '',
    knex_method: 'string',
    knex_args: (o) => [o.length || 64]
  },
  { type: 'int', column_type: 'int', knex_method: 'integer' },
  { type: 'bigint', column_type: 'bigint', knex_method: 'bigint' },
  {
    type: 'currency',
    column_type: 'decimal(19,2)',
    knex_method: 'specificType',
    knex_args: () => ['decimal(19,2)']
  },
  {
    type: 'decimal',
    column_type: 'decimal(19,2)',
    knex_method: 'specificType',
    knex_args: () => ['decimal(19,4)']
  },
  { type: 'float', column_type: 'float', knex_method: 'specificType', knex_args: () => ['float'] },
  { type: 'double', column_type: 'double', knex_method: 'specificType', knex_args: () => ['double'] },
  {
    type: 'boolean',
    column_type: 'boolean',
    knex_method: 'specificType',
    knex_args: () => ['boolean']
  },
  {
    type: 'text',
    column_type: 'text',
    length: 65535,
    knex_method: 'text'
  },
  {
    type: 'json',
    column_type: 'json',
    knex_method: 'specificType',
    knex_args: () => ['json']
  },
  {
    type: 'created_at',
    column_type: 'datetime',
    default_value: 'current_timestamp()',
    nullable: false,
    knex_method: 'timestamp',
    knex_default_raw: 'current_timestamp'
  },
  {
    // SQLite has no ON UPDATE clause; an AFTER UPDATE trigger is created
    // via getPostCreateStatements to keep modified_at current
    type: 'modified_at',
    column_type: 'datetime',
    default_value: 'current_timestamp()',
    nullable: false,
    knex_method: 'timestamp',
    knex_default_raw: 'current_timestamp'
  },
  {
    type: 'url',
    column_type: 'text',
    length: 65535,
    knex_method: 'text'
  },
  { type: 'date', column_type: 'date', knex_method: 'date' },
  { type: 'datetime', column_type: 'datetime', knex_method: 'datetime' },
  { type: 'timestamp', column_type: 'datetime', knex_method: 'timestamp' },
  { type: 'time', column_type: 'time', knex_method: 'time' },
  {
    // SQLite has no native enum -- stored as a plain string
    type: 'enum',
    column_type: 'varchar',
    length: 255,
    knex_method: 'string',
    knex_args: (o) => [o.length || 255]
  },
  {
    type: 'foreign_uuid',
    column_type: 'uuid',
    knex_method: 'specificType',
    knex_args: () => ['char(36)'],
    nullable: true
  },
  {
    type: 'uuid',
    column_type: 'uuid',
    knex_method: 'specificType',
    knex_args: () => ['char(36)']
  }
];
function isInt(s) {
  return Number.isInteger(typeof s === 'number' ? s : parseFloat(s));
}
export const name = 'SQLite';
export const driver = 'better-sqlite3';
export function getType(type) {
  return types.find((t) => t.type === type);
}
// SQLite is always UTF-8 -- charset/collation are intentionally undefined
// so SQLWorker's createTable skips charset specification (info().driver !== 'mysql')
export function getTableCharacterSetSpecification() {
  return '';
}
export function getLastIdConfig() {
  return {
    supportsReturning: true,
    lastInsertIdSQL: 'last_insert_rowid()'
  };
}
function registerCustomFunctions(conn) {
  conn.function('e9_sha256', { deterministic: true, varargs: false }, (text) => {
    const input = text == null ? '' : String(text);
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  });
  conn.function('e9_sha1_hex', { deterministic: true, varargs: false }, (text) => {
    const input = text == null ? '' : String(text);
    return crypto.createHash('sha1').update(input, 'utf8').digest('hex').toUpperCase();
  });
}
export function getConnectionFilename(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.indexOf('sqlite://') !== 0) {
    throw new Error(`Invalid SQLite connection string, expected sqlite://<file path>: ${connectionString}`);
  }
  const filename = connectionString.slice('sqlite://'.length).split('?')[0];
  if (!filename) throw new Error('SQLite connection string requires a file path or :memory:');
  return filename;
}
export function getKnexConfig(connectionString) {
  const filename = getConnectionFilename(connectionString);
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  return {
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1, // SQLite is single-writer
      afterCreate(conn, done) {
        registerCustomFunctions(conn);
        conn.pragma('journal_mode = WAL');
        conn.pragma('busy_timeout = 10000');
        done();
      }
    }
  };
}
export async function getSqlVersion(knex) {
  const rows = await knex.raw('select sqlite_version() as sqlVersion');
  return `sqlite-${rows?.[0]?.sqlVersion || ''}`;
}
/* better-sqlite3 returns an array of rows for selects,
   and a { changes, lastInsertRowid } object for run-type statements */
export function parseQueryResults({ results }) {
  if (Array.isArray(results)) {
    return {
      data: results,
      records: results.length,
      modified: 0
    };
  }
  return {
    data: [],
    records: results?.changes,
    modified: results?.changes,
    columns: []
  };
}
export function onDuplicate() {
  return 'on conflict do update set';
}
export function onDuplicateFieldValue(f) {
  return `excluded.${f}`;
}
export const insertIgnoreModifier = 'OR IGNORE';
export const allowedDefaultRaws = ['current_timestamp'];
export const replaceViewRequiresDrop = true;
// knex streaming is unreliable with better-sqlite3; SQLWorker buffers instead
export const streamsViaBuffering = true;
export function isDuplicateKeyError(err) {
  return (
    (typeof err?.code === 'string' && err.code.indexOf('SQLITE_CONSTRAINT') === 0) ||
    (typeof err?.message === 'string' &&
      (err.message.includes('UNIQUE constraint failed') || err.message.includes('PRIMARY KEY constraint failed')))
  );
}
/* AFTER UPDATE triggers to emulate MySQL's ON UPDATE CURRENT_TIMESTAMP */
export function getPostCreateStatements({ table, columns = [] }) {
  // quote so reserved words (e.g. "transaction") work as table names
  const quoted = `"${table}"`;
  return columns
    .filter((c) => c.type === 'modified_at')
    .map(
      (c) => `create trigger if not exists "${table}_${c.name}_auto_update"
after update on ${quoted}
for each row
when NEW.${c.name} is OLD.${c.name}
begin
  update ${quoted} set ${c.name} = CURRENT_TIMESTAMP where rowid = NEW.rowid;
end`
    );
}
export function getDatabasesSQL() {
  return 'PRAGMA database_list';
}
export function getTruncateSQL(table) {
  return `delete from ${table}`;
}
export function buildDeleteUnmatchedSQL({ target, source, columns }) {
  const predicate = columns.map((c) => `s.${c}=${target}.${c}`).join(' and ');
  return `delete from ${target}
where not exists (
  select 1
  from ${source} s
  where ${predicate}
)`;
}
function parseDefaultValue(dflt, columnType) {
  if (dflt === null || dflt === undefined) return undefined;
  let v = String(dflt);
  if (v.toUpperCase() === 'NULL') return null;
  if (v.toLowerCase().indexOf('current_timestamp') === 0) return 'current_timestamp()';
  // knex quotes most sqlite defaults (including numbers), so unquote before coercing
  if (v.match(/^'.*'$/)) v = v.slice(1, -1).replace(/''/g, "'");
  const type = (columnType || '').toLowerCase();
  if (type === 'boolean') return v === '1' || v.toLowerCase() === 'true';
  if (type.indexOf('int') >= 0) return parseInt(v, 10);
  if (type.indexOf('decimal') === 0 || type.indexOf('float') === 0 || type.indexOf('double') === 0)
    return parseFloat(v);
  return v;
}
export const introspection = {
  async describe(worker, opts) {
    const { table, raw } = opts;
    if (!table) throw new Error(`No table provided to describe with opts ${Object.keys(opts)}`);
    if (table === 'dual') return { database: 'dual', columns: [] };
    // quote so reserved words (e.g. "transaction") work as table names
    const escaped = `"${worker.escapeTable(table)}"`;
    const r = await worker.query({ sql: `PRAGMA table_info(${escaped})`, logQueries: false });
    if (!r.data || r.data.length === 0) {
      throw new ObjectError({ message: `Could not find table ${table}`, code: 'DOES_NOT_EXIST' });
    }
    const results = { table, database: worker.auth?.database_connection || 'sqlite' };
    results.columns = r.data.map((d) => {
      const declared = (d.type || 'text').toLowerCase();
      const lengthMatch = declared.match(/\((\d+)\)/);
      const columnType = declared.split('(')[0].trim();
      const normalized = declared.indexOf('char(36)') >= 0 ? 'uuid' : columnType;
      const o = {
        name: d.name,
        column_type: normalized === 'uuid' ? 'uuid' : declared,
        length: lengthMatch && normalized !== 'uuid' ? parseInt(lengthMatch[1], 10) : null,
        nullable: !d.notnull,
        default_value: parseDefaultValue(d.dflt_value, declared),
        // rowid-alias INTEGER primary keys auto-assign ids
        auto_increment: d.pk === 1 && (columnType === 'integer' || columnType === 'int')
      };
      if (bool(raw)) return o;
      return dialectToStandard(o, {});
    });
    return results;
  },
  async tableNames(worker, options = {}) {
    if (options.database) throw new Error('Cannot specify database for a SQLite connection');
    let sql = "select name from sqlite_master where name not like 'sqlite_%'";
    if (options.type === 'view') {
      sql += " and type='view'";
    } else if (options.type === 'table') {
      sql += " and type='table'";
    } else {
      sql += " and type in ('table','view')";
    }
    const { data } = await worker.query({ sql, logQueries: false });
    return data.map((t) => t.name);
  },
  async indexes(worker, { table, unique, primary }) {
    const escaped = `"${worker.escapeTable(table)}"`;
    const { data: list } = await worker.query({ sql: `PRAGMA index_list(${escaped})`, logQueries: false });
    const out = [];
    for (const idx of list) {
      // knex-generated index names can include dashes (UUIDs) -- quote them
      const quotedIndexName = `"${String(idx.name).replace(/"/g, '""')}"`;
      const { data: info } = await worker.query({
        sql: `PRAGMA index_info(${quotedIndexName})`,
        logQueries: false
      });
      const columns = info.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
      const isPrimary = idx.origin === 'pk';
      out.push({
        index_name: isPrimary ? 'PRIMARY' : idx.name,
        columns,
        primary: isPrimary,
        unique: !!idx.unique
      });
    }
    // INTEGER PRIMARY KEY (rowid alias) columns don't appear in index_list
    if (!out.find((i) => i.primary)) {
      const { data: cols } = await worker.query({ sql: `PRAGMA table_info(${escaped})`, logQueries: false });
      const pkCols = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      if (pkCols.length > 0) {
        out.unshift({
          index_name: 'PRIMARY',
          columns: pkCols,
          primary: true,
          unique: true
        });
      }
    }
    let filtered = out;
    if (bool(unique, false)) filtered = filtered.filter((i) => i.unique);
    if (bool(primary, false)) filtered = filtered.filter((i) => i.primary);
    return filtered;
  },
  getTypeQuery(worker, table) {
    return `select upper(type) as type from sqlite_master where name = ${worker.escapeValue(table)}`;
  },
  async getNativeCreateTable(worker, options) {
    const { data } = await worker.query({
      sql: `select sql from sqlite_master where name = ${worker.escapeValue(options.table)}`,
      logQueries: false
    });
    if (!data[0]) throw new Error(`Could not find table ${options.table}`);
    return { sql: data[0].sql };
  },
  async getCreateView(worker, options) {
    const { data } = await worker.query({
      sql: `select sql from sqlite_master where type='view' and name = ${worker.escapeValue(options.table)}`,
      logQueries: false
    });
    if (!data[0]?.sql) throw new Error(`Could not find view ${options.table}`);
    return { sql: data[0].sql };
  }
};
export async function getQueryColumnNames(worker, sql) {
  const { data } = await worker.query({ sql: `${sql} limit 1`, logQueries: false });
  if (data?.[0]) return Object.keys(data[0]);
  return [];
}
export async function showProcessList() {
  return [];
}
export async function getEngineStatus(worker) {
  const journal = await worker.query({ sql: 'pragma journal_mode', logQueries: false });
  const busy = await worker.query({ sql: 'pragma busy_timeout', logQueries: false });
  const journalRow = journal.data?.[0] || {};
  const busyRow = busy.data?.[0] || {};
  return [
    {
      Type: 'SQLite',
      Name: 'journal_mode',
      Status: journalRow.journal_mode || Object.values(journalRow)[0] || ''
    },
    {
      Type: 'SQLite',
      Name: 'busy_timeout',
      Status: String(busyRow.busy_timeout ?? Object.values(busyRow)[0] ?? '')
    }
  ];
}
export function standardToKnex(col) {
  let { type } = col;
  if (type === 'string' && col.max_length > 255) type = 'text';
  const typeDef = types.find((t) => t.type === type);
  if (!typeDef) throw new Error(`Could not find sqlite type ${type}`);
  let { nullable } = col;
  if (nullable === undefined) nullable = typeDef.nullable;
  if (nullable === undefined) nullable = true;
  return {
    method: typeDef.knex_method,
    args: typeof typeDef.knex_args === 'function' ? typeDef.knex_args(col) : typeDef.knex_args || [],
    unsigned: false, // SQLite has no unsigned modifier
    nullable,
    default_value: col.default_value !== undefined ? col.default_value : typeDef.knex_default,
    defaultRaw: typeDef.knex_default_raw
  };
}
export function dialectToStandard(o, defaultColumn) {
  const { name, type, decimals, length, column_type, default_value, nullable, auto_increment, extra, constraints } = o;
  const input = {
    name,
    type,
    decimals,
    length,
    column_type,
    default_value,
    nullable,
    auto_increment,
    extra,
    constraints,
    ...defaultColumn
  };
  delete input.extra;
  delete input.constraints;
  if (!input.column_type) input.column_type = 'text';
  input.column_type = String(input.column_type).toLowerCase();
  // Normalize SQLite declared types to the standard set
  if (input.column_type === 'char(36)') {
    input.column_type = 'uuid';
    input.length = null;
  }
  if (input.column_type === 'json') {
    input.type = 'json';
  }
  if (
    input.column_type.indexOf('varchar') === 0 ||
    input.column_type === 'char' ||
    input.column_type === 'character' ||
    input.column_type === 'clob' ||
    input.column_type === 'text' ||
    input.column_type === 'mediumtext' ||
    input.column_type === 'longtext'
  ) {
    input.type = 'string';
    input.column_type = input.column_type.split('(')[0];
    if (input.column_type !== 'varchar' && input.column_type !== 'char' && input.length == null) {
      // text-style columns have no declared length in SQLite
      input.length = 65535;
    }
    if (input.default_value && typeof input.default_value === 'string' && input.default_value.match(/^'.*'$/)) {
      input.default_value = input.default_value.slice(1, -1);
    }
    return { ...input, ...types.find((t) => t.type === 'string'), ...input };
  }
  if (input.column_type === 'bigint') {
    input.column_type = 'bigint';
  } else if (input.column_type.indexOf('int') >= 0) {
    // integer, int, smallint, tinyint, mediumint
    if (input.column_type === 'tinyint(1)' || input.column_type === 'tinyint') {
      input.column_type = 'boolean';
    } else {
      input.column_type = 'int';
    }
  }
  if (input.column_type === 'bool' || input.column_type === 'boolean') {
    input.column_type = 'boolean';
  }
  if (input.column_type.indexOf('decimal') === 0 || input.column_type.indexOf('numeric') === 0) {
    input.column_type = 'decimal(19,2)';
  }
  if (input.column_type.indexOf('float') === 0 || input.column_type === 'real') {
    input.column_type = 'float';
  }
  if (input.column_type === 'timestamp') {
    input.column_type = 'datetime';
  }
  const log = [];
  const typeDef = types.find((t) => {
    const unmatchedAttributes = Object.keys(t)
      .map((attr) => {
        if (attr === 'type' || attr.indexOf('knex_') === 0) return false;
        if (t[attr] === input[attr]) return false;
        return `${attr}:${t[attr]} !== ${input[attr]}`;
      })
      .filter(Boolean);
    if (unmatchedAttributes.length > 0) {
      log.push({ type: t.type, unmatchedAttributes });
      return false;
    }
    return true;
  });
  if (!typeDef) {
    throw new Error(
      `dialectToStandard: Could not find column type that matches ${JSON.stringify(input.column_type)} \n${log
        .map((s) => JSON.stringify(s))
        .join('\n')}`
    );
  }
  return Object.assign(input, typeDef);
}
const columnNameMatch = /^[a-zA-Z0-9_]+$/;
export function escapeColumn(value) {
  if (!String(value).match(columnNameMatch)) throw new Error(`Invalid column name: ${value}`);
  return `\`${value}\``;
}
export function escapeValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL';
    return `'${value.toISOString().slice(0, -1)}'`;
  }
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  // SQLite string literals only escape by doubling single quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}
export function addLimit(_sql, limit, offset) {
  if (!limit) return _sql;
  let sql = _sql;
  if (isInt(limit)) {
    sql += ` limit ${limit}`;
    if (offset) sql += ` offset ${offset}`;
  } else if (limit) {
    throw new Error(`Invalid limit:${limit}`);
  }
  return sql;
}
function parseFiscalYearStart(fiscalYear) {
  const [month, day] = String(fiscalYear)
    .split('-')
    .map((n) => parseInt(n, 10));
  if (!month || !day) throw new Error(`Invalid fiscal year start:${fiscalYear}, expected MM-DD`);
  return { month, day };
}
function normalizeIntervalUnit(unit) {
  const u = String(unit || 'day')
    .toLowerCase()
    .replace(/s$/, '');
  const allowed = ['second', 'minute', 'hour', 'day', 'month', 'year'];
  if (allowed.indexOf(u) < 0) throw new Error(`Invalid interval unit for SQLite:${unit}`);
  return `${u}s`;
}
const moduleExports = {
  name,
  driver,
  types,
  getType,
  getTableCharacterSetSpecification,
  getLastIdConfig,
  getConnectionFilename,
  getKnexConfig,
  getSqlVersion,
  parseQueryResults,
  onDuplicate,
  onDuplicateFieldValue,
  insertIgnoreModifier,
  allowedDefaultRaws,
  replaceViewRequiresDrop,
  streamsViaBuffering,
  isDuplicateKeyError,
  getPostCreateStatements,
  getDatabasesSQL,
  getTruncateSQL,
  buildDeleteUnmatchedSQL,
  introspection,
  standardToKnex,
  dialectToStandard,
  escapeColumn,
  escapeValue,
  addLimit,
  supportedFunctions() {
    const scope = this;
    function escapeColumnLocal(t) {
      if (!t.match(columnNameMatch)) throw new Error(`Invalid column name: ${t}`);
      return t;
    }
    this.getDayFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATE(${column})`;
    };
    this.getQuarterFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `(strftime('%Y',${column}) || '-Q' || ((CAST(strftime('%m',${column}) AS INTEGER)+2)/3))`;
    };
    this.getStartOfQuarterFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATE(${column},'start of month','-' || ((CAST(strftime('%m',${column}) AS INTEGER)-1)%3) || ' months')`;
    };
    this.getDateIntervalFunction = function (column, days) {
      return `DATETIME(${this.escapeColumn(column)}, '${days >= 0 ? '+' : ''}${days} days')`;
    };
    this.getHourIntervalFunction = function (column, hours) {
      return `DATETIME(${this.escapeColumn(column)}, '${hours >= 0 ? '+' : ''}${hours} hours')`;
    };
    this.getShortDateFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `strftime('%Y%m%d',${column})`;
    };
    this.getWeekFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      // start of week (Sunday)
      return `DATE(${column}, '-' || CAST(strftime('%w',${column}) AS INTEGER) || ' days')`;
    };
    this.getMonthNameFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      const names = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December'
      ];
      const cases = names.map((n, i) => `WHEN '${String(i + 1).padStart(2, '0')}' THEN '${n}'`).join(' ');
      return `CASE strftime('%m',${column}) ${cases} END`;
    };
    /* SQLite has no timezone database; values are returned unconverted (UTC).
       See dialect notes -- CONVERT_TZ is a no-op passthrough on SQLite. */
    this.getTimezoneFunction = function (_column, timezone, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATETIME(${column})`;
    };
    this.getMonthFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATE(${column},'start of month')`;
    };
    this.getStartOfYearFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `(strftime('%Y',${column}) || '-01-01')`;
    };
    this.getYearFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `CAST(strftime('%Y',${column}) AS INTEGER)`;
    };
    this.getFiscalYearFunction = function (_column, fiscalYear, skipEscape) {
      let column = _column;
      if (!fiscalYear) return scope.getYearFunction(column, skipEscape);
      const { month, day } = parseFiscalYearStart(fiscalYear);
      if (month === 1 && day === 1) return this.getYearFunction(column, skipEscape);
      if (!skipEscape) column = escapeColumnLocal(column);
      return `CAST(strftime('%Y', DATETIME(${column}, '+${13 - month} months', '-${day - 1} days')) AS INTEGER)`;
    };
    this.getDayOfYearFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = escapeColumnLocal(column);
      return `CAST(strftime('%j',${column}) AS INTEGER)`;
    };
    this.getDayOfFiscalYearFunction = function (_column, fiscalYear, skipEscape) {
      let column = _column;
      if (!fiscalYear) return scope.getYearFunction(column, skipEscape);
      const { month, day } = parseFiscalYearStart(fiscalYear);
      if (month === 1 && day === 1) return this.getDayOfYearFunction(column, skipEscape);
      if (!skipEscape) column = escapeColumnLocal(column);
      return this.getDayDiffFunction(
        column,
        `((${this.getFiscalYearFunction(column, fiscalYear, true)}) - 1) || '-${fiscalYear}'`
      );
    };
    this.getNowFunction = function () {
      return "DATETIME('now')";
    };
    this.getDayDiffFunction = function (a, b) {
      return `CAST(julianday(DATE(${a})) - julianday(DATE(${b})) AS INTEGER)`;
    };
    this.getDateFunction = function (x) {
      return `DATE(${x})`;
    };
    this.getHashV1Function = function (x) {
      return `e9_sha256(lower(trim(coalesce(${x},''))))`;
    };
    this.getEmailDomainFunction = function (x) {
      return `COALESCE(LOWER(SUBSTR(${x}, INSTR(${x},'@') + 1)),'')`;
    };
    this.getDateSubFunction = function (date, value, type) {
      return `DATETIME(${date}, '-' || (${value}) || ' ${normalizeIntervalUnit(type)}')`;
    };
    this.getDateArithmeticFunction = function (date, operator, value, intervalType) {
      const sign = operator === '-' ? '-' : '+';
      return `DATETIME(${date}, '${sign}' || (${value}) || ' ${normalizeIntervalUnit(intervalType)}')`;
    };
    this.getStringIndexOfFunction = function (str, find, pos) {
      if (pos != null) throw new Error('LOCATE with a position argument is not supported by the SQLite dialect');
      // MySQL LOCATE(substr, str) === SQLite INSTR(str, substr)
      return `INSTR(${find},${str})`;
    };
    this.getFullTextBoolean = function () {
      throw new Error('FULLTEXT_BOOLEAN is not supported by the SQLite dialect (requires FTS5 virtual tables)');
    };
    this.getUUIDFunction = function () {
      return (
        "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
        "substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || " +
        "substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))"
      );
    };
    this.getIfNullFunction = function (check, value) {
      return `IFNULL(${check}, ${value})`;
    };
    this.getCastIntFunction = function (value) {
      return `CAST(${value} AS INTEGER)`;
    };
    this.getLengthFunction = function (value) {
      return `LENGTH(${value})`;
    };
    this.getTrimFunction = function (value) {
      return `TRIM(${value})`;
    };
    this.getConcatFunction = function (...rest) {
      let value = rest;
      if (value.length === 1 && Array.isArray(value[0])) [value] = value;
      return `(${value.join(' || ')})`;
    };
    this.getShaLength40Function = function (_value) {
      let value = _value;
      if (Array.isArray(value)) {
        value = this.getConcatFunction(value);
      }
      return `e9_sha1_hex(${value})`;
    };
    this.getRegexpFunction = function () {
      throw new Error('REGEXP is not supported by the SQLite dialect');
    };
    const functions = {
      DISTINCT: 1,
      COUNT: 1,
      SUM: 1,
      AVG: 1,
      MIN: 1,
      MAX: 1,
      NONE: (x) => x,
      DAY: (x) => this.getDayFunction(x, true),
      WEEK: (x) => this.getWeekFunction(x, true),
      MONTH: (x) => this.getMonthFunction(x, true),
      YEAR: (x) => this.getYearFunction(x, true),
      CONVERT_TZ: ([field, tz]) => this.getTimezoneFunction(field, tz),
      FISCAL_YEAR: (x) => this.getFiscalYearFunction(x, this.fiscalYear || '01-01', true),
      DAY_OF_YEAR: (x) => this.getDayOfYearFunction(x, true),
      DAY_OF_FISCAL_YEAR: (x) => this.getDayOfFiscalYearFunction(x, this.fiscalYear || '01-01', true),
      NOW: () => this.getNowFunction(),
      DATE: (x) => this.getDateFunction(x),
      LOCATE: ([x, y, z]) => this.getStringIndexOfFunction(x, y, z),
      FULLTEXT_BOOLEAN: ([x, y]) => this.getFullTextBoolean(x, y),
      REGEXP_LIKE: ([x, y]) => this.getRegexpFunction(x, y),
      NULLIF: 1,
      IFNULL: 1
    };
    return functions;
  }
};
export default moduleExports;
export const supportedFunctions = moduleExports.supportedFunctions;
