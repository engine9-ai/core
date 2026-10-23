/*
  The first admin on a deployed site (Cloudflare D1 has no connection string a
  Node process can open): `e9core segment add --url` posts to POST
  /auth/segments, which creates the standard admin row with an admin key, and
  GET /admin/segments[/:id/members] are the reads PL-3 and PL-6 are checked
  with. The database is what `e9core setup --remote` loads: the person schemas,
  the website plugin row, no segment rows.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { roleSegmentId, rolesPluginId } from '../auth/roles.js';
import { callSite, siteEndpoint } from '../bin/upgrade.js';
import { ensurePluginRow } from './helpers/applySchemas.js';

const ACCOUNT = 'my-site';

async function newSite() {
  const worker = new PersonWorker({ accountId: ACCOUNT, auth: { database_connection: 'sqlite://:memory:' } });
  await worker.installDefaultPlugins();
  const pluginId = getPluginUUID(ACCOUNT, 'website');
  await ensurePluginRow(worker, { id: pluginId, path: 'website', name: ACCOUNT });
  const keyStore = new SqlApiKeyStore({ worker });
  await keyStore.deploy();
  const { key: adminKey } = await keyStore.create({ name: 'admin', scopes: ['admin'] });
  const { key: writeKey } = await keyStore.create({ name: 'site', scopes: ['people:write', 'tables:write'] });
  // config.roles is empty, as in cloudflare/worker.js
  const api = createApi({ worker, keyStore, config: { pluginId } });
  const fetchImpl = (url, init) => api.handleFetch(new Request(url, init));
  const site = (key, method, route, body) => callSite({ url: 'https://www.example.com', key, method, route, body, fetchImpl });
  return { worker, adminKey, writeKey, site };
}

test('segment add --url makes the first admin on a database with no admin segment', async () => {
  const { worker, adminKey, writeKey, site } = await newSite();
  try {
    const adminId = roleSegmentId(ACCOUNT, 'admin');
    const before = await site(adminKey, 'GET', '/admin/segments');
    assert.deepEqual(before.segments, []);
    assert.deepEqual(before.missing_roles, ['admin']);
    assert.equal(before.account_id, ACCOUNT);

    await assert.rejects(
      site(writeKey, 'POST', '/auth/segments', { add: [{ segment_id: 'admin', email: 'owner@example.com' }] }),
      /answered 401: changing other people requires a session or admin scope/
    );
    await assert.rejects(site(writeKey, 'GET', '/admin/segments'), /answered 403/);
    const { data: none } = await worker.query({ sql: 'select id from segment where id=?', values: [adminId] });
    assert.equal(none.length, 0, 'a refused request creates nothing');

    const added = await site(adminKey, 'POST', '/auth/segments', {
      add: [{ segment_id: 'admin', email: ' Owner@Example.com ' }]
    });
    assert.equal(added.add[0].segment_id, adminId, 'the role name resolves with the site account id');

    const listed = await site(adminKey, 'GET', '/admin/segments');
    assert.deepEqual(listed.missing_roles, []);
    const row = listed.segments.find((s) => s.id === adminId);
    assert.equal(row.role, 'admin');
    assert.equal(row.join_min_level, null);
    assert.equal(row.leave_min_level, null);
    assert.equal(row.manager_role_id, null);
    const { data: plugin } = await worker.query({ sql: 'select path from plugin where id=?', values: [rolesPluginId(ACCOUNT)] });
    assert.equal(plugin[0].path, 'roles');

    const members = await site(adminKey, 'GET', '/admin/segments/admin/members');
    assert.equal(members.segment_id, adminId);
    assert.deepEqual(members.members.map((m) => m.emails), [['owner@example.com']]);
    const byId = await site(adminKey, 'GET', `/admin/segments/${adminId}/members`);
    assert.deepEqual(byId.members, members.members);

    await site(adminKey, 'POST', '/auth/segments', { add: [{ segment_id: 'admin', email: 'owner@example.com' }] });
    assert.equal((await site(adminKey, 'GET', '/admin/segments/admin/members')).members.length, 1, 'adding twice is one member');

    await site(adminKey, 'POST', '/auth/segments', { remove: [{ segment_id: 'admin', email: 'owner@example.com' }] });
    assert.deepEqual((await site(adminKey, 'GET', '/admin/segments/admin/members')).members, []);
  } finally {
    await worker.destroy();
  }
});

test('an unknown segment is still refused, and no standard row is created alongside it', async () => {
  const { worker, adminKey, site } = await newSite();
  try {
    await assert.rejects(
      site(adminKey, 'POST', '/auth/segments', {
        add: [
          { segment_id: 'admin', email: 'owner@example.com' },
          { segment_id: '00000000-0000-4000-8000-00000000abcd', email: 'owner@example.com' }
        ]
      }),
      /answered 403: unknown segment/
    );
    const { data } = await worker.query('select id from segment');
    assert.equal(data.length, 0);
  } finally {
    await worker.destroy();
  }
});

test('siteEndpoint keeps an /api base', () => {
  assert.equal(siteEndpoint('https://www.example.com', '/admin/segments'), 'https://www.example.com/api/admin/segments');
  assert.equal(siteEndpoint('https://x.test/api/', '/auth/segments'), 'https://x.test/api/auth/segments');
});
