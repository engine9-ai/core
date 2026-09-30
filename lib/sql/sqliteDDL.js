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

function columnTypeSQL(col) {
  const typeDef = sqliteDialect.getType(col.type) || {};
  const merged = { ...typeDef, ...col };
  let columnType = merged.column_type || 'text';
  if (columnType === 'uuid') return 'char(36)';
  if (columnType === 'varchar') return `varchar(${merged.length || 255})`;
  if (columnType === 'int') return 'integer';
  return columnType;
}

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

function quoteIdent(name) {
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
   A new column whose default is non-constant (CURRENT_TIMESTAMP) sets rebuild:
   D1 cannot ADD that column. SQLWorker rebuilds the table instead. */
export function buildAlterTable({ table, columns = [], indexes = [] }) {
  const statements = [];
  const skipped = [];
  const constantColumns = [];
  const rebuildColumns = [];
  columns.forEach((col) => {
    if (col.differences && col.differences !== 'new') {
      skipped.push({ column: col.name, differences: col.differences });
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
      statements: indexStatements(table, indexes),
      skipped,
      rebuild: true,
      rebuildColumns: constantColumns.concat(rebuildColumns)
    };
  }
  const quotedTable = quoteIdent(table);
  constantColumns.forEach((col) => {
    statements.push(`alter table ${quotedTable} add column ${addedColumnSQL(col)}`);
  });
  statements.push(...indexStatements(table, indexes));
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
  const defs = existingColumns.map((col) => {
    if (pkColumns.length === 1 && Number(col.pk) === 1 && /^int/i.test(col.type || '')) {
      return `${quoteIdent(col.name)} integer not null primary key${autoincrement ? ' autoincrement' : ''}`;
    }
    let def = `${quoteIdent(col.name)} ${col.type || 'text'}`;
    if (col.notnull) def += ' not null';
    if (col.dflt_value != null && col.dflt_value !== '') def += ` default ${col.dflt_value}`;
    return def;
  });
  newColumns.forEach((col) => defs.push(addedColumnSQL(col)));
  if (pkColumns.length > 1) {
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

export default { buildCreateTable, buildAlterTable, buildTableRebuild };
