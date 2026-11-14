import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';

const PII_FREE_EDITION = '@engine9/schemas/editions/pii-free';
const LIMITED_PII_PLUGIN_PATH = '@engine9/schemas/utilities/limited-pii';

async function enableExcludePii(plugins) {
  await plugins.install({ path: LIMITED_PII_PLUGIN_PATH, unique: true });
  const { data } = await plugins.query({
    sql: 'select id from plugin where path=? limit 1',
    values: [LIMITED_PII_PLUGIN_PATH]
  });
  await plugins.setSetting({ pluginId: data[0].id, name: 'exclude_pii', value: true });
}

test('the pii-free edition is an install list only; exclude_pii refuses plaintext plugins', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await plugins.installRequiredPlugins();
    await plugins.install({ path: PII_FREE_EDITION });
    const { tables } = await plugins.tables();
    assert.ok(tables.includes('person_hash_email'));
    for (const t of ['person_email', 'person_phone', 'person_address', 'person_name']) assert.ok(!tables.includes(t), t);

    // The edition alone does not refuse plaintext installs.
    await plugins.install({ path: '@engine9/schemas/person_name', unique: true });
    assert.ok((await plugins.tables()).tables.includes('person_name'));

    await enableExcludePii(plugins);
    for (const path of ['@engine9/schemas/transaction/contact_details', '@engine9/schemas/person_email', '@engine9/schemas/person_address']) {
      await assert.rejects(() => plugins.install({ path }), /exclude_pii/, path);
    }

    // Reinstalling an edition the account already has still works.
    const again = await plugins.install({ path: PII_FREE_EDITION });
    assert.equal(again.path, PII_FREE_EDITION);
  } finally {
    await plugins.destroyAll();
  }
});
