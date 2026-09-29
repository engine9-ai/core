import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';
import { createDelegateAuth, normalizeRoleRegistry } from '../auth/delegate.js';
import {
  ROLE_NAMES,
  ROLES_PLUGIN_PATH,
  STANDARD_ROLES,
  rolesPluginId,
  roleSegmentId,
  standardRoleRegistry,
  roleIdByName,
  ensureRoleSegments,
  setMembershipPolicy,
  addPeopleToSegment,
  removePeopleFromSegment,
  listSegmentMembers,
  personHasRole,
  rolesForEmail,
  lookupPersonIdsByEmail
} from '../auth/roles.js';

const ACCOUNT_ID = 'test-roles';

async function setupWorker() {
  const worker = new PersonWorker({ accountId: ACCOUNT_ID, auth: { database_connection: 'sqlite://:memory:' } });
  await applyStandardStack(worker);
  const pluginId = getPluginUUID(ACCOUNT_ID, 'website');
  await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Test Roles Site' });
  return { worker, pluginId };
}

test('standard role ids are deterministic per account and name', () => {
  const registry = standardRoleRegistry('acme');
  assert.deepEqual(
    Object.values(registry).map((r) => r.name),
    ['admin', 'operator']
  );
  assert.deepEqual(Object.values(registry).map((r) => r.name), STANDARD_ROLES.map((r) => r.name));
  const adminId = roleSegmentId('acme', ROLE_NAMES.ADMIN);
  assert.equal(registry[adminId].name, 'admin');
  assert.deepEqual(registry[adminId].scopes, ['admin']);
  assert.equal(registry[adminId].requiredAuth.minLevel, 3);
  const operatorId = roleSegmentId('acme', ROLE_NAMES.OPERATOR);
  assert.deepEqual(registry[operatorId].scopes, ['data:read', 'tasks:read', 'tasks:schedule']);
  assert.equal(roleSegmentId('acme', ROLE_NAMES.ADMIN), adminId, 'same inputs, same id');
  assert.notEqual(roleSegmentId('beta', ROLE_NAMES.ADMIN), adminId, 'different account, different id');
  assert.equal(rolesPluginId('acme'), getPluginUUID('acme', ROLES_PLUGIN_PATH));
  assert.equal(roleIdByName(registry, 'Admin'), adminId);
  assert.equal(roleIdByName(registry, adminId), adminId);
  assert.equal(roleIdByName(registry, 'nope'), null);
  assert.deepEqual(normalizeRoleRegistry({ roles: 'standard', accountId: 'acme' }), registry);
  assert.throws(() => normalizeRoleRegistry({ roles: 'standard' }), /requires accountId/);
});

test('add and remove people from a role by email, creating people as needed', async () => {
  const { worker, pluginId } = await setupWorker();
  try {
    const registry = await ensureRoleSegments({ worker });
    const again = await ensureRoleSegments({ worker, accountId: ACCOUNT_ID });
    assert.deepEqual(again, registry, 'idempotent; accountId defaults to worker.accountId');
    const { data: segments } = await worker.query(
      "select id, plugin_id, category, build_type from segment where category='role' order by name"
    );
    assert.equal(segments.length, STANDARD_ROLES.length);
    // Site-specific roles (not in STANDARD_ROLES) exercise join/leave/manager policy.
    const siteRoles = [
      {
        name: 'curator',
        description: 'Example curator',
        scopes: ['data:read', 'people:write'],
        requiredAuth: { minLevel: 2 },
        leaveMinLevel: 1
      },
      {
        name: 'club',
        description: 'Example self-join club',
        scopes: ['data:read'],
        requiredAuth: { minLevel: 1 },
        joinMinLevel: 1,
        leaveMinLevel: 1,
        managerRole: 'curator'
      }
    ];
    await ensureRoleSegments({ worker, roles: siteRoles });
    const clubId = roleSegmentId(ACCOUNT_ID, 'club');
    const curatorId = roleSegmentId(ACCOUNT_ID, 'curator');
    const { data: clubRow } = await worker.query({
      sql: 'select join_min_level, leave_min_level, manager_role_id from segment where id=?',
      values: [clubId]
    });
    assert.equal(Number(clubRow[0].join_min_level), 1);
    assert.equal(Number(clubRow[0].leave_min_level), 1);
    assert.equal(clubRow[0].manager_role_id, curatorId);
    await setMembershipPolicy({
      worker,
      segmentId: clubId,
      joinMinLevel: 2,
      leaveMinLevel: 2
    });
    await ensureRoleSegments({ worker, roles: siteRoles });
    const { data: kept } = await worker.query({
      sql: 'select join_min_level, manager_role_id from segment where id=?',
      values: [clubId]
    });
    assert.equal(Number(kept[0].join_min_level), 2, 'ensure does not overwrite an admin-set policy');
    assert.equal(kept[0].manager_role_id, null);
    await setMembershipPolicy({
      worker,
      segmentId: clubId,
      joinMinLevel: 1,
      leaveMinLevel: 1,
      managerRoleId: curatorId
    });
    await assert.rejects(
      setMembershipPolicy({ worker, segmentId: clubId, leaveMinLevel: 0 }),
      /cannot be 0/
    );
    assert.ok(segments.every((s) => s.build_type === 'manual'));
    assert.ok(segments.every((s) => s.plugin_id === rolesPluginId(ACCOUNT_ID)), 'segments belong to the roles plugin');
    const { data: rolesPlugin } = await worker.query({
      sql: 'select path from plugin where id=?',
      values: [rolesPluginId(ACCOUNT_ID)]
    });
    assert.equal(rolesPlugin[0]?.path, ROLES_PLUGIN_PATH, 'roles plugin row created');

    const roleId = roleSegmentId(ACCOUNT_ID, ROLE_NAMES.ADMIN);
    assert.deepEqual(await lookupPersonIdsByEmail({ worker, emails: ['Alice@Example.com'] }), {});

    const added = await addPeopleToSegment({
      worker,
      pluginId,
      segmentId: roleId,
      emails: ['Alice@Example.com', 'bob@example.com', 'alice@example.com']
    });
    assert.equal(added.personIds.length, 2, 'duplicate email collapsed');
    assert.equal(added.added.length, 2);
    assert.ok(added.byEmail['alice@example.com'] > 0);
    assert.ok(added.byEmail['bob@example.com'] > 0);

    const { data: people } = await worker.query('select id from person');
    assert.equal(people.length, 2, 'people created through the pipeline');
    const { data: emails } = await worker.query('select person_id, email from person_email order by email');
    assert.deepEqual(
      emails.map((e) => e.email),
      ['alice@example.com', 'bob@example.com']
    );

    const members = await listSegmentMembers({ worker, segmentId: roleId });
    assert.deepEqual(
      members.map((m) => m.emails[0]).sort(),
      ['alice@example.com', 'bob@example.com']
    );
    assert.equal(await personHasRole({ worker, personId: added.byEmail['alice@example.com'], roleId }), true);
    assert.deepEqual(
      await rolesForEmail({ worker, email: 'ALICE@example.com', roleIds: Object.keys(registry) }),
      [roleId],
      'rolesForEmail finds membership by email alone'
    );
    assert.deepEqual(await rolesForEmail({ worker, email: 'nobody@example.com', roleIds: Object.keys(registry) }), []);

    // Adding an existing member again is a no-op.
    const repeat = await addPeopleToSegment({ worker, pluginId, segmentId: roleId, emails: ['alice@example.com'] });
    assert.deepEqual(repeat.added, []);
    assert.equal(repeat.byEmail['alice@example.com'], added.byEmail['alice@example.com']);

    // Remove by email; unknown emails are ignored, no people created.
    const removed = await removePeopleFromSegment({ worker, segmentId: roleId, emails: ['alice@example.com', 'nobody@example.com'] });
    assert.deepEqual(removed.removed, [added.byEmail['alice@example.com']]);
    const { data: peopleAfter } = await worker.query('select id from person');
    assert.equal(peopleAfter.length, 2, 'remove never creates people');
    assert.equal(await personHasRole({ worker, personId: added.byEmail['alice@example.com'], roleId }), false);
    assert.equal(await personHasRole({ worker, personId: added.byEmail['bob@example.com'], roleId }), true);

    // Remove by person_id.
    const byId = await removePeopleFromSegment({ worker, segmentId: roleId, personIds: [added.byEmail['bob@example.com']] });
    assert.deepEqual(byId.removed, [added.byEmail['bob@example.com']]);
    assert.deepEqual(await listSegmentMembers({ worker, segmentId: roleId }), []);

    await assert.rejects(addPeopleToSegment({ worker, pluginId, segmentId: roleId, emails: ['not an email'] }), /Not an email/);
    await assert.rejects(addPeopleToSegment({ worker, pluginId, segmentId: roleId }), /at least one/);
  } finally {
    await worker.destroy();
  }
});

async function jwksFetch(publicKey, kid) {
  const jwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig' }] };
  return async (url) => {
    if (String(url).endsWith('/.well-known/jwks.json')) return new Response(JSON.stringify(jwks), { status: 200 });
    return new Response('not found', { status: 404 });
  };
}

test("createDelegateAuth roles: 'standard' -- email granted before first login lands on the same person", async () => {
  const { worker, pluginId } = await setupWorker();
  try {
    const domain = 'site.example.com';
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const auth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      domain,
      sessionSecret: 'session-secret',
      pluginId,
      roles: 'standard',
      fetchImpl: await jwksFetch(publicKey, 'k1')
    });
    const adminId = roleSegmentId(ACCOUNT_ID, ROLE_NAMES.ADMIN);
    assert.equal(auth.roleRegistry[adminId].name, 'admin');

    await auth.ensureSegments();
    const granted = await auth.addPeople({ role: 'admin', emails: ['carol@example.com'] });
    const carolId = granted.byEmail['carol@example.com'];
    assert.ok(carolId > 0);
    await assert.rejects(auth.addPeople({ role: 'superuser', emails: ['x@example.com'] }), /unknown role 'superuser'/);

    const jwt = await new SignJWT({
      level: 3,
      fields: { email: 'Carol@Example.com', email_verified: true },
      auth: { provider: 'google.com', two_factor: false, auth_time: 1234 }
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' })
      .setIssuer('https://delegate.example.test')
      .setAudience(domain)
      .setSubject(`${domain}:${'c'.repeat(64)}`)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('jti-1')
      .sign(privateKey);

    const { session } = await auth.login(jwt);
    assert.equal(session.personId, carolId, 'verified email merges the login into the granted person');
    assert.deepEqual(session.roles, [adminId], 'membership granted by email is live at first login');

    const members = await auth.members({ role: 'admin' });
    assert.deepEqual(members, [{ person_id: carolId, emails: ['carol@example.com'] }]);

    await auth.removePeople({ role: adminId, emails: ['carol@example.com'] });
    assert.deepEqual(await auth.rolesForPerson(carolId), []);

    const explicit = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      sessionSecret: 's',
      roles: { [adminId]: { name: 'Admin', scopes: ['admin'] } }
    });
    await assert.rejects(explicit.ensureSegments(), /roles: 'standard'/);
  } finally {
    await worker.destroy();
  }
});
