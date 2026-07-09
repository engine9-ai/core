/*
  Native SQLite DDL generation from Engine9 standardized schema definitions.

  The server generates DDL through knex.schema, which requires a live driver
  (better-sqlite3/mysql2).  Cloudflare D1 exposes no knex driver, so the client
  builds SQLite DDL statements directly from the same standardized column
  definitions the dialects produce.  Output is plain SQL usable with D1,
  better-sqlite3, or wrangler migration files.
*/
import sqliteDialect from './dialects/SQLite.js';

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
  return `${unique ? 'uidx' : 'idx'}_${table}_${columns.join('_')}`.slice(0, 60);
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

/* Additive alters only: new columns and new indexes.  SQLite cannot modify
   existing column definitions in place; those differences are reported, not applied. */
export function buildAlterTable({ table, columns = [], indexes = [] }) {
  const quotedTable = `"${table}"`;
  const statements = [];
  const skipped = [];
  columns.forEach((col) => {
    if (col.differences && col.differences !== 'new') {
      skipped.push({ column: col.name, differences: col.differences });
      return;
    }
    const typeDef = sqliteDialect.getType(col.type) || {};
    const merged = { ...typeDef, ...col };
    let def = `"${col.name}" ${columnTypeSQL(col)}`;
    let { nullable } = merged;
    if (nullable === undefined) nullable = true;
    const d = defaultSQL(merged.default_value);
    // SQLite requires NOT NULL added columns to carry a default
    if (!nullable && d !== null) def += ` not null default ${d}`;
    else if (d !== null) def += ` default ${d}`;
    statements.push(`alter table ${quotedTable} add column ${def}`);
  });
  (indexes || []).forEach((x) => {
    const cols = typeof x.columns === 'string' ? x.columns.split(',').map((c) => c.trim()) : x.columns;
    const unique = x.unique || x.primary || false;
    statements.push(
      `create ${unique ? 'unique ' : ''}index if not exists "${indexName(table, cols, unique)}" on ${quotedTable} (${cols.map((c) => `"${c}"`).join(',')})`
    );
  });
  return { statements, skipped };
}

export default { buildCreateTable, buildAlterTable };
