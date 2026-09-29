import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';

const TEST_PLUGIN_PATH = '@engine9/plugins/test-self-scoped';

function withSelfScopedPlugin(worker) {
  const orig = worker.compilePlugin.bind(worker);
  worker.compilePlugin = async (opts) => {
    if (opts.path === TEST_PLUGIN_PATH) {
      return {
        metadata: { name: 'Test Self Scoped', unique: true },
        schema: {
          tables: [
            {
              name: 'acme_blog_post',
              columns: {
                id: 'id_uuid',
                title: 'string',
                created_at: 'created_at',
                modified_at: 'modified_at'
              },
              indexes: [{ columns: ['id'], primary: true }]
            }
          ]
        }
      };
    }
    return orig(opts);
  };
}

test('install without metadata.prefix keeps empty tablePrefix and deploys schema names', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSelfScopedPlugin(plugins);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    assert.equal(installed.tablePrefix ?? '', '');
    const desc = await plugins.describe({ table: 'acme_blog_post' });
    assert.ok(desc.columns.some((c) => c.name === 'title'));
  } finally {
    await plugins.destroyAll();
  }
});
