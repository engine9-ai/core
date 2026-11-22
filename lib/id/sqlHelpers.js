/**
 * Shared SQL worker helpers for identifier stores.
 *
 * Both core and server SQLWorkers expose query() / insertArray(). The remaining
 * forks are capability (D1 has no knex) and the dialect's answers below, not
 * "client vs server". A dialect without one of them behaves as MySQL does.
 */
import sqliteDialect from '../sql/dialects/SQLite.js';
import { isSqliteConnectionString } from '../sql/shared.js';

export async function getKnex(worker) {
  if (typeof worker.connect !== 'function') return null;
  const conn = await worker.connect();
  if (conn?.table && conn?.select) return conn;
  return null;
}

/* The worker's dialect; a worker that names none is read from its connection. */
function dialectOf(worker) {
  if (worker?.dialect && typeof worker.dialect === 'object') return worker.dialect;
  if (worker?.d1 || worker?.dialect === 'SQLite') return sqliteDialect;
  if (isSqliteConnectionString(worker?.auth?.database_connection || '')) return sqliteDialect;
  return {};
}

/**
 * `{ personIdType, valueType, defaultKind }` for the identifier stores:
 * the person_id_* column types, and the store kind when the setting is unset.
 */
export function identifierStoreTraits(worker) {
  return { personIdType: 'bigint', valueType: 'binary(16)', defaultKind: 'legacy', ...dialectOf(worker).identifierStore };
}

/** `insert <modifier> into`: skip rows that hit a unique key. */
export function insertIgnoreModifier(worker) {
  return dialectOf(worker).insertIgnoreModifier || 'ignore';
}

/** True when a multi-row insert reports its last id (SQLite), not its first (MySQL). */
export function insertIdIsLast(worker) {
  return Boolean(dialectOf(worker).insertIdIsLast);
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
