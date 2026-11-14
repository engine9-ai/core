/*
  Test helper: live-install @engine9/schemas plugins via PluginWorker.
  A plugin's include list is loaded at install time, not a static list.
*/
import PluginWorker from '../../lib/PluginWorker.js';
import { getVersionedUUID } from '../../lib/utilities.js';

function asPluginWorker(worker) {
  if (typeof worker.installRequiredPlugins === 'function' && typeof worker.install === 'function') return worker;
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

export async function applySchemaPlugin(worker, pluginPath) {
  const plugins = asPluginWorker(worker);
  return plugins.install({ path: pluginPath, unique: true });
}

/** The table @engine9/plugins/person_identifier deploys, for conversion tests. */
export async function deployLegacyIdentifierTable(worker) {
  await worker.deploy({
    schema: {
      tables: [
        {
          name: 'person_identifier',
          columns: {
            id: 'id',
            person_id: 'person_id',
            source_input_id: 'uuid',
            id_type: 'string',
            id_value: 'id_string'
          }
        }
      ]
    }
  });
}

export const CONTACT_EDITION = '@engine9/schemas/editions/contact';
export const PII_FREE_EDITION = '@engine9/schemas/editions/pii-free';

/** The required plugins, then one more plugin (an edition, usually). */
export async function installEdition(worker, path) {
  const plugins = asPluginWorker(worker);
  await plugins.installRequiredPlugins();
  return plugins.install({ path });
}

/** The required plugins, then the contact edition: what most tests need. */
export async function applyContactEdition(worker) {
  const plugins = asPluginWorker(worker);
  await plugins.installRequiredPlugins();
  return plugins.install({ path: CONTACT_EDITION });
}
