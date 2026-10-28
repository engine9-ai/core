/*
  PluginWorker.upgrade (lib/upgrades) running the upgrades @engine9/schemas
  declares (person/upgrades.js, plugin/upgrades.js): accounts created before
  @engine9/schemas/person_name get their names copied into person_name, through
  the worker, POST /admin/upgrade, and the e9core upgrade --url client. The
  person columns are dropped only with drop_name_columns. The upgrade machinery
  itself is test/pluginUpgrades.test.js.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { installDefaultPluginsSite, upgradeEndpoint, upgradeSite } from '../bin/upgrade.js';
import { ensurePluginRow } from './helpers/applySchemas.js';
import { enableExcludePii, makeLegacyPersonNames, personColumns } from './helpers/legacyPersonNames.js';
import appendName from '@engine9/schemas/person_name/transforms/outbound/appendName.js';

const PERSON_NAME = '@engine9/schemas/person_name';

function newWorker() {
  return new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
}

async function addSite(worker, name) {
  const pluginId = getPluginUUID('engine9.test', name);
  await ensurePluginRow(worker, { id: pluginId, path: name, name });
  return pluginId;
}

const signup = (worker, pluginId, batch) =>
  worker.processPeople({ pluginId, remoteInputId: 'signup', inputType: 'api', batch });

test('upgrade copies person names into person_name, keeps the person columns, and re-weaves inbound names', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker);
    const pluginId = await addSite(worker, 'legacy-site');

    // Old snapshot, new code: names still land on person until the upgrade runs.
    const before = await signup(worker, pluginId, [
      { email: 'ada@example.com', given_name: 'Ada', family_name: 'Lovelace' },
      { email: 'grace@example.com', given_name: 'Grace', family_name: null },
      { email: 'nameless@example.com', given_name: '', family_name: '' }
    ]);
    const [adaId, graceId, namelessId] = before.personIds;
    const { data: legacyRows } = await worker.query('select id, given_name from person where given_name is not null');
    assert.equal(legacyRows.length, 2, 'the legacy upsertPerson step still writes person names');

    const plan = await worker.upgrade({ dry_run: true });
    const dry = plan.upgrades.find((u) => u.id === 'person_name');
    assert.equal(dry.status, 'pending');
    assert.equal(dry.since, '1.10.1');
    assert.ok(plan.refresh.plugins.includes('@engine9/schemas/stacks/standard'));
    assert.equal(dry.pii_free, false);
    assert.equal(dry.people_with_names, 2);
    assert.deepEqual(dry.person_columns, ['given_name', 'family_name']);
    assert.ok((await personColumns(worker)).includes('given_name'), 'dry run changed nothing');
    assert.ok(!(await worker.tables()).tables.includes('person_name'));

    const { ok, upgrades } = await worker.upgrade();
    assert.equal(ok, true);
    const done = upgrades.find((u) => u.id === 'person_name');
    assert.equal(done.status, 'applied');
    assert.equal(done.copied, 2);
    assert.equal(done.dropped, undefined);
    const drop = upgrades.find((u) => u.id === 'person_name_columns');
    assert.equal(drop.status, 'opt_in');
    assert.equal(drop.opt_in, 'drop_name_columns');

    assert.deepEqual(await personColumns(worker), ['id', 'created_at', 'modified_at', 'given_name', 'family_name']);
    const { data: names } = await worker.query(
      'select person_id, given_name, family_name, created_at from person_name order by person_id'
    );
    assert.deepEqual(
      names.map(({ person_id, given_name, family_name }) => ({ person_id, given_name, family_name })),
      [
        { person_id: adaId, given_name: 'Ada', family_name: 'Lovelace' },
        { person_id: graceId, given_name: 'Grace', family_name: null }
      ]
    );
    assert.ok(names.every((n) => n.created_at), 'copied rows keep a timestamp');
    assert.ok(!names.some((n) => n.person_id === namelessId), 'people with no name get no row');

    const { data: rows } = await worker.query({
      sql: 'select path, transforms from plugin where path in (?, ?) order by path',
      values: ['@engine9/schemas/person', PERSON_NAME]
    });
    assert.deepEqual(JSON.parse(rows[0].transforms), { inbound: { normalize: ['normalizeFieldNames'] } });
    assert.deepEqual(JSON.parse(rows[1].transforms), { inbound: { upsert: ['upsertPersonName'] } });

    const described = await worker.getInboundTransforms({ pluginId, describe: true });
    assert.match(described, /^upsert {4}woven {2}@engine9\/schemas\/person_name:transforms:upsertPersonName$/m);
    assert.doesNotMatch(described, /upsertPerson\b/);

    await signup(worker, pluginId, [
      { email: 'grace@example.com', family_name: 'Hopper' },
      { email: 'new@example.com', given_name: 'Newt' }
    ]);
    const { data: after } = await worker.query('select person_id, given_name, family_name from person_name');
    assert.equal(after.length, 3);
    assert.deepEqual(
      after.find((n) => n.person_id === graceId),
      { person_id: graceId, given_name: 'Grace', family_name: 'Hopper' },
      'a later load updates the copied row'
    );

    const again = (await worker.upgrade()).upgrades.find((u) => u.id === 'person_name');
    assert.equal(again.status, 'current', 're-run finds nothing to move');
    const { data: ledger } = await worker.query("select name from setting where name like 'upgrade.%'");
    assert.deepEqual(ledger, [], 'upgrades keep no rows in setting');
    const { data: stale } = await worker.query({ sql: 'select family_name from person where id=?', values: [graceId] });
    assert.equal(stale[0].family_name, null, 'later loads no longer write the person columns');

    const dryDrop = (await worker.upgrade({ dry_run: true, drop_name_columns: true })).upgrades.find((u) => u.id === 'person_name_columns');
    assert.equal(dryDrop.status, 'pending');
    assert.deepEqual(dryDrop.plan.slice(-2), ['drop person.given_name', 'drop person.family_name']);
    const dropped = (await worker.upgrade({ drop_name_columns: true })).upgrades.find((u) => u.id === 'person_name_columns');
    assert.equal(dropped.status, 'applied');
    assert.deepEqual(dropped.dropped, ['person.given_name', 'person.family_name']);
    assert.deepEqual(await personColumns(worker), ['id', 'created_at', 'modified_at']);
    assert.equal((await worker.upgrade()).upgrades.find((u) => u.id === 'person_name_columns').status, 'current');
  } finally {
    await worker.destroy();
  }
});

test('drop_name_columns on a fresh legacy account copies first, then drops', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker);
    const pluginId = await addSite(worker, 'one-pass-site');
    await signup(worker, pluginId, [{ email: 'ada@example.com', given_name: 'Ada' }]);
    const { ok, upgrades } = await worker.upgrade({ drop_name_columns: true });
    assert.equal(ok, true);
    assert.equal(upgrades.find((u) => u.id === 'person_name').copied, 1);
    assert.deepEqual(upgrades.find((u) => u.id === 'person_name_columns').dropped, ['person.given_name', 'person.family_name']);
    const { data } = await worker.query('select given_name from person_name');
    assert.deepEqual(data, [{ given_name: 'Ada' }]);
  } finally {
    await worker.destroy();
  }
});

test('upgrade finishes a partial run without overwriting newer person_name rows', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker);
    const pluginId = await addSite(worker, 'partial-site');
    const { personIds } = await signup(worker, pluginId, [{ email: 'ada@example.com', given_name: 'Ada' }]);
    await worker.install({ path: PERSON_NAME, unique: true });
    await worker.query({
      sql: 'insert into person_name (person_id, given_name) values (?, ?)',
      values: [personIds[0], 'Augusta']
    });
    const done = (await worker.upgrade()).upgrades.find((u) => u.id === 'person_name');
    assert.equal(done.status, 'current', 'every name on person already has a person_name row');
    const { data } = await worker.query('select given_name from person_name');
    assert.deepEqual(data, [{ given_name: 'Augusta' }]);
    const described = await worker.getInboundTransforms({ pluginId, describe: true });
    assert.doesNotMatch(described, /upsertPerson\b/, 'the refresh step re-weaves the person snapshot');
    assert.ok((await personColumns(worker)).includes('given_name'));
  } finally {
    await worker.destroy();
  }
});

test('PII-free account: dropping the columns refuses to discard names unless asked, never installs person_name', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker, { stack: '@engine9/schemas/stacks/limited-pii', excludePii: true });
    const pluginId = await addSite(worker, 'pii-free-site');
    await signup(worker, pluginId, [{ email: 'ada@example.com', given_name: 'Ada' }]);

    const plain = await worker.upgrade();
    assert.equal(plain.ok, true);
    assert.equal(plain.upgrades.find((u) => u.id === 'person_name').status, 'current', 'a PII-free account has nothing to copy');
    assert.equal(plain.upgrades.find((u) => u.id === 'person_name_columns').status, 'opt_in');
    assert.ok((await personColumns(worker)).includes('given_name'), 'the default upgrade drops nothing');

    const dryRun = await worker.upgrade({ dry_run: true, drop_name_columns: true });
    const dry = dryRun.upgrades.find((u) => u.id === 'person_name_columns');
    assert.equal(dryRun.ok, false);
    assert.equal(dry.status, 'blocked');
    assert.equal(dry.pii_free, true);
    assert.match(dry.blocked, /discard_names/);
    await assert.rejects(worker.upgrade({ drop_name_columns: true }), /PII-free.*discard_names/);
    assert.ok((await personColumns(worker)).includes('given_name'), 'a refused upgrade drops nothing');

    const done = (await worker.upgrade({ drop_name_columns: true, discard_names: true })).upgrades.find((u) => u.id === 'person_name_columns');
    assert.deepEqual(done.dropped, ['person.given_name', 'person.family_name']);
    assert.deepEqual(await personColumns(worker), ['id', 'created_at', 'modified_at']);
    assert.ok(!(await worker.tables()).tables.includes('person_name'));
    assert.ok(!(await worker.list()).some((row) => row.path === PERSON_NAME));

    const described = await worker.getInboundTransforms({ pluginId, describe: true });
    assert.doesNotMatch(described, /person_name|upsertPerson\b/);
    await signup(worker, pluginId, [{ email: 'grace@example.com', given_name: 'Grace' }]);

    // Saved export definitions still call appendName; with no person_name table it appends nulls.
    const batch = [{ person_id: 1 }];
    const { boundItems } = await worker.resolveBindings({ bindings: appendName.bindings, path: 'appendName', batch });
    appendName.transform({ batch, ...boundItems });
    assert.deepEqual(batch, [{ person_id: 1, given_name: null, family_name: null }]);
  } finally {
    await worker.destroy();
  }
});

test('limited-pii stack without exclude_pii is not PII-free for upgrade', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker, { stack: '@engine9/schemas/stacks/limited-pii' });
    const dry = (await worker.upgrade({ dry_run: true, drop_name_columns: true })).upgrades.find(
      (u) => u.id === 'person_name_columns'
    );
    assert.equal(dry.pii_free, false, 'stack alone does not set pii_free');
    await enableExcludePii(worker);
    const after = (await worker.upgrade({ dry_run: true, drop_name_columns: true })).upgrades.find(
      (u) => u.id === 'person_name_columns'
    );
    assert.equal(after.pii_free, true, 'exclude_pii sets pii_free');
  } finally {
    await worker.destroy();
  }
});

test('PII-free account with empty name columns: drop_name_columns drops them without discard_names', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker, { stack: '@engine9/schemas/stacks/limited-pii', excludePii: true });
    const done = (await worker.upgrade({ drop_name_columns: true })).upgrades.find((u) => u.id === 'person_name_columns');
    assert.deepEqual(done.dropped, ['person.given_name', 'person.family_name']);
  } finally {
    await worker.destroy();
  }
});

test('person table without the person plugin row: upgrade is blocked and changes nothing', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker);
    await worker.query("delete from plugin where path='@engine9/schemas/person'");

    const dry = (await worker.upgrade({ dry_run: true })).upgrades.find((u) => u.id === 'person_name');
    assert.equal(dry.status, 'blocked');
    assert.equal(dry.person_plugin_installed, false);
    await assert.rejects(worker.upgrade(), /plugin is not installed/);
    assert.ok((await personColumns(worker)).includes('given_name'));
    assert.ok(!(await worker.tables()).tables.includes('person_name'));
  } finally {
    await worker.destroy();
  }
});

test('person as a view over an older table: upgrade is blocked and changes nothing', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker);
    await worker.query('create table legacy_person (id integer primary key, given_name text, family_name text)');
    await worker.query("insert into legacy_person values (1, 'Ada', 'Lovelace')");
    await worker.drop({ table: 'person' });
    await worker.query('create view person as select id, given_name, family_name from legacy_person');

    const dryRun = await worker.upgrade({ dry_run: true });
    const dry = dryRun.upgrades.find((u) => u.id === 'person_name');
    assert.equal(dryRun.ok, false);
    assert.equal(dry.status, 'blocked');
    assert.equal(dry.person_is_view, true);
    assert.match(dry.blocked, /person is a view/);
    await assert.rejects(worker.upgrade(), /person is a view/);
    assert.equal(await worker.tableType({ table: 'person' }), 'view');
    assert.ok(!(await worker.tables()).tables.includes('person_name'), 'a blocked upgrade installs nothing');
  } finally {
    await worker.destroy();
  }
});

test('upgrade refresh deploys new columns, new stack includes, and inbound snapshots on a current account', async () => {
  const worker = newWorker();
  try {
    await worker.installDefaultPlugins({ path: '@engine9/schemas/stacks/standard' });
    // Stand-ins for an older @engine9/schemas: a column the new schema adds,
    // a plugin the stack now includes, and a stale snapshot.
    await worker.query('alter table person_email drop column subscription_status');
    await worker.query("delete from plugin where path='@engine9/schemas/person_phone'");
    await worker.query("update plugin set transforms='{}' where path='@engine9/schemas/person_address'");

    const done = await worker.upgrade();
    assert.equal(done.ok, true);
    assert.equal(done.upgrades.find((u) => u.id === 'person_name').status, 'current');
    assert.deepEqual(done.refresh.failed, []);
    assert.ok(done.refresh.plugins.includes('@engine9/schemas/person_phone'));
    const { columns } = await worker.describe({ table: 'person_email' });
    assert.ok(columns.some((c) => c.name === 'subscription_status'));
    assert.ok((await worker.list()).some((row) => row.path === '@engine9/schemas/person_phone'));
    const { data } = await worker.query("select transforms from plugin where path='@engine9/schemas/person_address'");
    assert.deepEqual(JSON.parse(data[0].transforms).inbound, { upsert: ['upsertPersonAddress'] });

    const skipped = await worker.upgrade({ refresh: false });
    assert.equal(skipped.refresh.skipped, true);
  } finally {
    await worker.destroy();
  }
});

test('upgrade widens setting.value from varchar(255) to text', async () => {
  const worker = newWorker();
  try {
    // Pre-1.11.2 plugin schema: value is string (varchar 255), not text.
    await worker.deploy({
      schema: {
        tables: [
          {
            name: 'plugin',
            columns: {
              id: 'id_uuid',
              path: 'string',
              name: 'string',
              nickname: 'string',
              table_prefix: 'string',
              remote_plugin_id: 'string',
              schema: 'json',
              transforms: 'json',
              created_at: 'created_at',
              modified_at: 'modified_at'
            },
            indexes: [
              { columns: 'id', primary: true },
              { columns: 'remote_plugin_id', unique: true }
            ]
          },
          {
            name: 'setting',
            columns: {
              id: 'id_uuid',
              plugin_id: 'foreign_uuid',
              name: 'string',
              value: 'string',
              created_at: 'created_at',
              modified_at: 'modified_at'
            },
            indexes: [
              { columns: 'id', primary: true },
              { columns: 'plugin_id,name', unique: true }
            ]
          }
        ]
      }
    });
    const coreId = '00000000-0000-4000-a000-0000000000c0';
    await ensurePluginRow(worker, {
      id: coreId,
      path: '@engine9/schemas/plugin',
      name: 'plugin'
    });
    const fields = Array.from({ length: 8 }, (_, i) => `cons_email_address.lifetime_gift_amount_${i}`);
    const longValue = JSON.stringify(fields);
    assert.ok(longValue.length > 255, 'repro value must exceed varchar(255)');

    const before = (await worker.describe({ table: 'setting' })).columns.find((c) => c.name === 'value');
    assert.equal(before.type, 'string');
    assert.equal(before.length, 255);

    const dry = (await worker.upgrade({ dry_run: true, refresh: false })).upgrades.find(
      (u) => u.id === 'setting_value_text'
    );
    assert.equal(dry.status, 'pending');
    assert.equal(dry.since, '1.11.2');
    assert.deepEqual(dry.plan, ['rebuild setting with value as text']);

    const done = (await worker.upgrade({ refresh: false })).upgrades.find((u) => u.id === 'setting_value_text');
    assert.equal(done.status, 'applied');

    const after = (await worker.describe({ table: 'setting' })).columns.find((c) => c.name === 'value');
    // SQLite dialectToStandard maps TEXT → type string + column_type text + length 65535
    assert.equal(after.column_type, 'text');
    assert.ok(Number(after.length) > 255);

    // stringToType slices to column length; after the widen, long JSON must round-trip.
    await worker.setSetting({ pluginId: coreId, name: 'people_custom_fields', value: longValue });
    const { data } = await worker.query({
      sql: 'select value from setting where name=?',
      values: ['people_custom_fields']
    });
    assert.equal(data[0].value, longValue);
    assert.equal(JSON.parse(data[0].value).length, 8);

    const again = (await worker.upgrade({ refresh: false })).upgrades.find((u) => u.id === 'setting_value_text');
    assert.equal(again.status, 'current');
  } finally {
    await worker.destroy();
  }
});

test('POST /admin/upgrade needs admin scope; e9core upgrade --url posts to it', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker);
    const pluginId = await addSite(worker, 'website');
    await signup(worker, pluginId, [{ email: 'ada@example.com', given_name: 'Ada' }]);
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: adminKey } = await keyStore.create({ name: 'admin', scopes: ['admin'] });
    const { key: writeKey } = await keyStore.create({ name: 'site', scopes: ['people:write', 'tables:write'] });
    const logged = [];
    const audited = [];
    const api = createApi({
      worker,
      keyStore,
      logger: { log: (e) => logged.push(e), flush: async () => {} },
      audit: { log: (e) => audited.push(e), flush: async () => {} },
      config: { pluginId }
    });

    const denied = await api.handle({
      method: 'POST',
      path: '/admin/upgrade',
      headers: { authorization: `Bearer ${writeKey}` },
      body: {}
    });
    assert.equal(denied.status, 403);

    const dry = await api.handle({
      method: 'POST',
      path: '/admin/upgrade',
      headers: { authorization: `Bearer ${adminKey}` },
      body: { dry_run: true }
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.upgrades.find((u) => u.id === 'person_name').status, 'pending');
    assert.equal(audited.length, 0, 'a dry run is not audited');

    assert.equal(upgradeEndpoint('https://www.example.com'), 'https://www.example.com/api/admin/upgrade');
    assert.equal(upgradeEndpoint('https://x.test/api/'), 'https://x.test/api/admin/upgrade');
    const result = await upgradeSite({
      url: 'https://www.example.com',
      key: adminKey,
      fetchImpl: (url, init) => api.handleFetch(new Request(url, init))
    });
    assert.equal(result.upgrades.find((u) => u.id === 'person_name').copied, 1);
    assert.deepEqual(audited.filter((e) => e.action === 'upgrade').length, 1);
    assert.ok(audited.find((e) => e.action === 'upgrade').apiKeyId, 'the record names the key that ran it');
    assert.ok(audited.some((e) => e.action === 'plugin.install' && e.meta.path === '@engine9/schemas/person_name' && e.meta.trigger === 'upgrade'));
    assert.deepEqual(logged, [], 'admin actions never go to the data log');
    await assert.rejects(
      upgradeSite({
        url: 'https://www.example.com',
        key: writeKey,
        fetchImpl: (url, init) => api.handleFetch(new Request(url, init))
      }),
      /answered 403/
    );
  } finally {
    await worker.destroy();
  }
});

test('POST /admin/install-default-plugins needs admin scope and installs over --url', async () => {
  const worker = newWorker();
  try {
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: adminKey } = await keyStore.create({ name: 'admin', scopes: ['admin'] });
    const { key: writeKey } = await keyStore.create({ name: 'site', scopes: ['people:write'] });
    const logged = [];
    const audited = [];
    const api = createApi({
      worker,
      keyStore,
      logger: { log: (e) => logged.push(e), flush: async () => {} },
      audit: { log: (e) => audited.push(e), flush: async () => {} },
      config: {}
    });
    const fetchImpl = (url, init) => api.handleFetch(new Request(url, init));

    await assert.rejects(
      installDefaultPluginsSite({ url: 'https://www.example.com', key: writeKey, fetchImpl }),
      /answered 403/
    );
    const result = await installDefaultPluginsSite({
      url: 'https://www.example.com',
      key: adminKey,
      path: '@engine9/schemas/stacks/standard',
      fetchImpl
    });
    assert.equal(result.complete, true);
    assert.equal(result.path, '@engine9/schemas/stacks/standard');
    assert.ok((await worker.tables()).tables.includes('person_email'));
    assert.deepEqual(audited.filter((e) => e.action === 'plugins.install_default').length, 1);
    const installs = audited.filter((e) => e.action === 'plugin.install');
    assert.ok(installs.length > 0 && installs.every((e) => e.meta.trigger === 'install_default' && e.meta.status === 'ok'));
    assert.deepEqual(logged, [], 'admin actions never go to the data log');
  } finally {
    await worker.destroy();
  }
});

test('drop_plugin_history: opt-in, drops an empty plugin_history, refuses while it has rows', async () => {
  const worker = newWorker();
  try {
    await worker.installDefaultPlugins();
    const tables = async () => (await worker.tables()).tables;
    assert.ok(!(await tables()).includes('plugin_history'), '@engine9/schemas no longer creates it');
    await worker.query('create table plugin_history (id char(36) primary key, plugin_id char(36), path varchar(255))');
    await worker.query("insert into plugin_history (id, plugin_id, path) values ('a', 'b', 'c')");

    const step = (result) => result.upgrades.find((u) => u.id === 'plugin_history');
    assert.equal(step(await worker.upgrade({ dry_run: true })).status, 'opt_in');
    assert.equal(step(await worker.upgrade({})).status, 'opt_in', 'a normal upgrade leaves it');
    assert.ok((await tables()).includes('plugin_history'));

    const blocked = step(await worker.upgrade({ dry_run: true, drop_plugin_history: true }));
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.blocked, /1 row\. Nothing in core wrote them/);
    await assert.rejects(worker.upgrade({ drop_plugin_history: true }), /plugin_history has 1 row/);
    assert.ok((await tables()).includes('plugin_history'), 'a refused drop changes nothing');

    await worker.query('delete from plugin_history');
    const dropped = step(await worker.upgrade({ drop_plugin_history: true }));
    assert.equal(dropped.status, 'applied');
    assert.deepEqual(dropped.dropped, ['plugin_history']);
    assert.ok(!(await tables()).includes('plugin_history'));
    assert.equal(step(await worker.upgrade({ drop_plugin_history: true })).status, 'current', 'safe to re-run');
  } finally {
    await worker.destroy();
  }
});

test('each real upgrade run is one audit record naming the plugin and upgrade it applied', async () => {
  const audited = [];
  const worker = newWorker();
  worker.audit = { log: async (r) => audited.push(r), flush: async () => {} };
  try {
    await worker.installDefaultPlugins();
    await worker.query('create table plugin_history (id char(36) primary key, plugin_id char(36), path varchar(255))');
    await worker.upgrade({ dry_run: true, drop_plugin_history: true });
    assert.equal(audited.filter((r) => r.action === 'upgrade').length, 0, 'a dry run is not audited');

    await worker.upgrade({ drop_plugin_history: true, actor: { by: 'cli' } });
    const [record] = audited.filter((r) => r.action === 'upgrade');
    assert.equal(record.by, 'cli');
    assert.deepEqual(record.meta.upgrades, [{ plugin: '@engine9/schemas/plugin', id: 'plugin_history' }]);
    assert.ok(record.meta.refreshed.includes('@engine9/schemas/plugin'));

    await worker.upgrade({});
    const records = audited.filter((r) => r.action === 'upgrade');
    assert.equal(records.length, 2);
    assert.deepEqual(records[1].meta.upgrades, [], 'a run with nothing to apply is still recorded');
  } finally {
    await worker.destroy();
  }
});
