import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';
import { ROLE_NAMES, roleSegmentId } from '../auth/roles.js';
import {
  isSuperadmin,
  normalizeSuperadmins,
  superadminsFromText,
  SUPERADMIN_MIN_LEVEL
} from '../auth/superadmins.js';
import {
  addSuperadmins,
  createSuperadminsReader,
  readSuperadminsFile,
  removeSuperadmins
} from '../bin/superadminsFile.js';

const ACCOUNT_ID = 'test-superadmin';

test('superadmin list: normalized, verified level required', () => {
  assert.deepEqual(normalizeSuperadmins(['B@x.org', 'a@x.org', 'b@x.org', ' ']), ['a@x.org', 'b@x.org']);
  assert.deepEqual(normalizeSuperadmins({ superadmins: ['a@x.org'] }), ['a@x.org']);
  assert.deepEqual(normalizeSuperadmins(null), []);
  assert.throws(() => normalizeSuperadmins(['not an email']), /not an email address/);
  assert.deepEqual(superadminsFromText('a@x.org, b@x.org;\nc@x.org'), ['a@x.org', 'b@x.org', 'c@x.org']);
  assert.equal(SUPERADMIN_MIN_LEVEL, 3);
  assert.equal(isSuperadmin(['a@x.org'], 'A@X.org', 3), true);
  assert.equal(isSuperadmin(['a@x.org'], 'a@x.org', 2), false, 'Level 2 is not enough');
  assert.equal(isSuperadmin(['a@x.org'], 'a@x.org', undefined), false);
  assert.equal(isSuperadmin(['a@x.org'], '', 4), false, 'no verified email, no superadmin');
  assert.equal(isSuperadmin(() => ['a@x.org'], 'a@x.org', 4), true, 'a function is read on each call');
});

test('superadmins file: add, remove, reload on change, invalid file is an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e9-superadmins-'));
  try {
    const file = path.join(dir, 'engine9.superadmins.json');
    const env = {};
    const read = createSuperadminsReader({ file, env });
    assert.deepEqual(read(), [], 'a missing file is an empty list');
    assert.deepEqual(addSuperadmins(['Ops@Example.com'], { file }).superadmins, ['ops@example.com']);
    assert.deepEqual(read(), ['ops@example.com']);
    addSuperadmins(['two@example.com'], { file });
    // mtime resolution can be coarse; force a distinct one.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    assert.deepEqual(read(), ['ops@example.com', 'two@example.com']);
    env.E9_SUPERADMINS = 'env@example.com';
    assert.deepEqual(read(), ['env@example.com', 'ops@example.com', 'two@example.com'], 'E9_SUPERADMINS is added');
    removeSuperadmins(['ops@example.com'], { file });
    assert.deepEqual(readSuperadminsFile({ file }).superadmins, ['two@example.com']);
    fs.writeFileSync(file, '{ not json');
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(file, later, later);
    assert.throws(() => read(), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('superadmin acts as this account admin role without any database row', async () => {
  const worker = new PersonWorker({ accountId: ACCOUNT_ID, auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID(ACCOUNT_ID, 'website');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });

    let list = ['ops@example.com'];
    const delegateAuth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      sessionSecret: 'session-secret',
      pluginId,
      roles: 'standard',
      superadmins: () => list
    });
    const adminId = roleSegmentId(ACCOUNT_ID, ROLE_NAMES.ADMIN);
    assert.equal(delegateAuth.roleRegistry[adminId].name, 'admin');

    // Explicit registry that never listed admin still gets the role.
    const explicit = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      sessionSecret: 'session-secret',
      roles: { other: { name: 'other', scopes: ['data:read'] } },
      superadmins: ['ops@example.com']
    });
    assert.deepEqual(explicit.roleRegistry[adminId].scopes, ['admin']);
    assert.equal(explicit.roleRegistry[adminId].requiredAuth.minLevel, 3);

    // withSuperadmin: verified email at Level 3 only.
    const base = { personId: 1, roles: ['x'], email: 'OPS@example.com', level: 3, auth: {} };
    const up = delegateAuth.withSuperadmin(base);
    assert.deepEqual(up.roles, [adminId, 'x']);
    assert.equal(up.superadmin, true);
    assert.deepEqual(delegateAuth.withSuperadmin({ ...base, level: 2 }).roles, ['x'], 'Level 2 is not enough');
    assert.deepEqual(delegateAuth.withSuperadmin({ ...base, email: undefined }).roles, ['x'], 'no verified email');
    assert.deepEqual(delegateAuth.withSuperadmin({ ...base, email: 'nobody@example.com' }).roles, ['x']);

    // The token never carries the list-granted role; verify() adds it back.
    const token = delegateAuth.issueToken({ ...base, personId: 7, roles: [] });
    assert.deepEqual(delegateAuth.verify(token).roles, [adminId], 'verify adds it on the fly');
    const tokenFromSuper = delegateAuth.issueToken(delegateAuth.withSuperadmin({ ...base, personId: 7, roles: [] }));
    list = [];
    assert.deepEqual(delegateAuth.verify(tokenFromSuper).roles, [], 'removing the email revokes on the next verify');
    list = ['ops@example.com'];

    // person_segment is never written for a superadmin.
    const rolesNow = await delegateAuth.rolesForSession({ personId: 7, email: 'ops@example.com', level: 3 });
    assert.deepEqual(rolesNow, [adminId]);
    const { data } = await worker.query({ sql: 'select count(*) as n from person_segment where segment_id=?', values: [adminId] });
    assert.equal(Number(data[0].n), 0);
    assert.deepEqual(await delegateAuth.rolesForPerson(7), []);

    // HTTP: a superadmin session may name the admin role; others may not.
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key } = await keyStore.create({ name: 'site', scopes: ['people:write', 'data:read'] });
    const api = createApi({ worker, keyStore, delegateAuth, config: { pluginId, roles: 'standard' } });
    const sessionFor = (email, level) =>
      delegateAuth.issueToken({ personId: 7, roles: [], email, level, auth: {}, domainUnid: 'x.example:1' });

    const me = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { authorization: `Bearer ${key}`, 'x-engine9-session': sessionFor('ops@example.com', 3) }
    });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.deepEqual(me.body.roles, [adminId]);

    const asAdmin = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: { authorization: `Bearer ${key}`, 'x-engine9-session': sessionFor('ops@example.com', 3) },
      body: { role_id: adminId, add: [] }
    });
    assert.notEqual(asAdmin.body?.reason, 'role_not_held', JSON.stringify(asAdmin.body));

    const notSuper = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: { authorization: `Bearer ${key}`, 'x-engine9-session': sessionFor('ops@example.com', 2) },
      body: { role_id: adminId, add: [] }
    });
    assert.equal(notSuper.status, 403);
    assert.equal(notSuper.body.reason, 'role_not_held', 'Level 2 does not hold admin');

    list = [];
    const removed = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: { authorization: `Bearer ${key}`, 'x-engine9-session': sessionFor('ops@example.com', 3) },
      body: { role_id: adminId, add: [] }
    });
    assert.equal(removed.body.reason, 'role_not_held', 'removed from the list, denied on the next request');
  } finally {
    await worker.destroy();
  }
});
