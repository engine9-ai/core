import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { DEFAULT_CORE_SCHEMAS } from '../lib/stackMetadata.js';
import { readIdentifierStoreKind } from '../lib/id/storeKind.js';

test('installDefaultPlugins bootstraps a SQLite database for the person pipeline', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    const r = await worker.installDefaultPlugins();
    assert.equal(r.complete, true);
    assert.equal(r.path, null);
    assert.deepEqual(r.installed, DEFAULT_CORE_SCHEMAS);
    const { tables } = await worker.tables();
    for (const t of [
      'plugin',
      'person',
      'person_email',
      'person_phone',
      'person_address',
      'segment',
      'person_segment',
      'source_code_dictionary',
      'api_key'
    ]) {
      assert.ok(tables.indexOf(t) >= 0, `expected table ${t}, got ${tables.join(',')}`);
    }
    for (const t of ['timeline', 'transaction', 'person_identifier']) {
      assert.ok(tables.indexOf(t) < 0, `did not expect table ${t} from no-arg installDefaultPlugins`);
    }
    assert.equal(await readIdentifierStoreKind(worker), 'compact', 'new accounts use compact person ids');
    const { data: pluginRows } = await worker.query('select path from plugin order by path');
    assert.equal(pluginRows.length, DEFAULT_CORE_SCHEMAS.length);
    assert.deepEqual(
      pluginRows.map((row) => row.path).sort(),
      [...DEFAULT_CORE_SCHEMAS].sort()
    );

    await worker.installDefaultPlugins();
    const { data: plugins2 } = await worker.query('select path from plugin');
    assert.equal(plugins2.length, pluginRows.length, 'no duplicate plugin rows');
  } finally {
    await worker.destroy();
  }
});

test('installDefaultPlugins respects warehouse default_stack setting', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installDefaultPlugins();
    const { data: pluginRows } = await worker.query({
      sql: 'select id from plugin where path=?',
      values: ['@engine9/schemas/plugin']
    });
    assert.ok(pluginRows[0]?.id);
    await worker.setSetting({
      pluginId: pluginRows[0].id,
      name: 'default_stack',
      value: '@engine9/schemas/stacks/standard'
    });
    const r = await worker.installDefaultPlugins();
    assert.equal(r.path, '@engine9/schemas/stacks/standard');
    const { tables } = await worker.tables();
    assert.ok(tables.indexOf('timeline') >= 0, 'expected timeline from standard stack');
    assert.ok(tables.indexOf('transaction') >= 0, 'expected transaction from standard stack');
  } finally {
    await worker.destroy();
  }
});

test('installDefaultPlugins respects utilities/limited-pii exclude_pii setting', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: '@engine9/schemas/utilities/limited-pii' });
    const { data: coreRows } = await worker.query({
      sql: 'select id from plugin where path=?',
      values: ['@engine9/schemas/plugin']
    });
    const { data: limitedRows } = await worker.query({
      sql: 'select id from plugin where path=?',
      values: ['@engine9/schemas/utilities/limited-pii']
    });
    assert.ok(coreRows[0]?.id);
    assert.ok(limitedRows[0]?.id);
    await worker.setSetting({
      pluginId: coreRows[0].id,
      name: 'default_stack',
      value: '@engine9/schemas/stacks/standard'
    });
    await worker.setSetting({
      pluginId: limitedRows[0].id,
      name: 'exclude_pii',
      value: true
    });
    const r = await worker.installDefaultPlugins();
    assert.equal(r.path, '@engine9/schemas/stacks/limited-pii');
    await assert.rejects(
      () => worker.install({ path: '@engine9/schemas/stacks/standard' }),
      /exclude_pii/
    );
  } finally {
    await worker.destroy();
  }
});

test('PersonWorker.installStandard is a deprecated alias for installDefaultPlugins', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    const r = await worker.installStandard();
    assert.equal(r.complete, true);
    assert.deepEqual(r.installed, DEFAULT_CORE_SCHEMAS);
  } finally {
    await worker.destroy();
  }
});
