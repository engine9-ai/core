/*
  Test helper: live-install interface schemas via PluginWorker.
  Stack include/exclude is loaded at install time, not a static list.
*/
import PluginWorker from '../../lib/PluginWorker.js';
import { getVersionedUUID } from '../../lib/utilities.js';

function asPluginWorker(worker) {
  if (typeof worker.installStandard === 'function' && typeof worker.install === 'function') return worker;
  return new PluginWorker(worker);
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
  const plugins = asPluginWorker(worker);
  return plugins.install({ path: pluginPath, unique: true });
}

export async function applyStandardStack(worker) {
  const plugins = asPluginWorker(worker);
  return plugins.installStandard();
}
