import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';
import {
  createSessionToken,
  verifySessionToken,
  verifyDelegateIdentityToken,
  classifyDelegateLoginToken,
  createSessionCookieHeaders,
  resolveDelegatePersonId,
  createDelegateAuth,
  createDelegateLoginFailure,
  normalizeDelegateLoginFailure,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole
} from '../auth/delegate.js';
import { getVersionedUUID } from '../lib/utilities.js';

async function signDelegateJwt({
  privateKey,
  kid = 'test-key',
  issuer = 'https://delegate.engine9.ai',
  site = 'https://site.example.com',
  unid = UNID_A,
  level = 2,
  sub,
  profile,
  auth = { provider: 'google.com', two_factor: true, auth_time: 1234 },
  expires = '1h'
}) {
  const jwt = new SignJWT({
    unid,
    level,
    profile,
    auth
  });
  jwt.setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' });
  jwt.setIssuer(issuer);
  jwt.setAudience(site);
  jwt.setSubject(sub || (profile?.id || `unid:${unid}`));
  jwt.setIssuedAt();
  jwt.setExpirationTime(expires);
  jwt.setJti(`jti-${crypto.randomUUID()}`);
  return jwt.sign(privateKey);
}

const UNID_A = '11111111-2222-8e91-8333-444444444444';
const UNID_B = '55555555-6666-8e91-8777-888888888888';

test('delegate identities dedupe through the person pipeline (id_type "delegate")', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-plugin');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-delegate-plugin', name: 'Test Delegate Plugin' });

    // First delegate login: creates a person and a person_id_delegate mapping
    const personId = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: UNID_A, email: 'alice@example.com', emailVerified: true },
      person: { given_name: 'Alice', family_name: 'Anderson' }
    });
    assert.ok(personId, 'a person_id was assigned');

    const { data: delegateIds } = await worker.query('select person_id from person_id_delegate');
    assert.equal(delegateIds.length, 1, 'delegate identifier stored in person_id_delegate');
    assert.equal(delegateIds[0].person_id, personId);

    // Same unid again -> same person, no new rows
    const again = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: UNID_A, email: 'alice@example.com', emailVerified: true }
    });
    assert.equal(again, personId, 'repeat delegate login resolves to the same person');
    const { data: people } = await worker.query('select id from person');
    assert.equal(people.length, 1);

    // Known email arriving with a NEW unid -> dedupes to the same person via
    // the email hash, and the new delegate id is attached going forward
    const merged = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: UNID_B, email: 'alice@example.com', level: 2 }
    });
    assert.equal(merged, personId, 'same email merges a new delegate id into the existing person');
    const { data: delegateIds2 } = await worker.query('select person_id from person_id_delegate');
    assert.equal(delegateIds2.length, 2, 'both unids now map to the person');
    assert.ok(delegateIds2.every((r) => r.person_id === personId));

    // Brand new person entirely
    const other = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: 'aaaaaaaa-bbbb-8e91-8ccc-dddddddddddd', email: 'bob@example.com', emailVerified: true }
    });
    assert.notEqual(other, personId);

    const unverified = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: {
        unid: 'cccccccc-dddd-8e91-8eee-ffffffffffff',
        email: 'unverified-unique@example.com',
        emailVerified: false,
        level: 0
      }
    });
    const { data: unverifiedEmails } = await worker.query({
      sql: 'select email from person_email where person_id=?',
      values: [unverified]
    });
    assert.equal(unverifiedEmails.length, 0, 'unverified level 0 email is not copied onto the person');
  } finally {
    await worker.destroy();
  }
});

test('delegate session tokens: sign, verify, tamper, expire', () => {
  const secret = 'session-secret';
  const token = createSessionToken(
    { personId: 42, unid: UNID_A, auth: { signInProvider: 'google.com', twoFactor: false } },
    { secret, ttlSeconds: 60 }
  );
  const payload = verifySessionToken(token, { secret });
  assert.equal(payload.personId, 42);
  assert.equal(payload.unid, UNID_A);
  assert.equal(payload.auth.signInProvider, 'google.com');
  assert.ok(payload.exp > Date.now());

  assert.equal(verifySessionToken(token, { secret: 'wrong-secret' }), null);
  assert.equal(verifySessionToken(`${token}x`, { secret }), null);
  assert.equal(verifySessionToken('garbage', { secret }), null);

  const expired = createSessionToken({ personId: 1 }, { secret, ttlSeconds: -1 });
  assert.equal(verifySessionToken(expired, { secret }), null);
});

test('createDelegateLoginFailure separates configuration and auth failures', () => {
  const config = createDelegateLoginFailure('missing_session_secret');
  assert.equal(config.kind, 'configuration');
  assert.match(config.userMessage, /misconfigured/i);
  assert.match(config.userMessage, /SESSION_SECRET/i);
  assert.doesNotMatch(config.userMessage, /try again/i);

  const auth = createDelegateLoginFailure('invalid_identity_token');
  assert.equal(auth.kind, 'auth');
  assert.match(auth.userMessage, /invalid or expired/i);
  assert.match(auth.userMessage, /sign in again/i);

  const server = createDelegateLoginFailure('status_503');
  assert.equal(server.kind, 'configuration');

  const unknown = createDelegateLoginFailure('something_weird');
  assert.equal(unknown.kind, 'auth');
  assert.match(unknown.userMessage, /code: something_weird/);
});

test('normalizeDelegateLoginFailure maps plain errors and preserves structured failures', () => {
  const structured = createDelegateLoginFailure('invalid_identity_token');
  assert.equal(
    normalizeDelegateLoginFailure(structured).userMessage,
    structured.userMessage
  );

  const missingSecret = normalizeDelegateLoginFailure(
    new Error('createSessionToken requires a session_secret')
  );
  assert.equal(missingSecret.reason, 'missing_session_secret');
  assert.equal(missingSecret.kind, 'configuration');

  const generic = normalizeDelegateLoginFailure(new Error('database is locked'));
  assert.equal(generic.reason, 'login_failed');
  assert.match(generic.message, /database is locked/);
});

async function jwksFetch(publicKey, kid = 'test-key') {
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  return async (url) => {
    if (String(url).includes('/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

test('createDelegateAuth: login -> person -> roles-as-segments -> signed session', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-site');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-delegate-site', name: 'Test Delegate Site' });

    const vipSegmentId = getVersionedUUID();
    const adminSegmentId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [
        { id: vipSegmentId, plugin_id: pluginId, name: 'VIP', build_type: 'list' },
        { id: adminSegmentId, plugin_id: pluginId, name: 'Admin', build_type: 'list' }
      ]
    });

    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const fetchImpl = await jwksFetch(publicKey, 'roles-key');
    const site = 'https://site.example.com';
    const profile = {
      id: 'prof-roles',
      email: 'alice@example.com',
      email_verified: true
    };
    const sign = (twoFactor) =>
      signDelegateJwt({
        privateKey,
        kid: 'roles-key',
        issuer: 'https://delegate.example.test',
        site,
        sub: profile.id,
        profile,
        auth: { provider: 'google.com', two_factor: twoFactor, auth_time: 1234 }
      });

    const auth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      site,
      sessionSecret: 'session-secret',
      pluginId,
      remoteInputId: 'delegate-login',
      roles: {
        [adminSegmentId]: { name: 'Admin', scopes: ['admin'] },
        [vipSegmentId]: { name: 'VIP', scopes: ['data:read'] }
      },
      fetchImpl
    });

    assert.ok(
      auth.identityUrl({ returnTo: 'https://site.example.com/auth/delegate' }).includes('/identity/authorize')
    );

    const { session, token } = await auth.login(await sign(true));
    assert.ok(session.personId > 0);
    assert.deepEqual(session.roles, []);
    assert.equal(session.unid, UNID_A);
    assert.equal(session.auth.signInProvider, 'google.com');
    assert.equal(session.auth.twoFactor, true, 'credential level travels into the session');
    assert.equal(sessionNeedsRole(session), true);

    const verified = auth.verify(token);
    assert.equal(verified.personId, session.personId);
    assert.deepEqual(verified.roles, []);
    assert.equal(auth.verify('tampered'), null);

    const roles = await auth.grantRole(session.personId, vipSegmentId);
    assert.deepEqual(roles, [vipSegmentId]);
    const { data: memberships } = await worker.query('select segment_id, person_id from person_segment');
    assert.deepEqual(memberships, [{ segment_id: vipSegmentId, person_id: session.personId }]);

    const updated = { ...session, roles };
    assert.equal(sessionHasRole(updated, vipSegmentId, adminSegmentId), true);
    assert.equal(sessionHasRole(updated, adminSegmentId), false);
    assert.equal(sessionPrimaryRole(updated, [adminSegmentId, vipSegmentId]), vipSegmentId);
    assert.equal(sessionNeedsRole(updated), false);

    const again = await auth.login(await sign(true));
    assert.equal(again.session.personId, session.personId, 'delegate id dedupes to the same person');
    assert.deepEqual(again.session.roles, [vipSegmentId]);

    const exclusive = await auth.grantRole(session.personId, adminSegmentId, { exclusive: true });
    assert.deepEqual(exclusive, [adminSegmentId]);
    const { data: afterExclusive } = await worker.query({
      sql: 'select segment_id from person_segment where person_id=?',
      values: [session.personId]
    });
    assert.deepEqual(
      afterExclusive.map((r) => r.segment_id),
      [adminSegmentId]
    );

    const changed = await auth.changeRole({
      personId: session.personId,
      roleId: vipSegmentId,
      exclusive: true,
      session: { ...session, roles: exclusive }
    });
    assert.deepEqual(changed.roles, [vipSegmentId]);
    assert.equal(auth.verify(changed.token).roles[0], vipSegmentId);

    await auth.grantRole(session.personId, 'Admin', { exclusive: true });
    assert.deepEqual(await auth.rolesForPerson(session.personId), [adminSegmentId]);

    await assert.rejects(auth.grantRole(session.personId, 'superuser'), /Unknown role/);
  } finally {
    await worker.destroy();
  }
});

test('createDelegateAuth: legacy roleSegments compat maps names to UUIDs on session', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-legacy-roles');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-delegate-site', name: 'Test Delegate Site' });

    const vipSegmentId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [{ id: vipSegmentId, plugin_id: pluginId, name: 'VIP', build_type: 'list' }]
    });

    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const auth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      site: 'https://site.example.com',
      sessionSecret: 'session-secret',
      pluginId,
      roleSegments: { vip: vipSegmentId },
      fetchImpl: await jwksFetch(publicKey, 'legacy-roles-key')
    });

    const jwt = await signDelegateJwt({
      privateKey,
      kid: 'legacy-roles-key',
      issuer: 'https://delegate.example.test'
    });
    const { session } = await auth.login(jwt);
    const roles = await auth.grantRole(session.personId, 'vip');
    assert.deepEqual(roles, [vipSegmentId], 'legacy name grant returns UUID role_ids');
  } finally {
    await worker.destroy();
  }
});

test('createDelegateAuth: loadRolesOnLogin false skips segment roles on login', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-site-session-roles');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-delegate-site', name: 'Test Delegate Site' });

    const vipSegmentId = getVersionedUUID();
    const adminSegmentId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [
        { id: vipSegmentId, plugin_id: pluginId, name: 'VIP', build_type: 'list' },
        { id: adminSegmentId, plugin_id: pluginId, name: 'Admin', build_type: 'list' }
      ]
    });

    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const auth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.example.test',
      site: 'https://site.example.com',
      sessionSecret: 'session-secret',
      pluginId,
      remoteInputId: 'delegate-login',
      roles: {
        [adminSegmentId]: { name: 'Admin' },
        [vipSegmentId]: { name: 'VIP' }
      },
      loadRolesOnLogin: false,
      fetchImpl: await jwksFetch(publicKey, 'session-roles-key')
    });

    const sign = () =>
      signDelegateJwt({
        privateKey,
        kid: 'session-roles-key',
        issuer: 'https://delegate.example.test'
      });
    const first = await auth.login(await sign());
    await auth.grantRole(first.session.personId, vipSegmentId);
    const again = await auth.login(await sign());
    assert.equal(again.session.personId, first.session.personId);
    assert.deepEqual(again.session.roles, [], 'session roles stay empty when loadRolesOnLogin is false');
    assert.equal(sessionNeedsRole(again.session), true);
    assert.deepEqual(await auth.rolesForPerson(first.session.personId), [vipSegmentId]);
  } finally {
    await worker.destroy();
  }
});

test('classifyDelegateLoginToken and createSessionCookieHeaders', () => {
  assert.equal(classifyDelegateLoginToken('a'.repeat(64).replace(/./g, '0')), 'unknown');
  assert.equal(classifyDelegateLoginToken('one-time-code'), 'unknown');
  assert.equal(classifyDelegateLoginToken('abc.def'), 'unknown');
  assert.equal(
    classifyDelegateLoginToken('eyJhbGciOiJFUzI1NiJ9.eyJ1bmlkIjoidSJ9.sig'),
    'jwt'
  );
  const cookie = createSessionCookieHeaders('tok.val', { cookieName: 'session', maxAge: 60, secure: true });
  assert.match(cookie, /^session=tok\.val;/);
  assert.match(cookie, /Max-Age=60/);
  assert.match(cookie, /SameSite=lax/i);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test('createDelegateAuth: login() with JWT creates session with level/profileId', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-jwt');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-delegate-jwt', name: 'Test Delegate JWT' });

    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'ES256';
    jwk.use = 'sig';

    const jwt = await signDelegateJwt({
      privateKey,
      profile: { id: 'prof-1', email: 'alice@example.com', email_verified: true, display_name: 'Alice' },
      sub: 'prof-1'
    });

    const fetchImpl = async (url) => {
      assert.match(String(url), /\/\.well-known\/jwks\.json$/);
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    };

    const verifiedUser = await verifyDelegateIdentityToken({
      token: jwt,
      delegateUrl: 'https://delegate.engine9.ai',
      site: 'https://site.example.com',
      fetchImpl
    });
    assert.equal(verifiedUser.unid, UNID_A);
    assert.equal(verifiedUser.level, 2);
    assert.equal(verifiedUser.profileId, 'prof-1');
    assert.equal(verifiedUser.email, 'alice@example.com');
    assert.equal(verifiedUser.emailVerified, true);
    assert.equal(verifiedUser.firebaseUid, undefined, 'JWT path does not require firebaseUid');
    assert.equal(verifiedUser.auth.signInProvider, 'google.com');
    assert.equal(verifiedUser.auth.twoFactor, true);

    await assert.rejects(
      verifyDelegateIdentityToken({
        token: jwt,
        delegateUrl: 'https://delegate.engine9.ai',
        site: 'https://other.example.com',
        fetchImpl
      }),
      (err) => err.reason === 'invalid_site'
    );

    const byUnid = new Map();
    let nextPersonId = 1;
    worker.processPeople = async ({ batch }) => {
      const personIds = (batch || []).map((row) => {
        const unid = row.delegate_id;
        if (unid && byUnid.has(unid)) return byUnid.get(unid);
        const id = nextPersonId++;
        if (unid) byUnid.set(unid, id);
        return id;
      });
      return { personIds, records: personIds.length, recordsWithPersonIds: personIds.length };
    };

    const auth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.engine9.ai',
      site: 'https://site.example.com',
      sessionSecret: 'session-secret',
      pluginId,
      fetchImpl
    });

    const { session, token, delegateUser } = await auth.login(jwt, {
      returnTo: 'https://site.example.com/auth/delegate'
    });
    assert.ok(session.personId > 0);
    assert.equal(session.unid, UNID_A);
    assert.equal(session.level, 2);
    assert.equal(session.profileId, 'prof-1');
    assert.equal(session.email, 'alice@example.com');
    assert.equal(session.auth.signInProvider, 'google.com');
    assert.equal(session.auth.twoFactor, true);
    assert.equal(delegateUser.firebaseUid, undefined, 'JWT path does not require firebaseUid');
    assert.equal(delegateUser.emailVerified, true);

    const verified = auth.verify(token);
    assert.equal(verified.personId, session.personId);
    assert.equal(verified.level, 2);
    assert.equal(verified.profileId, 'prof-1');

    const again = await auth.verifyIdentityToken(jwt);
    assert.equal(again.unid, UNID_A);
    assert.equal(again.profileId, 'prof-1');
  } finally {
    await worker.destroy();
  }
});
