import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';

const unid = (n) => `site.example.com:${n.toString(16).padStart(64, '0')}`;

async function personRows(worker, personId) {
  const out = {};
  const { tables } = await worker.tables({ type: 'table' });
  const idTables = tables.filter((t) => t.startsWith('person_id_'));
  assert.ok(idTables.includes('person_id_delegate') && idTables.length >= 2, `id tables: ${idTables}`);
  for (const table of ['person', 'person_email', ...idTables]) {
    const column = table === 'person' ? 'id' : 'person_id';
    const { data } = await worker.query({ sql: `select count(*) as n from ${table} where ${column}=?`, values: [personId] });
    out[table] = Number(data[0].n);
  }
  return out;
}

test('erasePeople removes one person from every person_id table and leaves others', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'erase');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
    const { personIds: [alexId] } = await worker.processPeople({
      pluginId, remoteInputId: 'erase', inputType: 'api',
      batch: [{ email: 'alex@example.com', given_name: 'Alex', delegate_id: unid(1) }]
    });
    const { personIds: [samId] } = await worker.processPeople({
      pluginId, remoteInputId: 'erase', inputType: 'api',
      batch: [{ email: 'sam@example.com', given_name: 'Sam', delegate_id: unid(2) }]
    });
    assert.notEqual(alexId, samId);

    const before = await personRows(worker, alexId);
    assert.ok(Object.values(before).every((n) => n > 0), `alex has rows everywhere: ${JSON.stringify(before)}`);

    const dry = await worker.erasePeople({ personIds: [alexId], dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.tables.person, 1);
    assert.equal(dry.tables.person_email, 1);
    assert.ok(dry.tables.person_id_delegate >= 1);
    assert.deepEqual(await personRows(worker, alexId), before, 'dry run deletes nothing');

    const result = await worker.erasePeople({
      personIds: [alexId],
      keep: ['person_email']
    });
    assert.equal(result.tables.person, 1);
    assert.equal(result.tables.person_email, undefined, 'kept table is not counted');
    const after = await personRows(worker, alexId);
    assert.equal(after.person_email, 1, 'kept table is untouched');
    for (const [table, n] of Object.entries(after)) {
      if (table !== 'person_email') assert.equal(n, 0, `${table} erased`);
    }

    const sam = await personRows(worker, samId);
    assert.ok(Object.values(sam).every((n) => n > 0), 'sam is untouched');

    const again = await worker.processPeople({
      pluginId, remoteInputId: 'erase', inputType: 'api',
      batch: [{ delegate_id: unid(1) }]
    });
    assert.notEqual(again.personIds[0], alexId, 'the erased UNID no longer finds the old person');

    await assert.rejects(() => worker.erasePeople({ personIds: ['1; drop table person'] }), /positive integers/);
  } finally {
    await worker.destroy();
  }
});

test('POST /admin/erase needs admin and logs only ids and counts', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'erase-api');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: siteKey } = await keyStore.create({ name: 'site', scopes: ['people:write', 'data:read'] });
    const { key: adminKey } = await keyStore.create({ name: 'admin', scopes: ['admin'] });
    const logged = [];
    const api = createApi({
      worker,
      keyStore,
      logger: { log: async (entry) => logged.push(entry), flush: async () => {} },
      config: { pluginId }
    });

    const created = await api.handle({
      method: 'POST',
      path: '/people',
      headers: { authorization: `Bearer ${siteKey}` },
      body: { people: [{ email: 'erase-me@example.com', given_name: 'Erin' }] }
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const personId = created.body.personIds[0];

    const notAdmin = await api.handle({
      method: 'POST', path: '/admin/erase', headers: { authorization: `Bearer ${siteKey}` }, body: { person_ids: [personId] }
    });
    assert.equal(notAdmin.status, 403);

    const dry = await api.handle({
      method: 'POST', path: '/admin/erase', headers: { authorization: `Bearer ${adminKey}` }, body: { person_ids: [personId], dry_run: true }
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.tables.person, 1);
    assert.equal(logged.filter((e) => e.action === 'people.erase').length, 0, 'dry run is not logged');

    const done = await api.handle({
      method: 'POST', path: '/admin/erase', headers: { authorization: `Bearer ${adminKey}` }, body: { person_ids: [personId] }
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const { data } = await worker.query({ sql: 'select count(*) as n from person where id=?', values: [personId] });
    assert.equal(Number(data[0].n), 0);
    const entry = logged.find((e) => e.action === 'people.erase');
    assert.deepEqual(entry.personIds, [personId]);
    assert.ok(!JSON.stringify(entry).includes('erase-me@example.com'), 'no personal data in the log record');

    const bad = await api.handle({
      method: 'POST', path: '/admin/erase', headers: { authorization: `Bearer ${adminKey}` }, body: {}
    });
    assert.equal(bad.status, 422);
  } finally {
    await worker.destroy();
  }
});
