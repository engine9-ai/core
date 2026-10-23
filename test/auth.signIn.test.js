import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { requireRole, createGate } from '../auth/gate.js';
import { safeReturnPath, withQueryParam, sessionTokenFromCookie } from '../auth/signIn.js';
import { installDefaultPluginsSite } from '../bin/upgrade.js';

const DELEGATE_URL = 'https://delegate.network';
const HOST = 'site.example.com';
const SITE = `https://${HOST}`;
const UNID = `${HOST}:${'c'.repeat(64)}`;
const ADMIN = '00000000-0000-4000-8000-0000000000ad';

async function setup({ roleMember = true, level = 3, signIn = {}, secureSite = true } = {}) {
  const kid = `signin-${Math.random().toString(16).slice(2)}`;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const sign = ({ nonce, aud = HOST }) => {
    const jwt = new SignJWT({ level, nonce, auth: {}, fields: { email: 'ada@example.com', email_verified: true } });
    jwt.setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' });
    jwt.setIssuer(DELEGATE_URL).setAudience(aud).setSubject(UNID).setIssuedAt().setExpirationTime('5m');
    return jwt.sign(privateKey);
  };
  const worker = {
    accountId: 'test',
    async processPeople() {
      return { personIds: [7], records: 1, recordsWithPersonIds: 1 };
    },
    async query({ values }) {
      const [, ...roleIds] = values;
      return { data: roleIds.filter((id) => roleMember && id === ADMIN).map((segment_id) => ({ segment_id })) };
    }
  };
  const delegateAuth = createDelegateAuth({
    worker,
    delegateUrl: DELEGATE_URL,
    sessionSecret: 'signin-secret',
    pluginId: 'p',
    roles: { [ADMIN]: { name: 'Admin', scopes: ['admin'], requiredAuth: { minLevel: 3 } } },
    jwks: { keys: [jwk] }
  });
  // A public key: enough for /auth/me and /auth/logout, which read the session.
  const keyStore = {
    verify: async (req) => {
      const header = req.headers?.get?.('authorization') || '';
      return header === 'Bearer e9publickey_test'
        ? { valid: true, key: { id: 'k1', scopes: ['public'] } }
        : { valid: false, reason: 'missing_key' };
    }
  };
  const api = createApi({ worker, keyStore, delegateAuth, config: { pluginId: 'p', signIn } });
  const base = secureSite ? SITE : `http://${HOST}`;
  const get = (path, headers = {}) => api.handleFetch(new Request(`${base}${path}`, { headers }));
  return { api, delegateAuth, sign, get, base };
}

function cookiesOf(response) {
  return response.headers.getSetCookie().map((c) => c.split(';')[0]);
}

function jar(response) {
  return cookiesOf(response)
    .filter((c) => !/=$/.test(c))
    .join('; ');
}

test('safeReturnPath keeps only paths on this site', () => {
  assert.equal(safeReturnPath('/members?x=1#top'), '/members?x=1#top');
  assert.equal(safeReturnPath(undefined), '/');
  assert.equal(safeReturnPath('//evil.example'), '/');
  assert.equal(safeReturnPath('https://evil.example/x', { origin: SITE }), '/');
  assert.equal(safeReturnPath('/\\evil.example'), '/');
  assert.equal(safeReturnPath('/a\r\nSet-Cookie: x=1'), '/');
  assert.equal(safeReturnPath('javascript:alert(1)'), '/');
  assert.equal(safeReturnPath(`${SITE}/back?x=1`, { origin: SITE }), '/back?x=1');
  assert.equal(withQueryParam('/a?x=1#h', 'login_error', 'declined'), '/a?x=1&login_error=declined#h');
  assert.equal(sessionTokenFromCookie('a=1; e9_session=tok; b=2'), 'tok');
});

test('GET /auth/start redirects to Delegate without an API key', async () => {
  const { get } = await setup({
    signIn: { brand: { name: 'My Site' }, loginProviders: ['google'] }
  });
  const res = await get('/api/auth/start?returnTo=/members&login_hint=ada@example.com&prompt=select');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const url = new URL(res.headers.get('location'));
  assert.equal(url.origin, DELEGATE_URL);
  assert.equal(url.pathname, '/identity/authorize');
  const q = url.searchParams;
  assert.equal(q.get('domain'), HOST);
  assert.equal(q.get('return_to'), `${SITE}/api/auth/callback`);
  assert.equal(q.get('brand_google'), null);
  assert.equal(q.get('brand_name'), 'My Site');
  assert.equal(q.get('consent'), null);
  assert.equal(q.get('login_hint'), 'ada@example.com');
  assert.equal(q.get('prompt'), 'select');
  assert.equal(q.get('fields'), 'email');
  assert.ok(q.get('state') && q.get('nonce'));
  const [login] = res.headers.getSetCookie();
  assert.match(login, /^e9_login=.+HttpOnly; Secure$/);
});

test('start ignores an off-site returnTo and a junk login_hint', async () => {
  const { get, delegateAuth, sign } = await setup();
  const res = await get('/api/auth/start?returnTo=https://evil.example/&login_hint=not-an-email&prompt=none');
  const q = new URL(res.headers.get('location')).searchParams;
  assert.equal(q.get('login_hint'), null);
  assert.equal(q.get('prompt'), null);
  const done = await get(
    `/api/auth/callback?state=${q.get('state')}&delegate_token=${await sign({ nonce: q.get('nonce') })}`,
    { cookie: jar(res) }
  );
  assert.equal(done.headers.get('location'), '/');
  assert.ok(delegateAuth);
});

test('callback sets the Core Session cookie once and returns to returnTo', async () => {
  const { get, delegateAuth, sign } = await setup();
  const start = await get('/api/auth/start?returnTo=/members');
  const q = new URL(start.headers.get('location')).searchParams;
  const token = await sign({ nonce: q.get('nonce') });
  const done = await get(`/api/auth/callback?state=${q.get('state')}&delegate_token=${token}`, {
    cookie: jar(start)
  });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/members');
  const cookies = done.headers.getSetCookie();
  assert.equal(cookies.length, 2, 'session cookie and cleared login cookie are separate headers');
  const session = cookies.find((c) => c.startsWith('e9_session='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=lax/i);
  assert.ok(cookies.some((c) => /^e9_login=; Max-Age=0/.test(c)));
  const verified = await delegateAuth.verifySession(sessionTokenFromCookie(session));
  assert.equal(verified.personId, 7);
});

test('callback: another browser, a replay, or no token sends the visitor to sign in again, no error', async () => {
  const { get, sign } = await setup();
  const start = await get('/api/auth/start?returnTo=/members');
  const q = new URL(start.headers.get('location')).searchParams;
  const token = await sign({ nonce: q.get('nonce') });
  const other = await get(`/api/auth/callback?state=${q.get('state')}&delegate_token=${token}`);
  assert.equal(other.status, 302);
  assert.equal(other.headers.get('location'), '/');
  assert.ok(!other.headers.getSetCookie().some((c) => c.startsWith('e9_session=')));
  const none = await get('/api/auth/callback');
  assert.equal(none.headers.get('location'), '/');
});

test('callback: a Delegate error comes back as login_error on returnTo; a bad token too', async () => {
  const { get, sign } = await setup();
  const start = await get('/api/auth/start?returnTo=/members');
  const q = new URL(start.headers.get('location')).searchParams;
  const declined = await get(`/api/auth/callback?state=${q.get('state')}&error=access_denied`, {
    cookie: jar(start)
  });
  assert.equal(declined.headers.get('location'), '/members?login_error=access_denied');
  assert.ok(!declined.headers.getSetCookie().some((c) => c.startsWith('e9_session=')));

  const wrongDomain = await sign({ nonce: q.get('nonce'), aud: 'other.example.com' });
  const bad = await get(`/api/auth/callback?state=${q.get('state')}&delegate_token=${wrongDomain}`, {
    cookie: jar(start)
  });
  assert.match(bad.headers.get('location'), /^\/members\?login_error=/);
  assert.ok(!bad.headers.getSetCookie().some((c) => c.startsWith('e9_session=')));
});

test('without delegate login, the sign-in routes answer 501', async () => {
  const worker = { accountId: 'test' };
  const api = createApi({ worker, keyStore: { verify: async () => ({ valid: false, reason: 'missing_key' }) }, config: {} });
  const res = await api.handleFetch(new Request(`${SITE}/api/auth/start`));
  assert.equal(res.status, 501);
});

test('an http site gets cookies without Secure', async () => {
  const { get } = await setup({ secureSite: false });
  const res = await get('/api/auth/start');
  assert.ok(!/Secure/.test(res.headers.getSetCookie()[0]));
});

async function signedIn(ctx) {
  const start = await ctx.get('/api/auth/start?returnTo=/members');
  const q = new URL(start.headers.get('location')).searchParams;
  const token = await ctx.sign({ nonce: q.get('nonce') });
  const done = await ctx.get(`/api/auth/callback?state=${q.get('state')}&delegate_token=${token}`, {
    cookie: jar(start)
  });
  return jar(done);
}

test('requireRole: signed out → sign-in redirect for a page, 401 for a POST', async () => {
  const ctx = await setup();
  const page = await requireRole({
    auth: ctx.delegateAuth,
    request: new Request(`${SITE}/preview?x=1`),
    role: 'admin'
  });
  assert.equal(page.ok, false);
  assert.equal(page.status, 302);
  assert.equal(page.response.headers.get('location'), '/api/auth/start?returnTo=%2Fpreview%3Fx%3D1');
  const post = await requireRole({
    auth: ctx.delegateAuth,
    request: new Request(`${SITE}/preview`, { method: 'POST' }),
    role: 'admin'
  });
  assert.equal(post.status, 401);
});

test('requireRole: the cookie from /auth/callback opens the gate for a current admin', async () => {
  const ctx = await setup();
  const cookie = await signedIn(ctx);
  const gate = createGate({ auth: ctx.delegateAuth });
  const result = await gate.requireRole(new Request(`${SITE}/preview`, { headers: { cookie } }), 'admin');
  assert.equal(result.ok, true);
  assert.deepEqual(result.roles, [ADMIN]);
  assert.equal(result.session.email, 'ada@example.com');
  assert.equal((await gate.session(new Request(SITE))), null);

  // A role name that is not configured is a bug in the site, not a visitor problem.
  await assert.rejects(
    requireRole({ auth: ctx.delegateAuth, request: new Request(SITE, { headers: { cookie } }), role: 'nope' }),
    /unknown role/
  );
});

test('requireRole: signed in without the role (or below the role level) gets a 403 page', async () => {
  const notMember = await setup({ roleMember: false });
  const cookie = await signedIn(notMember);
  const denied = await requireRole({
    auth: notMember.delegateAuth,
    request: new Request(`${SITE}/preview`, { headers: { cookie } }),
    role: 'admin'
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  const html = await denied.response.text();
  assert.match(html, /ada@example\.com/);
  assert.match(html, /prompt=select/);

  // Anyone signed in passes when no role is asked for.
  const anyone = await requireRole({
    auth: notMember.delegateAuth,
    request: new Request(`${SITE}/preview`, { headers: { cookie } })
  });
  assert.equal(anyone.ok, true);

  const lowLevel = await setup({ level: 1 });
  const lowCookie = await signedIn(lowLevel);
  const low = await requireRole({
    auth: lowLevel.delegateAuth,
    request: new Request(`${SITE}/preview`, { headers: { cookie: lowCookie } }),
    role: 'admin'
  });
  assert.equal(low.status, 403);
});

test('requireRole reads the role from the database now, not from the cookie', async () => {
  const ctx = await setup();
  const cookie = await signedIn(ctx);
  const request = () => new Request(`${SITE}/preview`, { headers: { cookie } });
  assert.equal((await requireRole({ auth: ctx.delegateAuth, request: request(), role: 'admin' })).ok, true);
  // Same cookie, but the person has since left the role.
  const removed = await setup({ roleMember: false });
  const stale = await requireRole({
    auth: removed.delegateAuth,
    request: new Request(`${SITE}/preview`, { headers: { cookie: await signedIn(removed) } }),
    role: 'admin'
  });
  assert.equal(stale.ok, false);
});

test('the session cookie authenticates /auth/me, and /auth/logout clears it', async () => {
  const ctx = await setup();
  const cookie = await signedIn(ctx);
  const headers = { cookie, authorization: 'Bearer e9publickey_test', 'content-type': 'application/json' };
  const me = await ctx.api.handleFetch(new Request(`${SITE}/api/auth/me`, { headers }));
  assert.equal(me.status, 200, await me.clone().text());
  const body = await me.json();
  assert.equal(body.personId, 7);
  assert.deepEqual(body.roles, [ADMIN]);
  const out = await ctx.api.handleFetch(
    new Request(`${SITE}/api/auth/logout`, { method: 'POST', headers, body: '{}' })
  );
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /^e9_session=; Max-Age=0; Path=\/; SameSite=Lax; HttpOnly; Secure$/);
  // A request with no cookie has nothing to clear.
  const bare = await ctx.api.handleFetch(
    new Request(`${SITE}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: 'Bearer e9publickey_test', 'content-type': 'application/json' },
      body: '{}'
    })
  );
  assert.deepEqual(bare.headers.getSetCookie(), []);
});

test('installDefaultPluginsSite posts to /admin/install-default-plugins', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ complete: true }), { status: 200 });
  };
  const result = await installDefaultPluginsSite({
    url: 'https://www.example.com',
    key: 'e9key_x',
    path: '@engine9/schemas/stacks/standard',
    fetchImpl
  });
  assert.equal(result.complete, true);
  assert.equal(calls[0].url, 'https://www.example.com/api/admin/install-default-plugins');
  assert.equal(calls[0].init.headers.authorization, 'Bearer e9key_x');
  assert.deepEqual(JSON.parse(calls[0].init.body), { path: '@engine9/schemas/stacks/standard' });
});
