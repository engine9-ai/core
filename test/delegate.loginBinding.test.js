import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  createDelegateAuth,
  createSessionToken,
  verifySessionToken,
  readCookie,
  LOGIN_TOKEN_TTL_SECONDS
} from '../auth/delegate.js';
import { signPayload } from '../auth/hmac.js';

const DELEGATE_URL = 'https://delegate.engine9.ai';
const DOMAIN = 'site.example.com';
const UNID = `${DOMAIN}:${'c'.repeat(64)}`;
const ROLE_A = '00000000-0000-4000-8000-00000000000a';
const ROLE_B = '00000000-0000-4000-8000-00000000000b';

async function setup({ authOptions = {} } = {}) {
  const kid = `binding-${Math.random().toString(16).slice(2)}`;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const sign = ({ nonce } = {}) => {
    const jwt = new SignJWT({ level: 1, nonce, auth: {} });
    jwt.setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' });
    jwt.setIssuer(DELEGATE_URL).setAudience(DOMAIN).setSubject(UNID).setIssuedAt().setExpirationTime('5m');
    return jwt.sign(privateKey);
  };
  const memberships = new Set([ROLE_A]);
  const worker = {
    accountId: 'test',
    async processPeople() {
      return { personIds: [7], records: 1, recordsWithPersonIds: 1 };
    },
    queries: 0,
    async query({ values }) {
      this.queries += 1;
      const [, ...roleIds] = values;
      return { data: roleIds.filter((id) => memberships.has(id)).map((segment_id) => ({ segment_id })) };
    }
  };
  const auth = createDelegateAuth({
    worker,
    delegateUrl: DELEGATE_URL,
    domain: DOMAIN,
    sessionSecret: 'binding-secret',
    pluginId: 'p',
    roles: { [ROLE_A]: { name: 'A' }, [ROLE_B]: { name: 'B' } },
    jwks: { keys: [jwk] },
    ...authOptions
  });
  return { auth, sign, worker, memberships };
}

function cookieFromSetCookie(setCookie) {
  return setCookie.split(';')[0];
}

test('beginLogin / finishLogin bind the return to the browser that started it', async () => {
  const { auth, sign } = await setup();
  const started = auth.beginLogin({ returnTo: `https://${DOMAIN}/auth/callback` });
  const url = new URL(started.url);
  assert.equal(url.searchParams.get('state'), started.state);
  assert.equal(url.searchParams.get('nonce'), started.nonce);
  assert.equal(url.searchParams.get('expires_in'), String(LOGIN_TOKEN_TTL_SECONDS));
  assert.match(started.cookie, /^e9_login=.+; Max-Age=600; Path=\/; SameSite=lax; HttpOnly; Secure$/);
  const cookie = cookieFromSetCookie(started.cookie);

  const token = await sign({ nonce: started.nonce });
  const done = await auth.finishLogin(token, { state: started.state, cookie });
  assert.equal(done.session.personId, 7);
  assert.match(done.clearCookie, /^e9_login=; Max-Age=0/);

  // Another browser opening the same return link has no cookie.
  await assert.rejects(auth.finishLogin(token, { state: started.state, cookie: '' }), (err) => {
    assert.equal(err.reason, 'state_mismatch');
    assert.equal(err.kind, 'auth');
    assert.match(err.clearCookie, /Max-Age=0/);
    return true;
  });

  // This browser, but a return from someone else's sign-in.
  const other = auth.beginLogin({ returnTo: `https://${DOMAIN}/auth/callback` });
  const otherToken = await sign({ nonce: other.nonce });
  await assert.rejects(
    auth.finishLogin(otherToken, { state: other.state, cookie }),
    (err) => err.reason === 'state_mismatch'
  );
  // Matching state but a token minted for a different nonce.
  await assert.rejects(
    auth.finishLogin(otherToken, { state: started.state, cookie }),
    (err) => err.reason === 'state_mismatch'
  );
  // The session secret signs the login cookie, but it is not a session.
  assert.equal(auth.verify(readCookie(cookie, 'e9_login')), null);
});

test('login({ nonce }) and identityUrl expires_in', async () => {
  const { auth, sign } = await setup();
  const token = await sign({ nonce: 'n1' });
  await assert.rejects(auth.login(token, { nonce: 'n2' }), (err) => err.reason === 'state_mismatch');
  assert.equal((await auth.login(token, { nonce: 'n1' })).session.personId, 7);
  assert.equal((await auth.login(token)).session.personId, 7, 'no nonce passed: not checked');

  const longer = new URL(auth.identityUrl({ returnTo: `https://${DOMAIN}/cb`, expiresIn: 3600 }));
  assert.equal(longer.searchParams.get('expires_in'), '3600');
  const delegateDefault = new URL(auth.identityUrl({ returnTo: `https://${DOMAIN}/cb`, expiresIn: null }));
  assert.equal(delegateDefault.searchParams.has('expires_in'), false);
});

test('session tokens carry a purpose; other purposes and (optionally) untyped tokens are refused', async () => {
  const typed = createSessionToken({ personId: 1 }, { secret: 's' });
  const payload = verifySessionToken(typed, { secret: 's' });
  assert.equal(payload.typ, 'e9.session');
  assert.ok(payload.sid && payload.iat);
  const flow = createSessionToken({ personId: 1 }, { secret: 's', typ: 'site.flow' });
  assert.equal(verifySessionToken(flow, { secret: 's' }), null);
  assert.equal(verifySessionToken(flow, { secret: 's', typ: 'site.flow' }).personId, 1);

  // A token minted by an earlier release (no typ).
  const { auth } = await setup();
  const { auth: strict } = await setup({ authOptions: { acceptLegacySessions: false } });
  const encoded = Buffer.from(JSON.stringify({ personId: 7, roles: [], exp: Date.now() + 60000 })).toString('base64url');
  const legacy = `${encoded}.${signPayload(encoded, 'binding-secret')}`;
  assert.equal(auth.verify(legacy).personId, 7);
  assert.equal(strict.verify(legacy), null);
});

test('logout revokes a session when sessionRevocations is configured', async () => {
  const store = new Map();
  const kv = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, opts) {
      assert.ok(opts.expirationTtl >= 60);
      store.set(key, value);
    }
  };
  const { auth, sign } = await setup({ authOptions: { sessionRevocations: kv } });
  const { token } = await auth.login(await sign());
  assert.equal((await auth.verifySession(token)).personId, 7);
  assert.equal(await auth.logout(token), true);
  assert.equal(await auth.verifySession(token), null);
  assert.ok(auth.verify(token), 'verify() alone does not see revocations');
});

test('session roles are the copy made at login; rolesForPerson reads membership now', async () => {
  const { auth, sign, worker, memberships } = await setup();
  const { token } = await auth.login(await sign());
  const queriesAfterLogin = worker.queries;
  memberships.delete(ROLE_A);
  assert.deepEqual((await auth.verifySession(token)).roles, [ROLE_A], 'the token keeps its copy');
  assert.equal(worker.queries, queriesAfterLogin, 'reading a session does not query');
  assert.deepEqual(await auth.rolesForPerson(7), [], 'a privileged check sees the removal');
});
