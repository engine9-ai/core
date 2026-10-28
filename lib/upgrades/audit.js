/* The audit record an upgrade run writes (lib/upgrades/index.js, ./plugins.js). */

/**
 * One audit record for a real upgrade run. actor ({ apiKeyId, roleId } or
 * { by: 'cli' }) says who ran it. A failed write never fails the upgrade.
 */
export async function auditUpgrade(worker, action, meta, actor = {}) {
  if (!worker.audit) return;
  const record = { accountId: worker.accountId, action, ...actor, meta };
  try {
    await worker.audit.log(record);
  } catch (e) {
    console.error(JSON.stringify({ engine9_audit_write_failed: String(e?.message || e), ...record }));
  }
}
