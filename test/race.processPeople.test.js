import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';

async function withWorker(fn) {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'race');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
    await fn(worker, pluginId);
  } finally {
    await worker.destroy();
  }
}

function signIn(worker, pluginId, record) {
  return worker.processPeople({ pluginId, remoteInputId: 'race', inputType: 'api', batch: [record] });
}

const unid = (n) => `site.example.com:${n.toString(16).padStart(64, '0')}`;

test('concurrent first sign-ins for one new email make one person', async () => {
  await withWorker(async (worker, pluginId) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => signIn(worker, pluginId, { email: 'race@example.com', delegate_id: unid(i + 1) }))
    );
    const personIds = new Set(results.map((r) => r.personIds[0]));
    assert.equal(personIds.size, 1, 'every request answers with the same person');
    const [personId] = personIds;
    const { data: people } = await worker.query('select id from person');
    assert.deepEqual(people.map((p) => p.id), [personId], 'no orphan person rows');
    const { data: emails } = await worker.query("select person_id from person_email where email='race@example.com'");
    assert.deepEqual(emails.map((e) => e.person_id), [personId]);
    const { data: delegates } = await worker.query('select distinct person_id from person_id_delegate');
    assert.deepEqual(delegates.map((d) => d.person_id), [personId], 'each UNID points at the surviving person');

    const later = await signIn(worker, pluginId, { delegate_id: unid(5) });
    assert.equal(later.personIds[0], personId, 'a losing request\'s UNID still finds the person later');
  });
});

test('the same sign-in from two tabs makes one person', async () => {
  await withWorker(async (worker, pluginId) => {
    const record = { email: 'tabs@example.com', delegate_id: unid(42) };
    const results = await Promise.all([signIn(worker, pluginId, { ...record }), signIn(worker, pluginId, { ...record })]);
    assert.equal(results[0].personIds[0], results[1].personIds[0]);
    const { data: people } = await worker.query('select id from person');
    assert.equal(people.length, 1);
  });
});
