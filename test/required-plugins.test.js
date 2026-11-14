import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { REQUIRED_PLUGINS } from '../lib/requiredPlugins.js';
import { readIdentifierStoreKind } from '../lib/id/storeKind.js';

const CONTACT_EDITION = '@engine9/schemas/editions/contact';
const PII_FREE_EDITION = '@engine9/schemas/editions/pii-free';
const LIMITED_PII_PLUGIN_PATH = '@engine9/schemas/utilities/limited-pii';
const PLAINTEXT_TABLES = ['person_name', 'person_email', 'person_phone', 'person_address'];

const newWorker = () => new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });

async function enableExcludePii(worker) {
  await worker.install({ path: LIMITED_PII_PLUGIN_PATH, unique: true });
  const { data } = await worker.query({ sql: 'select id from plugin where path=? limit 1', values: [LIMITED_PII_PLUGIN_PATH] });
  await worker.setSetting({ pluginId: data[0].id, name: 'exclude_pii', value: true });
}

test('the required plugins are slim: no plaintext contact plugin, nothing a PII-free account refuses', () => {
  assert.deepEqual(REQUIRED_PLUGINS, [
    '@engine9/schemas/plugin',
    '@engine9/schemas/person',
    '@engine9/schemas/segment',
    '@engine9/schemas/source_code'
  ]);
  assert.ok(Object.isFrozen(REQUIRED_PLUGINS));
});

test('installRequiredPlugins installs the required plugins and nothing else', async () => {
  const worker = newWorker();
  try {
    const r = await worker.installRequiredPlugins();
    assert.equal(r.complete, true);
    assert.deepEqual(r.installed, [...REQUIRED_PLUGINS]);
    const { tables } = await worker.tables();
    for (const t of ['plugin', 'setting', 'person', 'segment', 'person_segment', 'source_code_dictionary', 'api_key']) {
      assert.ok(tables.includes(t), `expected table ${t}, got ${tables.join(',')}`);
    }
    for (const t of [...PLAINTEXT_TABLES, 'person_remote', 'person_hash_email', 'timeline', 'transaction', 'person_identifier']) {
      assert.ok(!tables.includes(t), `did not expect table ${t} from installRequiredPlugins`);
    }
    assert.equal(await readIdentifierStoreKind(worker), 'compact', 'new accounts use compact person ids');
    const { data: rows } = await worker.query('select path from plugin order by path');
    assert.deepEqual(rows.map((row) => row.path), [...REQUIRED_PLUGINS].sort());

    await worker.installRequiredPlugins();
    const { data: again } = await worker.query('select path from plugin');
    assert.equal(again.length, rows.length, 'no duplicate plugin rows');
  } finally {
    await worker.destroy();
  }
});

test('core keeps no default: installDefaultPlugins and the default_stack setting are gone', async () => {
  const worker = newWorker();
  try {
    assert.equal(worker.installDefaultPlugins, undefined);
    await worker.installRequiredPlugins();
    await assert.rejects(() => worker.install({}), /path is required/);
  } finally {
    await worker.destroy();
  }
});

test('an edition installs on top of the required plugins', async () => {
  const worker = newWorker();
  try {
    await worker.installRequiredPlugins();
    const r = await worker.install({ path: CONTACT_EDITION });
    assert.equal(r.path, CONTACT_EDITION);
    const { tables } = await worker.tables();
    for (const t of [...PLAINTEXT_TABLES, 'timeline', 'transaction']) assert.ok(tables.includes(t), `expected ${t}`);
    assert.ok(!tables.includes('person_hash_email'));
  } finally {
    await worker.destroy();
  }
});

test('exclude_pii refuses a plugin that includes a plaintext contact plugin, before installing anything', async () => {
  const worker = newWorker();
  try {
    await worker.installRequiredPlugins();
    await enableExcludePii(worker);
    const before = (await worker.query('select path from plugin')).data.length;
    await assert.rejects(
      () => worker.install({ path: CONTACT_EDITION }),
      /Cannot install @engine9\/schemas\/person_name \(included by @engine9\/schemas\/editions\/contact\): excluded by plugin setting exclude_pii/
    );
    await assert.rejects(() => worker.install({ path: '@engine9/schemas/person_name' }), /exclude_pii/);
    assert.equal((await worker.query('select path from plugin')).data.length, before, 'nothing was installed');

    // exclude_pii does not choose an edition: the account installs pii-free only when asked.
    assert.ok(!(await worker.tables()).tables.includes('person_hash_email'));
    await worker.install({ path: PII_FREE_EDITION });
    const { tables } = await worker.tables();
    assert.ok(tables.includes('person_hash_email'));
    for (const t of PLAINTEXT_TABLES) assert.ok(!tables.includes(t), `${t} not installed`);
  } finally {
    await worker.destroy();
  }
});

test('the pii-free edition alone does not refuse plaintext plugins', async () => {
  const worker = newWorker();
  try {
    await worker.installRequiredPlugins();
    await worker.install({ path: PII_FREE_EDITION });
    await worker.install({ path: '@engine9/schemas/person_name', unique: true });
    assert.ok((await worker.tables()).tables.includes('person_name'));
  } finally {
    await worker.destroy();
  }
});
