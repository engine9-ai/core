import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore, API_KEY_SCHEMA, hashApiKey } from '../auth/index.js';
import { BatchLogger } from '../logging/index.js';
import { createApi } from '../api/index.js';
import { getPluginUUID, getVersionedUUID } from '../lib/ids.js';

test('client API: auth, people POST, table upsert, segment-gated reads, modification log', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installStandard();
    const pluginId = getPluginUUID('engine9.test', 'website');
    await worker.install({ type: 'local', id: pluginId, path: 'website', name: 'Website' });

    // auth store
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key, id: keyId } = await keyStore.create({ name: 'site', scopes: [] });
    assert.ok(key.indexOf('e9k_') === 0);
    const { data: stored } = await worker.query('select key_hash from api_key');
    assert.equal(stored[0].key_hash, hashApiKey(key), 'only the hash is stored');

    const logged = [];
    const logger = new BatchLogger({ sink: (records) => logged.push(...records), maxRecords: 1000 });

    // a segment plus gated content table for reads
    const segmentId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [{ id: segmentId, plugin_id: pluginId, name: 'Members', build_type: 'list' }]
    });
    await worker.createTable({
      table: 'member_content',
      columns: [
        { name: 'id', type: 'id' },
        { name: 'title', type: 'string' },
        { name: 'body', type: 'text' }
      ],
      indexes: [{ columns: ['id'], primary: true }]
    });
    await worker.insertArray({ table: 'member_content', array: [{ title: 'Hello', body: 'Members only' }] });

    const api = createApi({
      worker,
      keyStore,
      logger,
      config: {
        pluginId,
        upsertTables: ['person_email', 'person_segment'],
        reads: {
          content: { table: 'member_content', segmentId, columns: ['id', 'title', 'body'] },
          open: { table: 'member_content', columns: ['id', 'title'] }
        }
      }
    });

    const headers = { authorization: `Bearer ${key}` };

    // health, no auth
    const ok = await api.handle({ method: 'GET', path: '/ok' });
    assert.equal(ok.status, 200);

    // unauthorized without a key
    const noAuth = await api.handle({ method: 'POST', path: '/people', body: { people: [{}] }, headers: {} });
    assert.equal(noAuth.status, 401);

    // POST /people
    const created = await api.handle({
      method: 'POST',
      path: '/people',
      headers,
      body: { people: [{ email: 'carol@example.com', given_name: 'Carol' }] }
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const [carolId] = created.body.personIds;
    assert.ok(carolId > 0);

    // POST /upsert/person_segment (event-attendance style upsert)
    const upserted = await api.handle({
      method: 'POST',
      path: '/upsert/person_segment',
      headers,
      body: { rows: [{ segment_id: segmentId, person_id: carolId }] }
    });
    assert.equal(upserted.status, 200, JSON.stringify(upserted.body));

    // disallowed table
    const badTable = await api.handle({
      method: 'POST',
      path: '/upsert/plugin',
      headers,
      body: { rows: [{ id: 'x' }] }
    });
    assert.equal(badTable.status, 403);

    // GET /read/content -- gated
    const noPerson = await api.handle({ method: 'GET', path: '/read/content', headers, query: {} });
    assert.equal(noPerson.status, 401, 'segment-gated content requires person_id');
    const outsider = await api.handle({
      method: 'GET',
      path: '/read/content',
      headers,
      query: { person_id: '999999' }
    });
    assert.equal(outsider.status, 403, 'non-member is rejected');
    const member = await api.handle({
      method: 'GET',
      path: '/read/content',
      headers,
      query: { person_id: String(carolId) }
    });
    assert.equal(member.status, 200, JSON.stringify(member.body));
    assert.equal(member.body.data[0].title, 'Hello');

    // ungated read works without person_id
    const open = await api.handle({ method: 'GET', path: '/read/open', headers, query: {} });
    assert.equal(open.status, 200);

    // modification log captured both writes
    await logger.flush();
    const actions = logged.map((l) => l.action);
    assert.deepEqual(actions.sort(), ['people.process', 'table.upsert']);
    assert.ok(logged.every((l) => l.ts && l.accountId === 'test'));

    // revoked key stops working
    await keyStore.revoke({ id: keyId });
    const revoked = await api.handle({ method: 'GET', path: '/read/open', headers, query: {} });
    assert.equal(revoked.status, 401);
  } finally {
    await worker.destroy();
  }
});
