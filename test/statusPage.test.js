/*
  GET /api/admin/status opened in a browser with no API key: the status
  report as a page for a signed-in admin (api/statusPage.js), gated by
  requireRole. Every other admin route, and the JSON answer, still need the
  admin key.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';

const ACCOUNT_ID = 'status-page';
const SITE = 'https://site.example.com';
const SECRET = '0123456789abcdef'.repeat(4);

async function site({ withLogin = true } = {}) {
  const worker = new PersonWorker({ accountId: ACCOUNT_ID, auth: { database_connection: 'sqlite://:memory:' } });
  await applyStandardStack(worker);
  const pluginId = getPluginUUID(ACCOUNT_ID, 'website');
  await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
  const keyStore = new SqlApiKeyStore({ worker });
  await keyStore.deploy();
  const admin = (await keyStore.create({ name: 'site-admin', scopes: ['admin'] })).key;
  const delegateAuth = withLogin
    ? createDelegateAuth({
        worker,
        delegateUrl: 'https://delegate.example.test',
        sessionSecret: SECRET,
        pluginId,
        roles: 'standard',
        superadmins: ['ops@example.com']
      })
    : null;
  const api = createApi({ worker, keyStore, delegateAuth, environment: {}, config: { pluginId, roles: 'standard' } });
  const cookieFor = (email, level) =>
    `e9_session=${delegateAuth.issueToken({ personId: 7, roles: [], email, level, auth: {}, domainUnid: 'x.example:1' })}`;
  const open = (headers = {}) =>
    api.handleFetch(new Request(`${SITE}/api/admin/status`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', ...headers } }));
  return { worker, api, admin, cookieFor, open };
}

test('status page: a signed-in superadmin sees the report as a page, with fixes that need no terminal', async () => {
  const ctx = await site();
  try {
    const res = await ctx.open({ cookie: ctx.cookieFor('ops@example.com', 3) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.match(html, /Site status: https:\/\/site\.example\.com/);
    assert.match(html, /signed in as ops@example\.com/);
    assert.match(html, /SESSION_SECRET is not set/);
    assert.match(html, /Run the deploy workflow again/);
    assert.match(html, /or, with a terminal: npx e9core setup-keys --remote/);
    assert.doesNotMatch(html, /<script/i);
  } finally {
    await ctx.worker.destroy();
  }
});

test('status page: signed out is sent to sign in; without the role or below Level 3 it is a 403', async () => {
  const ctx = await site();
  try {
    const out = await ctx.open();
    assert.equal(out.status, 302);
    assert.equal(out.headers.get('location'), '/api/auth/start?returnTo=%2Fapi%2Fadmin%2Fstatus');

    const stranger = await ctx.open({ cookie: ctx.cookieFor('someone@example.com', 4) });
    assert.equal(stranger.status, 403);
    assert.match(await stranger.text(), /You don't have access/);

    const weak = await ctx.open({ cookie: ctx.cookieFor('ops@example.com', 2) });
    assert.equal(weak.status, 403, 'a superadmin signed in below Level 3 does not hold admin');
  } finally {
    await ctx.worker.destroy();
  }
});

test('status page: a database admin (person_segment) at Level 3 sees it too', async () => {
  const ctx = await site();
  try {
    await ctx.api.handle({
      method: 'POST',
      path: '/auth/segments',
      headers: { authorization: `Bearer ${ctx.admin}` },
      body: { add: [{ segment_id: 'admin', email: 'owner@example.com' }] }
    });
    const { data } = await ctx.worker.query({
      sql: 'select person_id from person_email where email = ?',
      values: ['owner@example.com']
    });
    const personId = data[0].person_id;
    const cookie = `e9_session=${ctx.api.delegateAuth.issueToken({ personId, roles: [], email: 'owner@example.com', level: 3, auth: {}, domainUnid: 'x.example:1' })}`;
    const res = await ctx.open({ cookie });
    assert.equal(res.status, 200, await res.clone().text());
  } finally {
    await ctx.worker.destroy();
  }
});

test('status page: JSON and every other admin route still need the admin key', async () => {
  const ctx = await site();
  try {
    const cookie = ctx.cookieFor('ops@example.com', 3);
    const fetched = await ctx.api.handleFetch(
      new Request(`${SITE}/api/admin/status`, { headers: { accept: 'application/json', 'sec-fetch-mode': 'cors', cookie } })
    );
    assert.equal(fetched.status, 401);
    assert.equal((await fetched.json()).reason, 'missing_key');

    const upgrade = await ctx.api.handleFetch(
      new Request(`${SITE}/api/admin/upgrade`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    );
    assert.equal(upgrade.status, 401);

    const withKey = await ctx.api.handle({ method: 'GET', path: '/admin/status', headers: { authorization: `Bearer ${ctx.admin}` }, apiBase: `${SITE}/api` });
    assert.equal(withKey.status, 200);
    const secret = withKey.body.checks.find((c) => c.id === 'secrets.SESSION_SECRET');
    assert.match(secret.fix_web, /deploy workflow/);
  } finally {
    await ctx.worker.destroy();
  }
});

test('status page: an Express-style request (plain header object) works the same', async () => {
  const ctx = await site();
  try {
    const result = await ctx.api.handle({
      method: 'GET',
      path: '/admin/status',
      headers: { accept: 'text/html', cookie: ctx.cookieFor('ops@example.com', 3) },
      query: {},
      apiBase: `${SITE}/api`
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /signed in as ops@example\.com/);
  } finally {
    await ctx.worker.destroy();
  }
});

test('without SESSION_SECRET, the status page and /auth/* say which secret is missing and how to make it', async () => {
  const ctx = await site({ withLogin: false });
  try {
    const page = await ctx.open();
    assert.equal(page.status, 501);
    assert.match(await page.text(), /SESSION_SECRET is not set/);
    const login = await ctx.api.handle({ method: 'GET', path: '/auth/start', query: {}, headers: {}, apiBase: `${SITE}/api` });
    assert.equal(login.status, 501);
    assert.equal(login.body.reason, 'login_off');
    assert.equal(login.body.missing, 'SESSION_SECRET');
    assert.equal(login.body.fix, 'npx e9core setup-keys --remote');
    assert.match(login.body.fix_web, /deploy workflow/);
  } finally {
    await ctx.worker.destroy();
  }
});
