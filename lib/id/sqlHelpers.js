/**
 * Shared SQL worker helpers for identifier stores.
 *
 * Both core and server SQLWorkers expose query() / insertArray(). The remaining
 * forks are capability (D1 has no knex) and dialect (SQLite last-insert vs
 * MySQL first-insert), not "client vs server".
 */
import { isSqliteConnectionString } from '../sql/shared.js';

export async function getKnex(worker) {
  if (typeof worker.connect !== 'function') return null;
  const conn = await worker.connect();
  if (conn?.table && conn?.select) return conn;
  return null;
}

/** True for SQLite / D1. */
export function isSqliteLike(worker) {
  if (worker?.d1) return true;
  if (worker?.dialect?.name === 'SQLite' || worker?.dialect === 'SQLite') return true;
  const conn = worker?.auth?.database_connection || '';
  return isSqliteConnectionString(conn);
}

/**
 * Contiguous autoincrement ids after a multi-row insert.
 * SQLite last_insert_rowid() / knex sqlite is the LAST id; MySQL insertId is FIRST.
 */
export function contiguousInsertIds(returnedId, count, { returnedIdIsLast } = {}) {
  const n = Number(returnedId);
  const first = returnedIdIsLast ? n - count + 1 : n;
  return Array.from({ length: count }, (_, i) => first + i);
}
