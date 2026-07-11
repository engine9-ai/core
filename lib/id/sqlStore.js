/**
 * SQL-backed person identifier store for identity resolution.
 * Uses knex batch operations on the server SQLWorker; SQLWorker helpers on the client.
 */

function isClientSqlWorker(worker) {
  return typeof worker.insertArray === 'function';
}

async function getKnex(worker) {
  if (typeof worker.connect !== 'function') return null;
  const conn = await worker.connect();
  if (conn?.table && conn?.select) return conn;
  return null;
}

export async function findByIdValues(worker, idValues) {
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

export async function insertPersons(worker, rows) {
  if (rows.length === 0) return [];
  if (isClientSqlWorker(worker)) {
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
