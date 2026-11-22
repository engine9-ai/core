/*
  The database's schema, read once, for diff() over every installed plugin.

  diff() otherwise asks per table: about five queries a table and a few
  hundred for a full install. A Worker request has a D1 query budget. A
  dialect with introspection.readSchema reads the whole schema at once
  (SQLite and D1: three queries). Any other database, or one that refuses
  that read, falls back to the per-table calls, each made once.

  The snapshot is the schema at the moment it was read. Do not hand it to
  deploy(): deploy changes the schema.
*/
import { ObjectError } from '../utilities.js';

function missing(table) {
  return new ObjectError({ message: `Could not find table ${table}`, code: 'DOES_NOT_EXIST' });
}

async function perTable(worker) {
  const types = new Map();
  const { tables } = await worker.tables({ includeTemp: true });
  const { tables: views } = await worker.tables({ type: 'view', includeTemp: true });
  const viewSet = new Set(views);
  for (const name of tables) types.set(name, viewSet.has(name) ? 'view' : 'table');
  const described = new Map();
  const indexed = new Map();
  return {
    batched: false,
    types,
    describe(table) {
      if (!types.has(table)) throw missing(table);
      if (!described.has(table)) described.set(table, worker.describe({ table }));
      return described.get(table);
    },
    indexes(table) {
      if (!indexed.has(table)) indexed.set(table, worker.indexes({ table }));
      return indexed.get(table);
    }
  };
}

/**
 * `{ batched, tableNames(), tableType(name), describe({ table }), indexes({ table }) }`.
 * describe and indexes match the worker's, so diff({ snapshot }) can use either.
 */
export async function createSchemaSnapshot(worker) {
  await worker.connect();
  let source = null;
  const readSchema = worker.dialect?.introspection?.readSchema;
  if (readSchema) {
    try {
      source = { batched: true, ...(await readSchema(worker)) };
    } catch {
      source = null;
    }
  }
  if (!source) source = await perTable(worker);
  return {
    batched: source.batched,
    tableNames: () => [...source.types.keys()].sort(),
    tableType: (name) => source.types.get(name) || null,
    hasTable: (name) => source.types.has(name),
    describe: async ({ table }) => source.describe(table),
    indexes: async ({ table }) => source.indexes(table)
  };
}
