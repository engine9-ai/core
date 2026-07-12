/**
 * Bulk-load a SQL person_identifier table into a compact store
 * (person_id_<id_type> tables, Durable Object, etc.).
 * First-wins is enforced by the target store's insertIdentifiers.
 */
import debug$0 from 'debug';

const debug = debug$0('PersonId:bulkConvert');

function isClientSqlWorker(worker) {
  return typeof worker.insertArray === 'function';
}

async function getKnex(worker) {
  if (typeof worker.connect !== 'function') return null;
  const conn = await worker.connect();
  if (conn?.table && conn?.select) return conn;
  return null;
}

async function fetchPage(worker, { limit, offset }) {
  if (isClientSqlWorker(worker)) {
    const { data } = await worker.query({
      sql: `select id_type, id_value, person_id from person_identifier order by id limit ? offset ?`,
      values: [limit, offset]
    });
    return data || [];
  }
  const knex = await getKnex(worker);
  return knex
    .select(['id_type', 'id_value', 'person_id'])
    .from('person_identifier')
    .orderBy('id')
    .limit(limit)
    .offset(offset);
}

/**
 * Page through person_identifier and write compact entries into `store`.
 * @returns {{ read: number, written: number, skipped: number }}
 */
export async function bulkConvertPersonIdentifiers({ worker, store, batchSize = 1000 } = {}) {
  if (!worker) throw new Error('bulkConvertPersonIdentifiers requires worker');
  if (!store?.insertIdentifiers) throw new Error('bulkConvertPersonIdentifiers requires a store with insertIdentifiers');

  const limit = Math.max(1, Number(batchSize) || 1000);
  let offset = 0;
  let read = 0;
  let written = 0;
  let skipped = 0;

  for (;;) {
    const page = await fetchPage(worker, { limit, offset });
    if (page.length === 0) break;

    const rows = [];
    for (const row of page) {
      read += 1;
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

    if (rows.length > 0) {
      await store.insertIdentifiers(rows);
      written += rows.length;
    }

    debug('bulkConvert page offset=%d read=%d written=%d', offset, page.length, rows.length);
    if (page.length < limit) break;
    offset += limit;
  }

  return { read, written, skipped };
}
