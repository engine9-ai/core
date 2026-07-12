import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';
import {
  createSessionToken,
  verifySessionToken,
  exchangeDelegateCode,
  delegateAuthorizeUrl,
  resolveDelegatePersonId,
  createDelegateAuth,
  createDelegateLoginFailure,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole
} from '../auth/delegate.js';
import { getVersionedUUID } from '../lib/utilities.js';

const UNID_A = '11111111-2222-8001-8333-444444444444';
const UNID_B = '55555555-6666-8001-8777-888888888888';

test('delegate identities dedupe through the person pipeline (id_type "delegate")', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installStandard();
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-plugin');
    await worker.install({ type: 'local', id: pluginId, path: 'test-delegate-plugin', name: 'Test Delegate Plugin' });

    // First delegate login: creates a person and a person_id_delegate mapping
    const personId = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: UNID_A, email: 'alice@example.com' },
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
      delegateUser: { unid: UNID_A, email: 'alice@example.com' }
    });
    assert.equal(again, personId, 'repeat delegate login resolves to the same person');
    const { data: people } = await worker.query('select id from person');
    assert.equal(people.length, 1);

    // Known email arriving with a NEW unid -> dedupes to the same person via
    // the email hash, and the new delegate id is attached going forward
    const merged = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: UNID_B, email: 'alice@example.com' }
    });
    assert.equal(merged, personId, 'same email merges a new delegate id into the existing person');
    const { data: delegateIds2 } = await worker.query('select person_id from person_id_delegate');
    assert.equal(delegateIds2.length, 2, 'both unids now map to the person');
    assert.ok(delegateIds2.every((r) => r.person_id === personId));

    // Brand new person entirely
    const other = await resolveDelegatePersonId({
      worker,
      pluginId,
      delegateUser: { unid: 'aaaaaaaa-bbbb-8001-8ccc-dddddddddddd', email: 'bob@example.com' }
    });
    assert.notEqual(other, personId);
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
  const config = createDelegateLoginFailure('invalid_shared_secret');
  assert.equal(config.kind, 'configuration');
  assert.match(config.userMessage, /misconfigured/i);
  assert.match(config.userMessage, /DELEGATE_SHARED_SECRET/i);
  assert.doesNotMatch(config.userMessage, /try again/i);

  const auth = createDelegateLoginFailure('invalid_or_expired_code');
  assert.equal(auth.kind, 'auth');
  assert.match(auth.userMessage, /expired|already used/i);
  assert.match(auth.userMessage, /sign in again/i);

  const missing = createDelegateLoginFailure('missing_delegate_code');
  assert.equal(missing.kind, 'auth');

  const server = createDelegateLoginFailure('status_503');
  assert.equal(server.kind, 'configuration');

  const unknown = createDelegateLoginFailure('something_weird');
  assert.equal(unknown.kind, 'auth');
});

test('exchangeDelegateCode posts the shared secret and returns the payload', async () => {
  const calls = [];
  const payload = {
    unid: UNID_A,
    firebaseUid: 'fb-1',
    email: 'alice@example.com',
    auth: { loggedIn: true, twoFactor: false },
    returnTo: 'https://site.example.com/auth/delegate'
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const result = await exchangeDelegateCode({
    delegateUrl: 'https://delegate.engine9.ai',
    secret: 'shared-secret',
    code: 'abc123',
    fetchImpl
  });
  assert.deepEqual(result, payload);
  assert.equal(calls[0].url, 'https://delegate.engine9.ai/handoff/exchange');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer shared-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: 'abc123' });

  // Error surfaces the delegate reason, kind, and user-facing message
  const failing = async () => new Response(JSON.stringify({ error: 'invalid_or_expired_code' }), { status: 404 });
  await assert.rejects(
    exchangeDelegateCode({
      delegateUrl: 'https://delegate.engine9.ai',
      secret: 'shared-secret',
      code: 'stale',
      fetchImpl: failing
    }),
    (err) => {
      assert.equal(err.reason, 'invalid_or_expired_code');
      assert.equal(err.kind, 'auth');
      assert.match(err.userMessage, /expired|already used/i);
      return /invalid_or_expired_code/.test(err.message);
    }
  );

  const badSecret = async () => new Response(JSON.stringify({ error: 'invalid_shared_secret' }), { status: 401 });
  await assert.rejects(
    exchangeDelegateCode({
      delegateUrl: 'https://delegate.engine9.ai',
      secret: 'wrong-secret',
      code: 'abc',
      fetchImpl: badSecret
    }),
    (err) => {
      assert.equal(err.reason, 'invalid_shared_secret');
      assert.equal(err.kind, 'configuration');
      assert.match(err.userMessage, /DELEGATE_SHARED_SECRET/i);
      return /invalid_shared_secret/.test(err.message);
    }
  );

  // Cloudflare Bot Fight returns HTML 403 (non-JSON) to non-browser clients
  const challenged = async () =>
    new Response('<!DOCTYPE html><title>Just a moment...</title>', {
      status: 403,
      headers: { 'content-type': 'text/html' }
    });
  await assert.rejects(
    exchangeDelegateCode({
      delegateUrl: 'https://delegate.engine9.ai',
      secret: 'shared-secret',
      code: 'abc',
      fetchImpl: challenged
    }),
    (err) => {
      assert.equal(err.reason, 'cloudflare_challenge');
      assert.equal(err.kind, 'configuration');
      assert.match(err.userMessage, /Cloudflare|DELEGATE_URL|localhost:8787/i);
      return true;
    }
  );
});

test('createDelegateAuth: login -> person -> roles-as-segments -> signed session', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installStandard();
    const pluginId = getPluginUUID('engine9.test', 'test-delegate-site');
    await worker.install({ type: 'local', id: pluginId, path: 'test-delegate-site', name: 'Test Delegate Site' });

    // Roles are segments
    const vipSegmentId = getVersionedUUID();
    const adminSegmentId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [
        { id: vipSegmentId, plugin_id: pluginId, name: 'VIP', build_type: 'list' },
        { id: adminSegmentId, plugin_id: pluginId, name: 'Admin', build_type: 'list' }
      ]
    });

    // Stubbed delegate /handoff/exchange
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          unid: UNID_A,
          firebaseUid: 'fb-1',
          email: 'alice@example.com',
          auth: { loggedIn: true, signInProvider: 'google.com', twoFactor: true, authTime: 1234 },
          returnTo: 'https://site.example.com/auth/delegate'
        }),
        { status: 200 }
      );

    const auth = createDelegateAuth({
      worker,
      delegateUrl: 'https://delegate.engine9.ai',
      handoffSecret: 'shared-secret',
      sessionSecret: 'session-secret',
      pluginId,
      remoteInputId: 'delegate-login',
      roleSegments: { admin: adminSegmentId, vip: vipSegmentId },
      fetchImpl
    });

    assert.ok(
      auth.loginUrl({ returnTo: 'https://site.example.com/auth/delegate' }).includes('/handoff/authorize')
    );

    // First login: new person, no roles yet
    const { session, token } = await auth.login('one-time-code');
    assert.ok(session.personId > 0);
    assert.deepEqual(session.roles, []);
    assert.equal(session.unid, UNID_A);
    assert.equal(session.auth.signInProvider, 'google.com');
    assert.equal(session.auth.twoFactor, true, 'credential level travels into the session');
    assert.equal(sessionNeedsRole(session), true);

    // Token round-trips through verify
    const verified = auth.verify(token);
    assert.equal(verified.personId, session.personId);
    assert.deepEqual(verified.roles, []);
    assert.equal(auth.verify('tampered'), null);

    // Grant a role (segment membership) and confirm helpers see it
    const roles = await auth.grantRole(session.personId, 'vip');
    assert.deepEqual(roles, ['vip']);
    const { data: memberships } = await worker.query('select segment_id, person_id from person_segment');
    assert.deepEqual(memberships, [{ segment_id: vipSegmentId, person_id: session.personId }]);

    const updated = { ...session, roles };
    assert.equal(sessionHasRole(updated, 'vip', 'admin'), true);
    assert.equal(sessionHasRole(updated, 'admin'), false);
    assert.equal(sessionPrimaryRole(updated, ['admin', 'vip']), 'vip');
    assert.equal(sessionNeedsRole(updated), false);

    // Second login with the same unid: same person, roles picked up from segments
    const again = await auth.login('another-code');
    assert.equal(again.session.personId, session.personId, 'delegate id dedupes to the same person');
    assert.deepEqual(again.session.roles, ['vip']);

    await assert.rejects(auth.grantRole(session.personId, 'superuser'), /Unknown role/);
  } finally {
    await worker.destroy();
  }
});

test('delegateAuthorizeUrl builds the handoff login URL', () => {
  const url = delegateAuthorizeUrl({
    delegateUrl: 'https://delegate.engine9.ai',
    returnTo: 'https://site.example.com/auth/delegate'
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://delegate.engine9.ai');
  assert.equal(parsed.pathname, '/handoff/authorize');
  assert.equal(parsed.searchParams.get('return_to'), 'https://site.example.com/auth/delegate');
});
