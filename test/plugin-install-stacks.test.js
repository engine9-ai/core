import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';

const LIMITED_PII_STACK_PATH = '@engine9/interfaces/stacks/limited-pii';

test('limited-pii stack excludes person_email; standard stack is blocked after', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await plugins.installStandard({ path: LIMITED_PII_STACK_PATH });
    const { tables } = await plugins.tables();
    assert.ok(tables.includes('person_hash_email'));
    assert.ok(!tables.includes('person_email'));

    await assert.rejects(() => plugins.installStandard(), /excluded by/);
    await assert.rejects(
      () => plugins.install({ path: '@engine9/interfaces/person_email' }),
      /excluded by @engine9\/interfaces\/stacks\/limited-pii/
    );
  } finally {
    await plugins.destroyAll();
  }
});
