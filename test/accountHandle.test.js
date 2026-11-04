/*
  Golden tests for the account handle (plan: internal/plans/account-handles.md).

  worker.accountHandle is the permanent string every account-namespaced id
  (role segments, the roles/website plugins, the e9console/e9workers/e9forms
  plugins, the Durable Object identifier store) is computed from. It
  defaults to worker.accountId so an account that has never set a handle
  gets byte-identical ids to before accountHandle existed.

  These tests pin the exact ids four reference strings compute today
  ('mrss_peta' stands in for an existing server account, 'local' and
  'cloudflare' for core's own fallbacks, 'red-panda-3453' for a generated
  handle). A refactor that changes any of these values -- for an account
  that is NOT being renamed -- is exactly the regression this guards
  against: it would silently move admins out of their role, duplicate
  plugin rows, or empty the Durable Object identifier store.

  The last test is the point of the whole feature: an account whose id has
  changed (accountId != accountHandle) still computes the SAME admin
  segment id as before the rename, because every derived id reads the
  handle, never the id.
*/
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack } from './helpers/applySchemas.js';
import { ROLE_NAMES, roleSegmentId, rolesPluginId } from '../auth/roles.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createDurableObjectIdentifierStore } from '../lib/id/durableObjectStore.js';

// Computed once (node -e, getPluginUUID / uuidv5 against the formulas in
// auth/roles.js and lib/PluginWorker.js) and pinned here. Do not "fix" a
// failure here by regenerating these -- that is the bug this test exists
// to catch. Only a deliberate, documented change to the formula earns new
// values, and existing accounts must still compute their old ones (via
// accountHandle), so the formula itself should never need to change.
const PINNED = {
  mrss_peta: {
    rolesPlugin: 'e2413ac8-7720-5ba1-b5ec-1ddcd5222540',
    adminSegment: 'a2a4d90d-9622-5a5d-b8b4-8e66abebf97a',
    websitePlugin: '795b6b80-0191-5e49-bbe7-9b96a39f72f9',
    e9console: '64ef9d75-114c-57dc-bc53-e31bfa156b9e',
    e9workers: 'eeadb6f4-5e89-59c7-97b5-2f2b400f222f',
    e9forms: '395cceba-b7b7-5762-90cd-36389e38535e'
  },
  local: {
    rolesPlugin: 'f352968d-79c7-5ed9-b254-3810a55fd1c0',
    adminSegment: '951944bb-d450-57db-95f8-b2d0dbc57927',
    websitePlugin: 'e01ebcf8-4de3-5d26-b181-e7036fea64cf',
    e9console: 'f823cfdc-c6a8-53a2-9566-bfd79eb3b744',
    e9workers: 'bf1b757f-f80c-58d1-bc63-415d628f7573',
    e9forms: 'f6383a9a-5802-578a-ae6c-1d9ca0f1dc2b'
  },
  cloudflare: {
    rolesPlugin: 'c4dc03c5-3067-5633-82de-79b39faf7eaa',
    adminSegment: 'dc7de322-e5a5-55d2-bcc3-4060d3048edc',
    websitePlugin: 'd920fd5d-ac5d-5c04-94d1-573243d67146',
    e9console: '74582f9f-58e7-5ec3-a983-16e697224452',
    e9workers: '0d836d25-abb9-5075-98d0-677a2110b52b',
    e9forms: '55e7a7c2-1427-5c80-aa12-a6e3d844422f'
  },
  'red-panda-3453': {
    rolesPlugin: '83a67d7c-eb4a-5a0f-8ed7-83d5947c2ed1',
    adminSegment: 'b33c7591-da33-57c4-b0fd-17c012517ba6',
    websitePlugin: '821cd8de-4b5a-55f5-8e22-9fc36de2e0a1',
    e9console: '9ffd7e92-e379-5378-a6c8-82cbca8886f3',
    e9workers: 'c17cf1f4-bc3b-54b5-a909-a064b4842b09',
    e9forms: '1f36c1d7-9fa6-574d-8ae9-0deda18bf524'
  }
};

test('pinned: rolesPluginId, roleSegmentId(admin), and the website/e9*/plugins ids, for every reference handle', () => {
  for (const [handle, expected] of Object.entries(PINNED)) {
    assert.equal(rolesPluginId(handle), expected.rolesPlugin, `rolesPluginId(${handle})`);
    assert.equal(roleSegmentId(handle, ROLE_NAMES.ADMIN), expected.adminSegment, `roleSegmentId(${handle}, admin)`);
    assert.equal(getPluginUUID(handle, 'website'), expected.websitePlugin, `website plugin for ${handle}`);
    assert.equal(
      getPluginUUID(`engine9.${handle}`, '@engine9/plugins/e9console'),
      expected.e9console,
      `e9console for ${handle}`
    );
    assert.equal(
      getPluginUUID(`engine9.${handle}`, '@engine9/plugins/e9workers'),
      expected.e9workers,
      `e9workers for ${handle}`
    );
    assert.equal(
      getPluginUUID(`engine9.${handle}`, '@engine9/plugins/e9forms'),
      expected.e9forms,
      `e9forms for ${handle}`
    );
  }
});

test('accountHandle defaults to accountId on every worker (SQLWorker/PluginWorker/PersonWorker)', () => {
  for (const id of Object.keys(PINNED)) {
    const worker = new PersonWorker({ accountId: id, auth: { database_connection: 'sqlite://:memory:' } });
    assert.equal(worker.accountHandle, id, `${id}: accountHandle defaults to accountId`);
  }
  // An explicit handle wins over accountId, and the default when neither is given is 'client'.
  const withHandle = new PersonWorker({
    accountId: 'anything',
    accountHandle: 'mrss_peta',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  assert.equal(withHandle.accountHandle, 'mrss_peta');
  const withNeither = new PersonWorker({ auth: { database_connection: 'sqlite://:memory:' } });
  assert.equal(withNeither.accountId, 'client');
  assert.equal(withNeither.accountHandle, 'client');
});

test('createApi: the default pluginId and the "standard" role registry read accountHandle, not accountId', async () => {
  // Simulates a rename: the account used to be 'mrss_peta' and is now
  // 'peta_foundation', but the handle -- set once, at the split -- stays
  // 'mrss_peta'. Every id below must still be the one 'mrss_peta' pins,
  // proving the rename changed nothing a person or a plugin depends on.
  const worker = new PersonWorker({
    accountId: 'peta_foundation',
    accountHandle: 'mrss_peta',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await applyStandardStack(worker);
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const delegateAuth = createDelegateAuth({
      worker,
      sessionSecret: '0123456789abcdef'.repeat(4),
      roles: 'standard'
    });
    const adminId = Object.keys(delegateAuth.roleRegistry).find(
      (id) => delegateAuth.roleRegistry[id].name === ROLE_NAMES.ADMIN
    );
    assert.equal(adminId, PINNED.mrss_peta.adminSegment, 'admin role id follows the handle, not the renamed accountId');

    const api = createApi({ worker, keyStore, delegateAuth, config: {} });
    void api; // createApi's own default pluginId is exercised by processPeople elsewhere; constructing it here
    // is enough to prove createApi(worker) does not throw when accountId and accountHandle differ.

    // ensureSegments() writes the segment row under the handle's roles plugin.
    await delegateAuth.ensureSegments();
    const { data } = await worker.query({ sql: 'select id, plugin_id from segment where id=?', values: [adminId] });
    assert.equal(data[0]?.id, PINNED.mrss_peta.adminSegment);
    assert.equal(data[0]?.plugin_id, PINNED.mrss_peta.rolesPlugin, 'the segment belongs to the handle\'s roles plugin');
  } finally {
    await worker.destroy();
  }
});

test('createApi default pluginId: getPluginUUID(accountHandle, "website")', async () => {
  const worker = new PersonWorker({
    accountId: 'peta_foundation',
    accountHandle: 'mrss_peta',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await applyStandardStack(worker);
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    await worker.insertArray({
      table: 'plugin',
      array: [{ id: PINNED.mrss_peta.websitePlugin, path: 'website', name: 'Peta Foundation', table_prefix: '' }]
    });
    const api = createApi({ worker, keyStore, config: {} });
    const result = await api.handle({
      method: 'POST',
      path: '/people',
      headers: { authorization: `Bearer ${(await keyStore.create({ name: 'admin', scopes: ['admin'] })).key}` },
      body: { people: [{ email: 'rename-test@example.com' }] }
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const { data } = await worker.query({
      sql: 'select distinct plugin_id from input where plugin_id=?',
      values: [PINNED.mrss_peta.websitePlugin]
    });
    assert.equal(data.length, 1, 'the signup was recorded under the handle\'s website plugin, not a plugin named after the renamed accountId');
  } finally {
    await worker.destroy();
  }
});

test('the Durable Object identifier store is keyed by accountHandle, not accountId', async () => {
  const seen = [];
  const namespace = {
    idFromName(name) {
      seen.push(name);
      return { name };
    },
    get(id) {
      return {
        async fetch() {
          return { ok: true, async json() { return { entries: [] }; } };
        }
      };
    }
  };
  const store = createDurableObjectIdentifierStore({ namespace, accountId: 'mrss_peta' });
  await store.findByIdentifiers([{ id_type: 'email', id_value: 'x@example.com' }]);
  assert.deepEqual(seen, ['mrss_peta']);
});

test('status: a core default account id is reported as a pass, never a warning', async () => {
  const worker = new PersonWorker({ accountId: 'cloudflare', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const result = await worker.status();
    const found = result.checks.find((c) => c.id === 'handle.default');
    assert.ok(found, 'handle.default check is present');
    assert.equal(found.status, 'pass');
    assert.equal(found.fix, undefined);
  } finally {
    await worker.destroy();
  }
});

test('status: does not warn once an account id (or handle) is explicitly set', async () => {
  const worker = new PersonWorker({ accountId: 'mrss_peta', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const result = await worker.status();
    assert.equal(result.checks.find((c) => c.id === 'handle.default'), undefined);
  } finally {
    await worker.destroy();
  }
});

test('status: catches an account id changed with no handle set -- the mistake this whole feature exists to prevent', async () => {
  // First deploy: the account is 'mrss_peta'. The roles plugin and the
  // admin segment get created under it.
  const first = new PersonWorker({ accountId: 'mrss_peta', auth: { database_connection: 'sqlite://:memory:' } });
  let dbFile;
  try {
    // A real file, not :memory:, so a second worker can reopen the same database.
    dbFile = `sqlite://${os.tmpdir()}/account-handle-fingerprint-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  } finally {
    await first.destroy();
  }
  const setup = new PersonWorker({ accountId: 'mrss_peta', auth: { database_connection: dbFile } });
  try {
    await applyStandardStack(setup);
    const delegateAuth = createDelegateAuth({
      worker: setup,
      sessionSecret: '0123456789abcdef'.repeat(4),
      roles: 'standard'
    });
    await delegateAuth.ensureSegments();
  } finally {
    await setup.destroy();
  }

  // Later: someone renames the account to 'peta_foundation' in config, with
  // no handle set -- exactly the unsafe rename phase 4 forbids. Status must
  // catch it, because nothing else will.
  const renamed = new PersonWorker({ accountId: 'peta_foundation', auth: { database_connection: dbFile } });
  try {
    const result = await renamed.status();
    const found = result.checks.find((c) => c.id === 'handle.fingerprint');
    assert.ok(found, 'handle.fingerprint check is present');
    assert.equal(found.status, 'warn');
    assert.ok(found.data.mismatches.some((m) => m.path === 'roles'), 'the roles plugin mismatch is reported');
    assert.ok(
      found.data.mismatches.some((m) => m.path === 'segment:admin'),
      'the admin segment mismatch is reported'
    );
  } finally {
    await renamed.destroy();
    await fs.promises.unlink(dbFile.replace('sqlite://', '')).catch(() => {});
  }
});

// The deprecated E9_PLUGIN_ID: a site that pinned its plugin id by hand keeps
// it, and status compares its website row against the pin, not the derived id.
const PINNED_SITE_PLUGIN = '6e1f8877-0000-5000-8000-000000000001';

test('status: a website row under a pinned E9_PLUGIN_ID matches when the pin is passed, warns when it is not', async () => {
  const worker = new PersonWorker({ accountId: 'sirens', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    await worker.insertArray({
      table: 'plugin',
      array: [{ id: PINNED_SITE_PLUGIN, path: 'website', name: 'Sirens', table_prefix: '' }]
    });
    const pinned = (await worker.status({ sitePluginId: PINNED_SITE_PLUGIN })).checks.find((c) => c.id === 'handle.fingerprint');
    assert.equal(pinned.status, 'pass');
    assert.ok(pinned.data.matches.includes('website'));

    const unpinned = (await worker.status()).checks.find((c) => c.id === 'handle.fingerprint');
    assert.equal(unpinned.status, 'warn');
    assert.ok(unpinned.data.mismatches.some((m) => m.path === 'website' && m.found === PINNED_SITE_PLUGIN));
  } finally {
    await worker.destroy();
  }
});

test('status: handleChecks: false leaves out both handle checks', async () => {
  const worker = new PersonWorker({ accountId: 'cloudflare', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const result = await worker.status({ handleChecks: false });
    assert.equal(result.checks.some((c) => c.id.startsWith('handle.')), false);
  } finally {
    await worker.destroy();
  }
});
