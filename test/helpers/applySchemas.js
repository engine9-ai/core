/*
  Test-only: create interface tables from the static SCHEMAS registry and
  insert plugin rows. Live install/diff/deploy is @engine9/server PluginWorker.
*/
import { SCHEMAS } from '../../lib/schemas.js';
import { include as standardInclude } from '@engine9/interfaces/stacks/standard/index.js';
import { getVersionedUUID } from '../../lib/utilities.js';

function columnsFromTable(table) {
  const columns = table.columns || {};
  return Object.keys(columns).map((key) => {
    const col = columns[key];
    const def = typeof col === 'string' ? { type: col } : { ...col };
    return { ...def, name: Array.isArray(columns) ? def.name : key };
  });
}

export async function createTablesFromSchema(worker, schema) {
  if (!schema?.tables) throw new Error('schema.tables is required');
  await worker.connect();
  for (const table of schema.tables) {
    if (table.type === 'view') continue;
    const columns = columnsFromTable(table);
    if (!columns.length) continue;
    await worker.createTable({
      table: table.name,
      columns,
      indexes: table.indexes || []
    });
  }
}

export async function ensurePluginRow(worker, { id, path, name, tablePrefix = '' } = {}) {
  if (!path) throw new Error('path is required');
  if (id) {
    const { data } = await worker.query({ sql: 'select * from plugin where id=?', values: [id] });
    if (data[0]) return data[0];
  } else {
    const { data: byPath } = await worker.query({
      sql: 'select * from plugin where path=? order by created_at',
      values: [path]
    });
    if (byPath[0]) return byPath[0];
  }
  const row = {
    id: id || getVersionedUUID(),
    path,
    name: name || path.split('/').pop(),
    table_prefix: tablePrefix
  };
  await worker.insertArray({ table: 'plugin', array: [row] });
  return row;
}

export async function applyInterface(worker, pluginPath) {
  const schema = SCHEMAS[pluginPath];
  if (!schema) throw new Error(`Unknown schema ${pluginPath} -- not in the client schema registry`);
  await createTablesFromSchema(worker, schema);
  return ensurePluginRow(worker, { path: pluginPath });
}

export async function applyStandardStack(worker) {
  for (const pluginPath of standardInclude) {
    await applyInterface(worker, pluginPath);
  }
  await ensurePluginRow(worker, {
    path: '@engine9/interfaces/stacks/standard',
    name: 'standard'
  });
  return { complete: true };
}
