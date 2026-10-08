/*
  Rewrite stored plugin paths to their current spelling:

    `@engine9/interfaces/...` → `@engine9/schemas/...` (package renamed in 1.9)
    `local$<path>`            → `<path>`             (old local-load prefix)

  Core matches plugin paths exactly, so rows that still use either old spelling
  are not found until this runs. Columns that store a path:

    plugin.path, plugin_history.path   plugin identity
    segment.definition_path            `<plugin>:segments:<key>`
    segment.search                     search-tree clause paths (JSON)
    setting.value                      e.g. default_stack
    plugin.schema                      JSON, normally path-free

  IDs are not touched: schema plugin rows are not path-derived, and segment ids
  come from plugin_id + key. task_run history is left as it was run.
*/

const PACKAGE_RENAME_FROM = '@engine9/interfaces';
const PACKAGE_RENAME_TO = '@engine9/schemas';
const FROM = `${PACKAGE_RENAME_FROM}/`;
const TO = `${PACKAGE_RENAME_TO}/`;
const LOCAL_PREFIX = 'local$';

const PACKAGE_RENAME_TARGETS = [
  { table: 'plugin', column: 'path' },
  { table: 'plugin_history', column: 'path' },
  { table: 'segment', column: 'definition_path' },
  { table: 'segment', column: 'search', json: true },
  { table: 'setting', column: 'value' },
  { table: 'plugin', column: 'schema', json: true }
];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlFor({ dialect, inline = false }) {
  if (dialect !== 'mysql' && dialect !== 'sqlite') throw new Error(`Unsupported dialect: ${dialect}`);
  const mysql = dialect === 'mysql';
  const quote = (name) => (mysql ? `\`${name}\`` : `"${name}"`);
  const param = (value, values) => {
    if (inline) return sqlString(value);
    values.push(value);
    return '?';
  };
  const rewritten = (text, values) =>
    `replace(replace(${text}, ${param(LOCAL_PREFIX, values)}, ''), ${param(FROM, values)}, ${param(TO, values)})`;
  const isLegacy = (text, values) =>
    `(${text} like ${param(`%${FROM}%`, values)} or ${text} like ${param(`%${LOCAL_PREFIX}%`, values)})`;
  return { mysql, quote, rewritten, isLegacy };
}

/**
 * Count and update SQL for each stored-path column.
 * @param {{ dialect: 'mysql'|'sqlite', inline?: boolean }} opts
 *   inline writes the literals into the SQL (for a file run with wrangler d1 execute --file).
 */
function packageRenameStatements({ dialect, inline = false } = {}) {
  const { mysql, quote, rewritten, isLegacy } = sqlFor({ dialect, inline });
  return PACKAGE_RENAME_TARGETS.map((target) => {
    const col = quote(target.column);
    const text = mysql && target.json ? `cast(${col} as char)` : col;
    const countValues = [];
    const countSql = `select count(*) as n from ${quote(target.table)} where ${isLegacy(text, countValues)}`;
    const updateValues = [];
    // Assign text: MariaDB has no CAST(... AS JSON), and MySQL parses text into a JSON column.
    const next = rewritten(text, updateValues);
    // MySQL bumps modified_at (ON UPDATE CURRENT_TIMESTAMP) unless it is assigned explicitly.
    const keepModified = mysql ? ', modified_at = modified_at' : '';
    const updateSql =
      `update ${quote(target.table)} set ${col} = ${next}${keepModified} ` +
      `where ${isLegacy(text, updateValues)}`;
    return { ...target, key: `${target.table}.${target.column}`, countSql, countValues, updateSql, updateValues };
  });
}

/**
 * Unique plugin rows that would share one path after the rewrite (an old and a
 * current spelling of the same plugin). person_custom is non-unique and is skipped.
 */
function packageRenameDuplicateSql({ dialect } = {}) {
  const { quote, rewritten, isLegacy } = sqlFor({ dialect });
  const path = quote('path');
  const values = [];
  const selectKey = rewritten(path, values);
  values.push('%person_custom%');
  const groupKey = rewritten(path, values);
  const legacy = isLegacy(path, values);
  return {
    sql:
      `select ${selectKey} as path, count(*) as n from ${quote('plugin')} where ${path} not like ? ` +
      `group by ${groupKey} having count(*) > 1 and sum(case when ${legacy} then 1 else 0 end) > 0`,
    values
  };
}

export {
  PACKAGE_RENAME_FROM,
  PACKAGE_RENAME_TO,
  PACKAGE_RENAME_TARGETS,
  packageRenameStatements,
  packageRenameDuplicateSql
};
