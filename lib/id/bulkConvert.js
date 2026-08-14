/**
 * Bulk-load a SQL person_identifier table into a compact store
 * (person_id_<id_type> tables, Durable Object, etc.).
 * First-wins is enforced by the target store's insertIdentifiers.
 *
 * Uses keyset pagination (id > after_id) — safe at hundred-million scale.
 */
import debug$0 from 'debug';
import { isClientSqlWorker, getKnex } from './sqlHelpers.js';
import { bool } from '../utilities.js';

const debug = debug$0('PersonId:bulkConvert');
const info = debug$0('info:PersonId:bulkConvert');

function ratePerSecond(count, startedAtMs) {
  const ms = Date.now() - startedAtMs;
  if (!(ms > 0) || !(count > 0)) return null;
  return Number(((count * 1000) / ms).toFixed(1));
}

function logBulkProgress(
  worker,
  message,
  { read, written, skipped, last_id, dry_run, startedAtMs, force = false, batch_size = 1000 }
) {
  const rate = ratePerSecond(read, startedAtMs);
  const suffix = rate != null ? ` (${rate}/s)` : '';
  const line = `${message} read=${read} written=${written} skipped=${skipped} last_id=${last_id} dry_run=${dry_run}${suffix}`;
  if (!force) {
    const shouldLog =
      typeof worker?.shouldLogRecordCount === 'function'
        ? worker.shouldLogRecordCount(read)
        : read > 0 && read % Math.max(batch_size * 10, 50000) === 0;
    if (!shouldLog) {
      debug(line);
      return;
    }
  }
  info(line);
  debug(line);
  if (typeof worker?.progress === 'function') {
    worker.progress(line);
  }
}

async function fetchPage(worker, { limit, after_id }) {
  if (isClientSqlWorker(worker)) {
    const { data } = await worker.query({
      sql: `select id, id_type, id_value, person_id from person_identifier
        where id > ? order by id limit ?`,
      values: [after_id, limit]
    });
    return data || [];
  }
  const knex = await getKnex(worker);
  return knex
    .select(['id', 'id_type', 'id_value', 'person_id'])
    .from('person_identifier')
    .where('id', '>', after_id)
    .orderBy('id')
    .limit(limit);
}

/**
 * Page through person_identifier and write compact entries into `store`.
 * @param {object} opts
 * @param {object} opts.worker
 * @param {object} [opts.store] required unless dry_run
 * @param {number} [opts.batch_size=1000]
 * @param {boolean} [opts.dry_run=false] count only; do not insert
 * @param {number} [opts.after_id=0] keyset start (exclusive)
 * @returns {{ read: number, written: number, skipped: number, last_id: number, dry_run: boolean, elapsed_ms: number, rows_per_second: number|null }}
 */
export async function bulkConvertPersonIdentifiers({
  worker,
  store = null,
  batch_size = null,
  batchSize = null, // deprecated camelCase
  dry_run: dryRunOpt = false,
  after_id = 0
} = {}) {
  if (!worker) throw new Error('bulkConvertPersonIdentifiers requires worker');
  const dry_run = bool(dryRunOpt, false);
  if (!dry_run && !store?.insertIdentifiers) {
    throw new Error('bulkConvertPersonIdentifiers requires a store with insertIdentifiers');
  }

  const limit = Math.max(1, Number(batch_size ?? batchSize) || 1000);
  let cursor = Number(after_id) || 0;
  let read = 0;
  let written = 0;
  let skipped = 0;
  let last_id = cursor;
  const startedAtMs = Date.now();

  info(
    `bulkConvertPersonIdentifiers start after_id=${cursor} batch_size=${limit} dry_run=${dry_run}`
  );
  if (typeof worker?.progress === 'function') {
    worker.progress(
      `bulkConvertPersonIdentifiers: start after_id=${cursor} batch_size=${limit} dry_run=${dry_run}`
    );
  }

  for (;;) {
    const page = await fetchPage(worker, { limit, after_id: cursor });
    if (page.length === 0) break;

    const rows = [];
    for (const row of page) {
      read += 1;
      const id = typeof row.id === 'number' ? row.id : parseInt(String(row.id), 10);
      if (Number.isFinite(id)) last_id = id;
      if (row.id_value == null || row.id_value === '' || !row.id_type) {
        skipped += 1;
        continue;
      }
      const personId = typeof row.person_id === 'number' ? row.person_id : parseInt(String(row.person_id), 10);
      if (!Number.isFinite(personId)) {
        skipped += 1;
        continue;
      }
      rows.push({
        id_type: row.id_type,
        id_value: row.id_value,
        person_id: personId
      });
    }

    if (rows.length > 0 && !dry_run) {
      await store.insertIdentifiers(rows);
      written += rows.length;
    } else if (rows.length > 0 && dry_run) {
      written += rows.length;
    }

    debug(
      'bulkConvert after_id=%d page=%d read=%d written=%d dry_run=%s',
      cursor,
      page.length,
      read,
      written,
      dry_run
    );

    logBulkProgress(worker, 'bulkConvertPersonIdentifiers progress', {
      read,
      written,
      skipped,
      last_id,
      dry_run,
      startedAtMs,
      batch_size: limit
    });

    if (page.length < limit) break;
    cursor = last_id;
  }

  const elapsed_ms = Date.now() - startedAtMs;
  const rows_per_second = ratePerSecond(read, startedAtMs);
  logBulkProgress(worker, 'bulkConvertPersonIdentifiers complete', {
    read,
    written,
    skipped,
    last_id,
    dry_run,
    startedAtMs,
    force: true
  });

  return { read, written, skipped, last_id, dry_run, elapsed_ms, rows_per_second };
}
