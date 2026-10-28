/*
  What the last install of each plugin did, kept on that plugin's own row in
  three columns of the `plugin` table (@engine9/schemas/plugin):

    last_install_at       when it ran (UTC, 'YYYY-MM-DD HH:MM:SS')
    last_install_status   'ok' | 'failed'
    last_install          { step?, error?, code?, trigger, package, version,
                            core, schema_hash }

  It is a cache for `e9core status` and `upgrade --failed`, which cannot read
  the audit log cheaply. The history of every install is the audit log
  (`plugin.install` records). The database is still the source of truth:
  status diffs the schema whatever this row says.

  A database whose plugin table predates the columns gets them from the next
  `e9core upgrade`. Until then the write is skipped.
*/
import { parseJSONValue } from './utilities.js';
import { isMissingColumnError } from './sql/shared.js';

/** The last install of a plugin row as { at, status, ...detail }, or null. */
export function lastInstallOf(row) {
  if (!row?.last_install_status) return null;
  const at = row.last_install_at instanceof Date ? row.last_install_at.toISOString() : row.last_install_at;
  return { at: at ?? null, status: row.last_install_status, ...parseJSONValue(row.last_install, {}) };
}

/** The diff deploy() applied, as { table, difference, columns? } per table. */
export function summarizeSchemaChanges(tables = [], prefix = '') {
  return (tables || []).map((t) => {
    const differences = Array.isArray(t.differences) ? t.differences : [t.differences];
    const out = { table: `${t.prefix === false ? '' : prefix}${t.name}`, difference: differences.join(',') };
    if (!differences.includes('missing') && t.columns?.length) out.columns = t.columns.map((c) => c.name);
    if (!differences.includes('missing') && t.indexes?.length) {
      out.indexes = t.indexes.map((x) => (Array.isArray(x.columns) ? x.columns.join(',') : String(x.columns)));
    }
    return out;
  });
}

/**
 * After an install: write the last_install columns on the plugin row, and a
 * plugin.install audit record when the install changed the schema, failed, or
 * was the first. Neither write may change the install's outcome: a failure is
 * logged and the install's own result (or error) stands.
 */
export async function recordInstall(worker, { plugin, path, ledger, changes = [], firstInstall = false }) {
  const now = new Date();
  const { status, ...detail } = ledger;
  if (plugin?.id) {
    try {
      await worker.query({
        sql: 'update plugin set last_install_at=?, last_install_status=?, last_install=? where id=?',
        values: [now.toISOString().slice(0, 19).replace('T', ' '), status, JSON.stringify(detail), plugin.id]
      });
    } catch (e) {
      if (!isMissingColumnError(e)) {
        console.warn(`engine9: could not record the last install of ${path}: ${e?.message || e}`);
      }
    }
  }
  if (!worker.audit || !(changes.length || status === 'failed' || firstInstall)) return;
  const record = {
    accountId: worker.accountId,
    action: 'plugin.install',
    meta: { plugin_id: plugin?.id || null, path, first_install: firstInstall, at: now.toISOString(), status, ...detail, changes }
  };
  try {
    await worker.audit.log(record);
  } catch (e) {
    console.error(JSON.stringify({ engine9_audit_write_failed: String(e?.message || e), ...record }));
  }
}
