import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';

const LIMITED_PII_STACK_PATH = '@engine9/schemas/stacks/limited-pii';
const LIMITED_PII_PLUGIN_PATH = '@engine9/schemas/utilities/limited-pii';

async function enableExcludePii(plugins) {
  await plugins.install({ path: LIMITED_PII_PLUGIN_PATH, unique: true });
  const { data } = await plugins.query({
    sql: 'select id from plugin where path=? limit 1',
    values: [LIMITED_PII_PLUGIN_PATH]
  });
  await plugins.setSetting({ pluginId: data[0].id, name: 'exclude_pii', value: true });
}

test('limited-pii stack is an install list only; exclude_pii refuses plaintext plugins', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await plugins.installDefaultPlugins({ path: LIMITED_PII_STACK_PATH });
    const { tables } = await plugins.tables();
    assert.ok(tables.includes('person_hash_email'));
    assert.ok(!tables.includes('person_email'));
    assert.ok(!tables.includes('person_phone'));
    assert.ok(!tables.includes('person_address'));
    assert.ok(!tables.includes('person_name'));

    // Stack alone does not refuse plaintext installs.
    await plugins.install({ path: '@engine9/schemas/person_name', unique: true });
    assert.ok((await plugins.tables()).tables.includes('person_name'));

    await enableExcludePii(plugins);
    await assert.rejects(
      () => plugins.install({ path: '@engine9/schemas/transaction/contact_details' }),
      /exclude_pii/
    );
    await assert.rejects(
      () => plugins.install({ path: '@engine9/schemas/person_email' }),
      /exclude_pii/
    );
    await assert.rejects(
      () => plugins.install({ path: '@engine9/schemas/person_address' }),
      /exclude_pii/
    );

    const refreshed = await plugins.installDefaultPlugins();
    assert.equal(refreshed.path, LIMITED_PII_STACK_PATH);
  } finally {
    await plugins.destroyAll();
  }
});
