/*
  Widen setting.value from varchar(255) (schema type string) to text.

  Plugin settings such as people_custom_fields are JSON-serialized strings and
  routinely exceed 255 characters. MySQL truncates silently on write; SQLite
  stores the full value under varchar affinity but SchemaWorker skips in-place
  type changes, so refresh alone never widens the column.

  MySQL: ALTER TABLE … MODIFY COLUMN value TEXT.
  SQLite/D1: rebuild the table with value declared as TEXT (no MODIFY COLUMN).

  Uses only worker.query / describe, so it runs on D1, SQLite, and MySQL.
*/
import { bool } from '../utilities.js';
import { buildTableRebuild } from '../sql/sqliteDDL.js';

function isWideText(col) {
  if (!col) return false;
  const ct = String(col.column_type || '')
    .toLowerCase()
    .split('(')[0]
    .trim();
  if (col.type === 'text') return true;
  if (ct === 'text' || ct === 'mediumtext' || ct === 'longtext' || ct === 'clob') return true;
  if (Number(col.length) > 255) return true;
  return false;
}

async function describeSetting(worker) {
  try {
    return await worker.describe({ table: 'setting' });
  } catch (e) {
    if (e?.code === 'DOES_NOT_EXIST') return null;
    throw e;
  }
}

async function inspect(worker) {
  const desc = await describeSetting(worker);
  if (!desc) return null;
  const value = desc.columns.find((c) => c.name === 'value') || null;
  return {
    dialect: worker.dialect?.name || null,
    value_type: value?.type || null,
    value_column_type: value?.column_type || null,
    value_length: value?.length ?? null,
    wide: isWideText(value)
  };
}

async function widenMysql(worker) {
  await worker.query(`alter table setting modify column ${worker.escapeColumn('value')} text`);
}

async function widenSqlite(worker) {
  const table = 'setting';
  const escaped = table.replace(/'/g, "''");
  const info = await worker.query({ sql: `PRAGMA table_info("${escaped}")`, logQueries: false });
  const existingColumns = (info.data || []).map((col) =>
    col.name === 'value' ? { ...col, type: 'TEXT' } : col
  );
  if (!existingColumns.length) {
    throw new Error('Cannot widen setting.value: the table has no columns');
  }
  const master = await worker.query({
    sql: `select type, sql from sqlite_master where tbl_name='${escaped}' and sql is not null`,
    logQueries: false
  });
  const rows = master.data || [];
  const createSql = rows.find((row) => row.type === 'table')?.sql || '';
  const statements = buildTableRebuild({
    table,
    existingColumns,
    newColumns: [],
    indexSql: rows.filter((row) => row.type === 'index').map((row) => row.sql),
    triggerSql: rows.filter((row) => row.type === 'trigger').map((row) => row.sql),
    autoincrement: /autoincrement/i.test(createSql)
  });
  for (const sql of statements) {
    await worker.query(sql);
  }
}

/** options: dryRun (report the plan, change nothing). */
export async function upgradeSettingValueText(worker, options = {}) {
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const state = await inspect(worker);
  if (!state) return { pending: false, changed: false, skipped: 'no setting table' };

  const pending = !state.wide;
  const plan = [];
  if (pending) {
    plan.push(
      state.dialect === 'SQLite'
        ? 'rebuild setting with value as text'
        : 'alter setting.value to text'
    );
  }
  const result = {
    pending,
    dialect: state.dialect,
    value_type: state.value_type,
    value_column_type: state.value_column_type,
    value_length: state.value_length,
    plan
  };
  if (dryRun) return { ...result, dry_run: true };
  if (!pending) return { ...result, changed: false };

  if (state.dialect === 'SQLite') await widenSqlite(worker);
  else await widenMysql(worker);

  const after = await inspect(worker);
  if (!after?.wide) {
    throw new Error(
      `setting.value is still ${after?.value_column_type || after?.value_type || 'unknown'} after widen`
    );
  }
  return {
    ...result,
    changed: true,
    value_type: after.value_type,
    value_column_type: after.value_column_type,
    value_length: after.value_length
  };
}

export default {
  id: 'setting_value_text',
  since: '1.11.2',
  description:
    'Widen setting.value from varchar(255) to text so JSON plugin settings are not truncated.',
  run: upgradeSettingValueText
};
