/**
 * Full person_identifier SQL store.
 *
 * Uses the existing person_identifier table (id_type, id_value string, person_id,
 * source_input_id, …). Default for MySQL; SQLite/D1 and Durable Objects use compact stores.
 */
import { getKnex, isSqliteLike, contiguousInsertIds } from './sqlHelpers.js';

/**
 * Look up person_identifier rows for { id_type, id_value } entries.
 * SQL matches on id_value (IN list); id_type is returned for callers.
 */
export async function findByIdentifiers(worker, entries) {
  if (!entries?.length) return [];
  const idValues = [...new Set(entries.map((e) => e.id_value).filter((v) => v != null && v !== ''))];
  if (idValues.length === 0) return [];
  if (typeof worker.query === 'function') {
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

  // Node workers (server + core sqlite/mysql) have knex. D1 does not.
  const knex = await getKnex(worker);
  if (knex) {
    const knexRows = rows.map((row) => ({ id: null, ...row }));
    const response = await knex.table('person').insert(knexRows);
    // SQLite last_insert_rowid is the last row; MySQL insertId is the first.
    return contiguousInsertIds(response[0], rows.length, { returnedIdIsLast: isSqliteLike(worker) });
  }

  // D1 / query-only: lastInsertRowid is the last assigned id
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
      ids.push(...contiguousInsertIds(last, n, { returnedIdIsLast: true }));
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

export async function insertIdentifiers(worker, rows) {
  if (rows.length === 0) return;
  if (typeof worker.insertArray === 'function') {
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
