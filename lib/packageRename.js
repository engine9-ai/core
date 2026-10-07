/*
  Rewrite stored plugin paths after `@engine9/interfaces` was renamed to
  `@engine9/schemas`.

  pluginPaths reads both spellings, so nothing breaks before this runs. This
  makes the account database say the new name everywhere it stores a path:

    plugin.path, plugin_history.path   plugin identity
    segment.definition_path            `<plugin>:segments:<key>`
    segment.search                     search-tree clause paths (JSON)
    setting.value                      e.g. default_stack
    plugin.schema                      JSON, normally path-free

  IDs are not touched: schema plugin rows are not path-derived, and segment ids
  come from plugin_id + key. `local$` in front of the old name is dropped too.
  task_run history is left as it was run.
*/
import { LEGACY_SCHEMAS_PACKAGE, SCHEMAS_PACKAGE } from './pluginPaths.js';

const FROM = `${LEGACY_SCHEMAS_PACKAGE}/`;
const FROM_LOCAL = `local$${FROM}`;
const TO = `${SCHEMAS_PACKAGE}/`;

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

/**
 * Count and update SQL for each stored-path column.
 * @param {{ dialect: 'mysql'|'sqlite', inline?: boolean }} opts
 *   inline writes the literals into the SQL (for a file run with wrangler d1 execute --file).
 */
function packageRenameStatements({ dialect, inline = false } = {}) {
  if (dialect !== 'mysql' && dialect !== 'sqlite') throw new Error(`Unsupported dialect: ${dialect}`);
  const mysql = dialect === 'mysql';
  const quote = (name) => (mysql ? `\`${name}\`` : `"${name}"`);
  const param = (value, values) => {
    if (inline) return sqlString(value);
    values.push(value);
    return '?';
  };
  return PACKAGE_RENAME_TARGETS.map((target) => {
    const col = quote(target.column);
    const text = mysql && target.json ? `cast(${col} as char)` : col;
    const countValues = [];
    const countSql = `select count(*) as n from ${quote(target.table)} where ${text} like ${param(`%${FROM}%`, countValues)}`;
    const updateValues = [];
    // Assign text: MariaDB has no CAST(... AS JSON), and MySQL parses text into a JSON column.
    const next = `replace(replace(${text}, ${param(FROM_LOCAL, updateValues)}, ${param(TO, updateValues)}), ${param(FROM, updateValues)}, ${param(TO, updateValues)})`;
    // MySQL bumps modified_at (ON UPDATE CURRENT_TIMESTAMP) unless it is assigned explicitly.
    const keepModified = mysql ? ', modified_at = modified_at' : '';
    const updateSql =
      `update ${quote(target.table)} set ${col} = ${next}${keepModified} ` +
      `where ${text} like ${param(`%${FROM}%`, updateValues)}`;
    return { ...target, key: `${target.table}.${target.column}`, countSql, countValues, updateSql, updateValues };
  });
}

/**
 * Unique plugin rows that would share one path after the rename (an old and a new
 * spelling of the same plugin). person_custom is non-unique and is skipped.
 */
function packageRenameDuplicateSql({ dialect } = {}) {
  const quote = (name) => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
  const renamed = `replace(replace(replace(${quote('path')}, ?, ?), ?, ?), 'local$', '')`;
  return {
    sql:
      `select ${renamed} as path, count(*) as n from ${quote('plugin')} ` +
      `where (${quote('path')} like ? or ${quote('path')} like ?) and ${quote('path')} not like ? ` +
      `group by ${renamed} ` +
      `having count(*) > 1 and sum(case when ${quote('path')} like ? then 1 else 0 end) > 0`,
    values: [
      FROM_LOCAL, TO, FROM, TO,
      `%${FROM}%`, `%${TO}%`, '%person_custom%',
      FROM_LOCAL, TO, FROM, TO,
      `%${FROM}%`
    ]
  };
}

export { PACKAGE_RENAME_TARGETS, packageRenameStatements, packageRenameDuplicateSql };
