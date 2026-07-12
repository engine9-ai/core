/**
 * Full person_identifier SQL store.
 *
 * Uses the existing person_identifier table (id_type, id_value string, person_id,
 * source_input_id, …). Default for MySQL; SQLite/D1 and Durable Objects use compact stores.
 */
import { isClientSqlWorker, getKnex } from './sqlHelpers.js';

/**
 * Look up person_identifier rows for { id_type, id_value } entries.
 * SQL matches on id_value (IN list); id_type is returned for callers.
 */
export async function findByIdentifiers(worker, entries) {
  if (!entries?.length) return [];
  const idValues = [...new Set(entries.map((e) => e.id_value).filter((v) => v != null && v !== ''))];
  if (idValues.length === 0) return [];
  if (isClientSqlWorker(worker)) {
    const { data } = await worker.query({
      sql: `select id_value,id_type,person_id from person_identifier where id_value in (${idValues.map(() => '?').join(',')})`,
      values: idValues
    });
    return data;
  }
  const knex = await getKnex(worker);
  return knex
    .select(['id_value', 'id_type', 'person_id'])
    .from('person_identifier')
    .where('id_value', 'in', idValues);
}

/** @deprecated Use findByIdentifiers */
export async function findByIdValues(worker, idValues) {
  return findByIdentifiers(
    worker,
    (idValues || []).map((id_value) => ({ id_type: '', id_value }))
  );
}

export async function insertPersons(worker, rows) {
  if (rows.length === 0) return [];
  if (isClientSqlWorker(worker)) {
    // Fast path: empty rows → multi-value NULL inserts (contiguous autoincrement ids)
    const allEmpty = rows.every((row) => !row || Object.keys(row).length === 0);
    if (allEmpty) {
      const ids = [];
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const n = Math.min(chunkSize, rows.length - i);
        const valuesSql = Array(n).fill('(NULL)').join(',');
        const r = await worker.query(`insert into person (id) values ${valuesSql}`);
        const last = r.lastInsertRowid;
        if (last == null) throw new Error('insertPersons: missing lastInsertRowid after batch insert');
        const first = Number(last) - n + 1;
        for (let j = 0; j < n; j++) ids.push(first + j);
      }
      return ids;
    }
    const ids = [];
    for (const row of rows) {
      const { id } = await worker.insertOne({ table: 'person', row });
      ids.push(id);
    }
    return ids;
  }
  const knex = await getKnex(worker);
  const knexRows = rows.map((row) => ({ id: null, ...row }));
  const response = await knex.table('person').insert(knexRows);
  let currentId = response[0];
  const ids = [];
  for (let i = 0; i < rows.length; i++) {
    ids.push(currentId);
    currentId += 1;
  }
  return ids;
}

export async function insertIdentifiers(worker, rows) {
  if (rows.length === 0) return;
  if (isClientSqlWorker(worker)) {
    await worker.insertArray({ table: 'person_identifier', array: rows });
    return;
  }
  const knex = await getKnex(worker);
  await knex.table('person_identifier').insert(rows);
}

/**
 * Store backed by the full person_identifier table.
 * find/insert take (entries|rows) only; worker is closed over.
 */
export function createPersonIdentifierSqlStore(worker) {
  return {
    kind: 'person_identifier',
    findByIdentifiers: (entries) => findByIdentifiers(worker, entries),
    insertIdentifiers: (rows) => insertIdentifiers(worker, rows)
  };
}

/** @deprecated Prefer createPersonIdentifierSqlStore */
export function createSqlIdentifierStore(worker) {
  return createPersonIdentifierSqlStore(worker);
}
