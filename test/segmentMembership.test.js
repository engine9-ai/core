import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { getPluginUUID, getVersionedUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';
import {
  ROLE_NAMES,
  STANDARD_ROLES,
  ensureRoleSegments,
  roleSegmentId,
  standardRoleRegistry
} from '../auth/roles.js';
import {
  canEditSegmentMembership,
  membershipPolicyFromRow,
  parseMinLevel
} from '../auth/segmentAccess.js';

test('segment membership decisions: self by level, others by manager role, admin bypasses', () => {
  // Example site roles — names are fixtures, not STANDARD_ROLES.
  const club = {
    id: 'club',
    name: 'club',
    joinMinLevel: 1,
    leaveMinLevel: 2,
    managerRoleId: 'curator',
    scopes: ['data:read'],
    requiredAuth: { minLevel: 1 }
  };
  const closed = {
    id: 'admin',
    name: 'admin',
    joinMinLevel: null,
    leaveMinLevel: null,
    managerRoleId: null,
    scopes: ['admin'],
    requiredAuth: { minLevel: 3 }
  };
  const newsletter = {
    id: 'news',
    joinMinLevel: 0,
    leaveMinLevel: 2,
    managerRoleId: 'curator',
    scopes: []
  };
  const curator = { level: 2, personId: 9, roleIds: ['curator'], scopes: ['data:read', 'people:write'] };
  const decide = (policy, operation, caller, targetPersonId) =>
    canEditSegmentMembership({ policy, operation, caller, targetPersonId });

  let d = decide(closed, 'add', { level: 4, personId: 1 }, 1);
  assert.equal(d.allowed, false, 'closed segment: cannot add yourself');
  assert.equal(d.subject, 'self');
  assert.match(d.reason, /cannot add yourself to 'admin'/);

  d = decide(closed, 'add', { level: 4, personId: 1 }, 2);
  assert.equal(d.allowed, false);
  assert.equal(d.subject, 'other', 'a different person_id is someone else');
  assert.match(d.reason, /cannot add other people to 'admin'.*only admin scope/);

  d = decide(closed, 'add', { isAdmin: true }, 2);
  assert.deepEqual([d.allowed, d.granted], [true, 'admin']);

  d = decide(club, 'add', { level: 1, personId: 1 }, 1);
  assert.deepEqual([d.allowed, d.granted, d.subject], [true, 'self', 'self'], 'level 1 may add themselves');

  d = decide(club, 'remove', { level: 1, personId: 1 }, 1);
  assert.equal(d.allowed, false, 'level 1 may not remove themselves when leave_min_level is 2');
  assert.match(d.reason, /cannot remove yourself from 'club': requires Identity Level 2, you are at 1/);

  assert.equal(decide(club, 'remove', { level: 2, personId: 1 }, 1).allowed, true);

  d = decide(newsletter, 'add', { level: 0 }, null);
  assert.deepEqual([d.allowed, d.subject], [true, 'self'], 'a public form (no session, target null) may add to a level-0 list');
  d = decide(club, 'add', { level: 0 }, null);
  assert.equal(d.allowed, false, 'a public form cannot add to a level-1 list');
  assert.match(d.reason, /sign in at Identity Level 1/);
  d = decide(newsletter, 'remove', { level: 0 }, null);
  assert.equal(d.allowed, false, 'no anonymous removal');
  assert.match(d.reason, /sign in/);

  d = decide(club, 'add', curator, 3);
  assert.deepEqual([d.allowed, d.granted, d.subject], [true, 'manager', 'other'], 'manager may add other people');
  assert.equal(decide(club, 'remove', curator, 9).allowed, true, 'manager may remove themselves too');

  d = decide({ ...closed, managerRoleId: 'curator' }, 'add', curator, 3);
  assert.equal(d.allowed, false, 'manager cannot grant a segment whose scopes they do not hold');
  assert.match(d.reason, /you manage it, but your effective scopes/);

  d = decide(club, 'add', { level: 3, personId: 1, roleIds: [] }, 3);
  assert.equal(d.subject, 'other');
  assert.match(d.reason, /requires its manager role \(curator\) or admin scope/);

  assert.match(decide(club, 'join', curator, 9).reason, /use add or remove/);
  assert.throws(() => parseMinLevel(0, { field: 'leave_min_level', allowZero: false }), /cannot be 0/);
  const coerced = membershipPolicyFromRow({ id: 'x', join_min_level: 0, leave_min_level: 0 });
  assert.equal(coerced.joinMinLevel, 0);
  assert.equal(coerced.leaveMinLevel, null, 'a stored leave level of 0 is treated as closed');
});

test('POST /auth/segments and POST /people honor segment policy', async () => {
  const accountId = 'seg-http';
  const worker = new PersonWorker({ accountId, auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID(accountId, 'website');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });

    // Site-specific curator + club roles (not shipped by roles: 'standard').
    const siteRoles = [
      ...STANDARD_ROLES,
      {
        name: 'curator',
        description: 'Example curator',
        scopes: ['data:read', 'people:write'],
        requiredAuth: { minLevel: 2 },
        leaveMinLevel: 1
      },
      {
        name: 'club',
        description: 'Example club',
        scopes: ['data:read'],
        requiredAuth: { minLevel: 1 },
        joinMinLevel: 1,
        leaveMinLevel: 1,
        managerRole: 'curator'
      }
    ];
    const roles = await ensureRoleSegments({ worker, accountId, roles: siteRoles });
    const delegateAuth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      sessionSecret: 'session-secret',
      pluginId,
      roles
    });

    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key } = await keyStore.create({ name: 'site', scopes: ['people:write', 'data:read'] });
    const { key: publicKey } = await keyStore.create({ name: 'form', scopes: ['public'] });
    const api = createApi({
      worker,
      keyStore,
      delegateAuth,
      config: { pluginId, roles }
    });

    const curatorId = roleSegmentId(accountId, 'curator');
    const clubId = roleSegmentId(accountId, 'club');
    const adminId = roleSegmentId(accountId, ROLE_NAMES.ADMIN);
    const curator = await delegateAuth.addPeople({ role: 'curator', emails: ['curator@example.com'] });
    const curatorPersonId = curator.byEmail['curator@example.com'];
    const headers = {
      authorization: `Bearer ${key}`,
      'x-engine9-session': delegateAuth.issueToken({
        personId: curatorPersonId,
        roles: [curatorId],
        level: 2,
        auth: {},
        domainUnid: 'seg-http.example'
      })
    };

    const selfAdmin = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers,
      body: { add: [adminId] }
    });
    assert.equal(selfAdmin.status, 403, JSON.stringify(selfAdmin.body));
    assert.equal(selfAdmin.body.subject, 'self');
    assert.equal(selfAdmin.body.operation, 'add');
    assert.match(selfAdmin.body.error, /cannot add yourself to 'admin'/);

    const legacy = await api.handle({ method: 'POST', path: '/auth/segments', headers, body: { join: [clubId] } });
    assert.equal(legacy.status, 400, 'join/leave are rejected with a hint');
    assert.match(legacy.body.error, /use add and remove/);

    const addClub = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers,
      body: { add: [{ email: 'sam@example.com', segment_id: clubId }] }
    });
    assert.equal(addClub.status, 200, JSON.stringify(addClub.body));
    const sam = await worker.query({
      sql: 'select person_id from person_email where email=?',
      values: ['sam@example.com']
    });
    assert.equal(
      await worker.query({
        sql: 'select person_id from person_segment where segment_id=? and person_id=?',
        values: [clubId, sam.data[0].person_id]
      }).then((r) => r.data.length),
      1
    );

    const addAdmin = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers,
      body: { add: [{ email: 'sam@example.com', segment_id: adminId }] }
    });
    assert.equal(addAdmin.status, 403, 'curator cannot grant admin');
    assert.equal(addAdmin.body.subject, 'other');
    assert.match(addAdmin.body.error, /cannot add other people to 'admin'/);

    const formDenied = await api.handle({
      method: 'POST',
      path: '/people',
      headers: { authorization: `Bearer ${publicKey}` },
      body: { people: [{ email: 'new@example.com', segment_ids: adminId }] }
    });
    assert.equal(formDenied.status, 403);
    assert.equal(formDenied.body.subject, 'self', 'a form batch is treated as the people signing themselves up');

    const listId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [{ id: listId, plugin_id: pluginId, name: 'News', build_type: 'list', join_min_level: 0, leave_min_level: 2 }]
    });
    const formOk = await api.handle({
      method: 'POST',
      path: '/people',
      headers: { authorization: `Bearer ${publicKey}` },
      body: { people: [{ email: 'reader@example.com', segment_ids: listId }] }
    });
    assert.equal(formOk.status, 200, JSON.stringify(formOk.body));

    const pat = await delegateAuth.addPeople({ role: 'club', emails: ['pat@example.com'] });
    const rsvp = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [{ id: rsvp, plugin_id: pluginId, name: 'RSVP', build_type: 'manual', join_min_level: 1, leave_min_level: 2 }]
    });
    const patHeaders = {
      authorization: `Bearer ${key}`,
      'x-engine9-session': delegateAuth.issueToken({
        personId: pat.byEmail['pat@example.com'],
        roles: [clubId],
        level: 1,
        auth: {},
        domainUnid: 'seg-http.example'
      })
    };
    const joined = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: patHeaders,
      body: { add: [{ segment_id: rsvp }] }
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual(joined.body.add, [{ segment_id: rsvp, person_id: pat.byEmail['pat@example.com'], subject: 'self' }]);
    const left = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: patHeaders,
      body: { remove: [rsvp] }
    });
    assert.equal(left.status, 403, 'level 1 cannot remove themselves when leave_min_level is 2');
    assert.equal(left.body.subject, 'self');
    assert.match(left.body.error, /cannot remove yourself from 'RSVP': requires Identity Level 2, you are at 1/);

    const other = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: patHeaders,
      body: { remove: [{ segment_id: rsvp, person_id: curatorPersonId }] }
    });
    assert.equal(other.status, 403, 'a club member cannot remove someone else');
    assert.equal(other.body.subject, 'other');
    assert.match(other.body.error, /cannot remove other people from 'RSVP': it has no manager role/);

    const noSession = await api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: { authorization: `Bearer ${key}` },
      body: { add: [rsvp] }
    });
    assert.equal(noSession.status, 401);
    assert.equal(noSession.body.subject, 'self');
    assert.ok(standardRoleRegistry(accountId)[adminId], 'standard registry still only admin/operator');
  } finally {
    await worker.destroy();
  }
});
