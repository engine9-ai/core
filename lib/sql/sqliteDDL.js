/*
  Native SQLite DDL generation from Engine9 standardized schema definitions.

  The server generates DDL through knex.schema, which requires a live driver
  (better-sqlite3/mysql2).  Cloudflare D1 exposes no knex driver, so the client
  builds SQLite DDL statements directly from the same standardized column
  definitions the dialects produce.  Output is plain SQL for better-sqlite3
  or `wrangler d1 execute --file`.  Do not apply it with
  `wrangler d1 migrations apply`: the modified_at triggers below fail on
  D1 /query once that command appends its d1_migrations insert.
*/
import sqliteDialect from './dialects/SQLite.js';
import { sqlIndexName } from './sqlIndexName.js';

const columnTypeSQL = (col) => sqliteDialect.declaredColumnType(col);

function defaultSQL(value) {
  if (value === undefined) return null;
  if (value === null) return 'NULL';
  if (typeof value === 'string' && value.toLowerCase().indexOf('current_timestamp') === 0) {
    return 'CURRENT_TIMESTAMP';
  }
  return sqliteDialect.escapeValue(value);
}

function indexName(table, columns, unique) {
  return sqlIndexName(table, columns, { unique });
}

/*
  Accepts standardized tables: { name, columns: [standardized column objects], indexes }
  Returns { statements: [...create table/index/trigger sql] }
*/
export function buildCreateTable({ table, columns = [], indexes = [] }) {
  if (!table) throw new Error('table is required');
  if (!columns.length) throw new Error(`columns are required to create table ${table}`);
  const quotedTable = `"${table}"`;
  const defs = [];
  let hasRowIdAlias = false;
  columns.forEach((col) => {
    const typeDef = sqliteDialect.getType(col.type) || {};
    const merged = { ...typeDef, ...col };
    let def = `"${col.name}" ${columnTypeSQL(col)}`;
    if (merged.auto_increment) {
      // SQLite rowid alias, matching knex bigIncrements output
      def = `"${col.name}" integer not null primary key autoincrement`;
      hasRowIdAlias = true;
      defs.push(def);
      return;
    }
    let { nullable } = merged;
    if (nullable === undefined) nullable = true;
    if (!nullable) def += ' not null';
    const d = defaultSQL(merged.default_value);
    if (d !== null) def += ` default ${d}`;
    defs.push(def);
  });
  const normalizedIndexes = (indexes || []).map((x) => ({
    columns: typeof x.columns === 'string' ? x.columns.split(',').map((c) => c.trim()) : x.columns,
    primary: x.primary || false,
    unique: x.unique || x.primary || false
  }));
  const primary = normalizedIndexes.find((x) => x.primary);
  if (primary && !hasRowIdAlias) {
    defs.push(`primary key (${primary.columns.map((c) => `"${c}"`).join(',')})`);
  }
  const statements = [`create table if not exists ${quotedTable} (\n  ${defs.join(',\n  ')}\n)`];
  normalizedIndexes
    .filter((x) => !x.primary)
    .forEach((x) => {
      statements.push(
        `create ${x.unique ? 'unique ' : ''}index if not exists "${indexName(table, x.columns, x.unique)}" on ${quotedTable} (${x.columns.map((c) => `"${c}"`).join(',')})`
      );
    });
  const triggers = sqliteDialect.getPostCreateStatements({ table, columns });
  statements.push(...triggers);
  return { statements };
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/*
  D1 and older SQLite reject:
    ALTER TABLE ... ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP
  with "Cannot add a column with non-constant default".
  CREATE TABLE still accepts that default, so those columns are added by
  rebuilding the table.
*/
export function isNonConstantDefault(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return (
    s.startsWith('current_timestamp') ||
    s.startsWith('datetime(') ||
    s.startsWith('date(') ||
    s.startsWith('time(') ||
    s.startsWith('julianday(') ||
    s.startsWith('strftime(')
  );
}

function addedColumnSQL(col) {
  const typeDef = sqliteDialect.getType(col.type) || {};
  const merged = { ...typeDef, ...col };
  let def = `${quoteIdent(col.name)} ${columnTypeSQL(col)}`;
  let { nullable } = merged;
  if (nullable === undefined) nullable = true;
  const d = defaultSQL(merged.default_value);
  if (!nullable && d !== null) def += ` not null default ${d}`;
  else if (!nullable) def += ' not null';
  else if (d !== null) def += ` default ${d}`;
  return def;
}

function indexStatements(table, indexes) {
  const quotedTable = quoteIdent(table);
  return (indexes || []).map((x) => {
    const cols = typeof x.columns === 'string' ? x.columns.split(',').map((c) => c.trim()) : x.columns;
    const unique = x.unique || x.primary || false;
    return `create ${unique ? 'unique ' : ''}index if not exists "${indexName(table, cols, unique)}" on ${quotedTable} (${cols.map((c) => quoteIdent(c)).join(',')})`;
  });
}

/* Additive alters only: new columns and new indexes.  SQLite cannot modify
   existing column definitions in place; those differences are reported, not applied.
   The exception is a modified_at default: its ON UPDATE part is the
   auto-update trigger, which can be created on the existing table.
   A new column whose default is non-constant (CURRENT_TIMESTAMP) sets rebuild:
   D1 cannot ADD that column. SQLWorker rebuilds the table instead. */
export function buildAlterTable({ table, columns = [], indexes = [] }) {
  const statements = [];
  const skipped = [];
  const constantColumns = [];
  const rebuildColumns = [];
  const triggers = [];
  columns.forEach((col) => {
    if (col.differences && col.differences !== 'new') {
      const { default_value: defaultDiff, ...rest } = col.differences;
      if (defaultDiff && col.type === 'modified_at') triggers.push(...sqliteDialect.getPostCreateStatements({ table, columns: [col] }));
      const other = defaultDiff && col.type === 'modified_at' ? rest : col.differences;
      if (Object.keys(other).length) skipped.push({ column: col.name, differences: other });
      return;
    }
    const typeDef = sqliteDialect.getType(col.type) || {};
    const merged = { ...typeDef, ...col };
    const d = defaultSQL(merged.default_value);
    if (isNonConstantDefault(d) || isNonConstantDefault(merged.default_value)) rebuildColumns.push(col);
    else constantColumns.push(col);
  });
  if (rebuildColumns.length > 0) {
    return {
      statements: [...indexStatements(table, indexes), ...triggers],
      skipped,
      rebuild: true,
      rebuildColumns: constantColumns.concat(rebuildColumns)
    };
  }
  const quotedTable = quoteIdent(table);
  constantColumns.forEach((col) => {
    statements.push(`alter table ${quotedTable} add column ${addedColumnSQL(col)}`);
  });
  statements.push(...indexStatements(table, indexes), ...triggers);
  return { statements, skipped, rebuild: false, rebuildColumns: [] };
}

/*
  Rebuild `table` so new columns can use CURRENT_TIMESTAMP.
  existingColumns are PRAGMA table_info rows (name, type, notnull, dflt_value, pk).
  indexSql and triggerSql are the sqlite_master statements captured before the drop.
*/
export function buildTableRebuild({
  table,
  existingColumns = [],
  newColumns = [],
  indexSql = [],
  triggerSql = [],
  autoincrement = false
}) {
  if (!table) throw new Error('table is required');
  if (!existingColumns.length) throw new Error(`cannot rebuild ${table}: no existing columns`);
  const temp = `${table}__e9new`;
  const pkColumns = existingColumns.filter((col) => Number(col.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
  const integerKey = pkColumns.length === 1 && /^int/i.test(pkColumns[0].type || '');
  const defs = existingColumns.map((col) => {
    if (integerKey && Number(col.pk) === 1) {
      return `${quoteIdent(col.name)} integer not null primary key${autoincrement ? ' autoincrement' : ''}`;
    }
    let def = `${quoteIdent(col.name)} ${col.type || 'text'}`;
    if (col.notnull) def += ' not null';
    if (col.dflt_value != null && col.dflt_value !== '') def += ` default ${col.dflt_value}`;
    return def;
  });
  newColumns.forEach((col) => defs.push(addedColumnSQL(col)));
  if (pkColumns.length && !integerKey) {
    defs.push(`primary key (${pkColumns.map((col) => quoteIdent(col.name)).join(',')})`);
  }
  const oldList = existingColumns.map((col) => quoteIdent(col.name)).join(', ');
  const statements = [
    `drop table if exists ${quoteIdent(temp)}`,
    `create table ${quoteIdent(temp)} (\n  ${defs.join(',\n  ')}\n)`,
    `insert into ${quoteIdent(temp)} (${oldList}) select ${oldList} from ${quoteIdent(table)}`,
    `drop table ${quoteIdent(table)}`,
    `alter table ${quoteIdent(temp)} rename to ${quoteIdent(table)}`,
    ...indexSql.filter(Boolean),
    ...triggerSql.filter(Boolean),
    ...sqliteDialect.getPostCreateStatements({ table, columns: newColumns })
  ];
  return statements;
}

/*
  buildTableRebuild for a table in the database: its columns, indexes, and
  triggers are read first. types: { column: declared type } restates
  existing columns.
*/
export async function liveTableRebuild(worker, table, newColumns = [], { types = {} } = {}) {
  const escaped = worker.escapeTable(table).replace(/'/g, "''");
  const info = await worker.query({ sql: `PRAGMA table_info("${escaped}")`, logQueries: false });
  const existingColumns = (info.data || []).map((col) => (types[col.name] ? { ...col, type: types[col.name] } : col));
  if (!existingColumns.length) {
    throw new Error(`Cannot rebuild ${table}: the table has no columns`);
  }
  const master = await worker.query({
    sql: `select type, sql from sqlite_master where tbl_name='${escaped}' and sql is not null`,
    logQueries: false
  });
  const rows = master.data || [];
  const createSql = rows.find((row) => row.type === 'table')?.sql || '';
  return buildTableRebuild({
    table,
    existingColumns,
    newColumns,
    indexSql: rows.filter((row) => row.type === 'index').map((row) => row.sql),
    triggerSql: rows.filter((row) => row.type === 'trigger').map((row) => row.sql),
    autoincrement: /autoincrement/i.test(createSql)
  });
}

/* buildAlterTable for a table in the database, with the rebuild it needs written out. */
export async function alterTablePlan(worker, { table, columns = [], indexes = [] }) {
  const plan = buildAlterTable({ table, columns, indexes });
  if (!plan.rebuild) return { statements: plan.statements, skipped: plan.skipped, rebuilt: false };
  return {
    statements: [...(await liveTableRebuild(worker, table, plan.rebuildColumns)), ...plan.statements],
    skipped: plan.skipped,
    rebuilt: true,
    failureHint: 'D1 rejects ALTER TABLE ADD COLUMN when the default is CURRENT_TIMESTAMP, so the table has to be rebuilt.'
  };
}

/* SQLite cannot change a column's type in place: rebuild with the columns restated. */
export function changeColumnTypeStatements(worker, { table, types }) {
  return liveTableRebuild(worker, table, [], { types });
}

export default { buildCreateTable, buildAlterTable, buildTableRebuild };
