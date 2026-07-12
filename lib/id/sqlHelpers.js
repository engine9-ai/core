/**
 * Shared SQL worker helpers for identifier stores.
 */

export function isClientSqlWorker(worker) {
  return typeof worker.insertArray === 'function';
}

export async function getKnex(worker) {
  if (typeof worker.connect !== 'function') return null;
  const conn = await worker.connect();
  if (conn?.table && conn?.select) return conn;
  return null;
}

/** True for SQLite / D1 (client SQLWorker or knex sqlite). */
export function isSqliteLike(worker) {
  if (worker?.d1) return true;
  if (worker?.dialect?.name === 'SQLite' || worker?.dialect === 'SQLite') return true;
  const conn = worker?.auth?.database_connection || '';
  return typeof conn === 'string' && conn.indexOf('sqlite://') === 0;
}
