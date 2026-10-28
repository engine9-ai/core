/*
  The database's schema, read once, for diff() over every installed plugin.

  diff() otherwise asks per table: PRAGMA table_info, index_list, and one
  index_info per index, about five queries a table and a few hundred for a
  stack. A Worker request has a D1 query budget. SQLite and D1 read the whole
  schema in three queries over the pragma table-valued functions. MySQL, or a
  database that refuses those functions, falls back to the per-table calls,
  each made once.

  The snapshot is the schema at the moment it was read. Do not hand it to
  deploy(): deploy changes the schema.
*/
import sqliteDialect, { describeFromTableInfo, indexesFromPragma } from './dialects/SQLite.js';
import { ObjectError } from '../utilities.js';

const SQLITE_OBJECTS = `select type, name, tbl_name from sqlite_master
  where name not like 'sqlite_%' and type in ('table', 'view', 'trigger')`;
const SQLITE_COLUMNS = `select m.name as tbl, p.cid, p.name, p.type, p."notnull" as "notnull", p.dflt_value, p.pk
  from sqlite_master m join pragma_table_info(m.name) p
  where m.type in ('table', 'view') and m.name not like 'sqlite_%'
  order by m.name, p.cid`;
const SQLITE_INDEXES = `select m.name as tbl, il.name as index_name, il."unique" as "unique", il.origin, ii.seqno, ii.name as col
  from sqlite_master m join pragma_index_list(m.name) il join pragma_index_info(il.name) ii
  where m.type = 'table' and m.name not like 'sqlite_%'`;

function missing(table) {
  return new ObjectError({ message: `Could not find table ${table}`, code: 'DOES_NOT_EXIST' });
}

async function rows(worker, sql) {
  const { data } = await worker.query({ sql, logQueries: false });
  return data || [];
}

async function batchedSqlite(worker) {
  const [objects, columns, indexRows] = [
    await rows(worker, SQLITE_OBJECTS),
    await rows(worker, SQLITE_COLUMNS),
    await rows(worker, SQLITE_INDEXES)
  ];
  const types = new Map();
  const triggers = [];
  for (const o of objects) {
    if (o.type === 'trigger') triggers.push({ name: o.name, table: o.tbl_name });
    else types.set(o.name, o.type);
  }
  const tableInfo = new Map();
  for (const c of columns) {
    if (!tableInfo.has(c.tbl)) tableInfo.set(c.tbl, []);
    tableInfo.get(c.tbl).push(c);
  }
  const lists = new Map();
  for (const r of indexRows) {
    if (!lists.has(r.tbl)) lists.set(r.tbl, { list: new Map(), info: {} });
    const t = lists.get(r.tbl);
    if (!t.list.has(r.index_name)) t.list.set(r.index_name, { name: r.index_name, unique: r.unique, origin: r.origin });
    (t.info[r.index_name] = t.info[r.index_name] || []).push({ seqno: r.seqno, name: r.col });
  }
  return {
    batched: true,
    types,
    triggers,
    describe(table) {
      if (!types.has(table)) throw missing(table);
      return describeFromTableInfo(worker, table, tableInfo.get(table));
    },
    indexes(table) {
      const t = lists.get(table) || { list: new Map(), info: {} };
      return indexesFromPragma([...t.list.values()], t.info, tableInfo.get(table) || []);
    }
  };
}

async function perTable(worker) {
  const isSqlite = worker.dialect === sqliteDialect;
  const types = new Map();
  let triggers = null;
  if (isSqlite) {
    triggers = [];
    for (const o of await rows(worker, SQLITE_OBJECTS)) {
      if (o.type === 'trigger') triggers.push({ name: o.name, table: o.tbl_name });
      else types.set(o.name, o.type);
    }
  } else {
    const { tables } = await worker.tables({ includeTemp: true });
    const { tables: views } = await worker.tables({ type: 'view', includeTemp: true });
    const viewSet = new Set(views);
    for (const name of tables) types.set(name, viewSet.has(name) ? 'view' : 'table');
  }
  const described = new Map();
  const indexed = new Map();
  return {
    batched: false,
    types,
    triggers,
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
 * `{ batched, tableNames(), tableType(name), triggers, describe({ table }), indexes({ table }) }`.
 * describe and indexes match the worker's, so diff({ snapshot }) can use either.
 * `triggers` is `[{ name, table }]` on SQLite and D1, null elsewhere.
 */
export async function createSchemaSnapshot(worker) {
  await worker.connect();
  let source = null;
  if (worker.dialect === sqliteDialect) {
    try {
      source = await batchedSqlite(worker);
    } catch {
      source = null;
    }
  }
  if (!source) source = await perTable(worker);
  return {
    batched: source.batched,
    triggers: source.triggers,
    tableNames: () => [...source.types.keys()].sort(),
    tableType: (name) => source.types.get(name) || null,
    hasTable: (name) => source.types.has(name),
    describe: async ({ table }) => source.describe(table),
    indexes: async ({ table }) => source.indexes(table)
  };
}
