/*
  PluginWorker.upgrade (lib/upgrades): accounts created before
  @engine9/schemas/person_name get their names copied into person_name and the
  columns dropped from person, through the worker, POST /admin/upgrade, and
  the e9core upgrade --url client.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { upgradeEndpoint, upgradeSite } from '../bin/upgrade.js';
import { ensurePluginRow } from './helpers/applySchemas.js';
import { makeLegacyPersonNames, personColumns } from './helpers/legacyPersonNames.js';
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

test('upgrade copies person names into person_name, drops the columns, and re-weaves inbound names', async () => {
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
    assert.equal(dry.recorded, undefined, 'a dry run records nothing');
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
    assert.equal(done.recorded.status, 'applied');
    assert.equal(done.copied, 2);
    assert.deepEqual(done.dropped, ['person.given_name', 'person.family_name']);

    assert.deepEqual(await personColumns(worker), ['id', 'created_at', 'modified_at']);
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
    assert.deepEqual(again.recorded, done.recorded, 'the ledger keeps the first run');
    const { data: ledger } = await worker.query(
      "select s.value from setting s join plugin p on p.id=s.plugin_id where p.path='@engine9/schemas/plugin' and s.name='upgrade.person_name'"
    );
    assert.deepEqual(JSON.parse(ledger[0].value), done.recorded);
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
    assert.equal(done.copied, 0);
    const { data } = await worker.query('select given_name from person_name');
    assert.deepEqual(data, [{ given_name: 'Augusta' }]);
    assert.ok(!(await personColumns(worker)).includes('given_name'));
  } finally {
    await worker.destroy();
  }
});

test('PII-free account: upgrade refuses to discard names unless asked, never installs person_name', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker, { stack: '@engine9/schemas/stacks/limited-pii' });
    const pluginId = await addSite(worker, 'pii-free-site');
    await signup(worker, pluginId, [{ email: 'ada@example.com', given_name: 'Ada' }]);

    const dryRun = await worker.upgrade({ dry_run: true });
    const dry = dryRun.upgrades[0];
    assert.equal(dryRun.ok, false);
    assert.equal(dry.status, 'blocked');
    assert.equal(dry.pii_free, true);
    assert.match(dry.blocked, /discard_names/);
    await assert.rejects(worker.upgrade(), /PII-free.*discard_names/);
    assert.ok((await personColumns(worker)).includes('given_name'), 'a refused upgrade drops nothing');

    const done = (await worker.upgrade({ discard_names: true })).upgrades[0];
    assert.equal(done.copied, 0);
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

test('PII-free account with empty name columns drops them without discard_names', async () => {
  const worker = newWorker();
  try {
    await makeLegacyPersonNames(worker, { stack: '@engine9/schemas/stacks/limited-pii' });
    const done = (await worker.upgrade()).upgrades[0];
    assert.deepEqual(done.dropped, ['person.given_name', 'person.family_name']);
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
    assert.equal(done.upgrades[0].status, 'current');
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
    const api = createApi({ worker, keyStore, logger: { log: (e) => logged.push(e), flush: async () => {} }, config: { pluginId } });

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
    assert.equal(dry.body.upgrades[0].status, 'pending');
    assert.equal(logged.length, 0, 'a dry run is not logged as a modification');

    assert.equal(upgradeEndpoint('https://www.example.com'), 'https://www.example.com/api/admin/upgrade');
    assert.equal(upgradeEndpoint('https://x.test/api/'), 'https://x.test/api/admin/upgrade');
    const result = await upgradeSite({
      url: 'https://www.example.com',
      key: adminKey,
      fetchImpl: (url, init) => api.handleFetch(new Request(url, init))
    });
    assert.equal(result.upgrades[0].copied, 1);
    assert.deepEqual(logged.map((e) => e.action), ['upgrade']);
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
