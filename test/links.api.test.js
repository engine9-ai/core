/*
  Links in emails, through the HTTP API:

  - Link tokens (auth/linkTokens.js): an outside sender's signed note of
    which person an email went to. POST /people files a one-click row on
    that person, and nothing else: a row with an address is filed by the
    address, a token never joins an identifier, never signs in, and only
    listed senders, for this account, count.
  - Sign-in links (auth/delegate.js createSignInLink, auth/logins.js): an
    admin's emailed link that signs a person in without Delegate. Only for
    an address with a login; opening it changes nothing; it works once; the
    session is Identity Level 2, so admin (Level 3) does not apply.
*/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { createDelegateAuth, createSessionToken, SIGN_IN_LINK_TOKEN_TYPE } from '../auth/delegate.js';
import { ensureRoleSegments, roleSegmentId } from '../auth/roles.js';
import { loginRow, linkLogin, lockLogin } from '../auth/logins.js';
import { requireRole } from '../auth/gate.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyWebsitePlugins, ensurePluginRow } from './helpers/applySchemas.js';
import { generateLinkIssuer, createLinkToken, parseLinkIssuers, verifyLinkToken } from '../auth/linkTokens.js';
import { applyLinkToken } from '../api/publicRows.js';

const HOST = 'site.example.com';
const SITE = `https://${HOST}`;
const SECRET = '0123456789abcdef'.repeat(4);
const workers = [];
after(async () => {
  for (const w of workers) await w.destroy?.();
});

async function setup() {
  const worker = new PersonWorker({ accountId: 'links', auth: { database_connection: 'sqlite://:memory:' } });
  workers.push(worker);
  await applyWebsitePlugins(worker);
  const pluginId = getPluginUUID(worker.accountHandle, 'website');
  await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
  await ensureRoleSegments({ worker, accountId: worker.accountHandle });
  const admin = roleSegmentId(worker.accountHandle, 'admin');

  const acme = await generateLinkIssuer({ name: 'acme' });
  const stranger = await generateLinkIssuer({ name: 'stranger' });
  const audit = [];
  const delegateAuth = createDelegateAuth({ worker, sessionSecret: SECRET, pluginId, roles: 'standard', jwks: { keys: [] } });
  const keyStore = new SqlApiKeyStore({ worker });
  await keyStore.deploy();
  const { key: publicKey } = await keyStore.create({ name: 'form', scopes: ['public'] });
  const { key: writeKey } = await keyStore.create({ name: 'crm', scopes: ['people:write'] });
  const { key: adminKey } = await keyStore.create({ name: 'admin', scopes: ['admin'] });
  const api = createApi({
    worker,
    keyStore,
    delegateAuth,
    audit: { log: async (r) => audit.push(r), flush: async () => {} },
    config: { pluginId, roles: 'standard', linkIssuers: JSON.stringify([acme.issuer]) }
  });

  const call = async (method, path, { key = publicKey, body, cookie, origin = SITE, form = false } = {}) => {
    const headers = { origin };
    if (key) headers.authorization = `Bearer ${key}`;
    if (cookie) headers.cookie = cookie;
    let payload;
    if (method !== 'GET') {
      payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body || {});
      headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    }
    if (origin === null) delete headers.origin;
    const res = await api.handleFetch(new Request(`${SITE}/api${path}`, { method, headers, body: payload }));
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]), headers: res.headers };
  };
  const token = (personId, opts = {}) =>
    createLinkToken({ privateKey: acme.privateKey, issuer: 'acme', audience: worker.accountHandle, personId, ...opts });
  const crmPerson = async (row) =>
    (await call('POST', '/people', { key: writeKey, body: { people: [row] } })).body.personIds[0];
  const emailsOf = async (pid) =>
    (await worker.query({ sql: 'select email from person_email where person_id=?', values: [pid] })).data.map((r) => r.email);
  return { worker, api, call, token, crmPerson, emailsOf, acme, stranger, admin, adminKey, delegateAuth, audit };
}

/* ------------------------------------------------------------ link tokens */

test('link issuers: public keys only, ES256, one entry per name', async () => {
  const { privateKey, issuer } = await generateLinkIssuer({ name: 'acme' });
  assert.equal(parseLinkIssuers([issuer]).length, 1);
  assert.throws(() => parseLinkIssuers([{ name: 'acme', publicKey: privateKey }]), /private key/);
  assert.throws(() => parseLinkIssuers([issuer, issuer]), /listed twice/);
  assert.throws(() => parseLinkIssuers([{ name: 'acme', publicKey: { kty: 'RSA' } }]), /ES256/);
  assert.throws(() => parseLinkIssuers('not json'), /JSON array/);
  assert.deepEqual(parseLinkIssuers(''), []);
});

test('verifyLinkToken: only a listed sender, for this account, unexpired, never a sign-in', async () => {
  const acme = await generateLinkIssuer({ name: 'acme' });
  const other = await generateLinkIssuer({ name: 'acme' }); // same name, another key
  const issuers = [acme.issuer];
  const make = (o = {}) => createLinkToken({ privateKey: acme.privateKey, issuer: 'acme', audience: 'org-a', personId: 7, sourceCode: 'em-1', ...o });
  const ok = await verifyLinkToken(await make(), { issuers, audience: 'org-a' });
  assert.deepEqual([ok.ok, ok.issuer, ok.personId, ok.sourceCode], [true, 'acme', 7, 'em-1']);
  assert.equal((await verifyLinkToken(await make(), { issuers, audience: 'org-b' })).ok, false, 'another account');
  assert.equal((await verifyLinkToken(await make({ expiresIn: -10 }), { issuers, audience: 'org-a' })).reason, 'the link token has expired');
  const forged = await createLinkToken({ privateKey: other.privateKey, issuer: 'acme', audience: 'org-a', personId: 7 });
  assert.equal((await verifyLinkToken(forged, { issuers, audience: 'org-a' })).ok, false, 'a key the site does not list');
  const t = await make();
  const tampered = t.split('.');
  tampered[1] = Buffer.from(JSON.stringify({ iss: 'acme', aud: 'org-a', sub: '8', exp: 9999999999 })).toString('base64url');
  assert.equal((await verifyLinkToken(tampered.join('.'), { issuers, audience: 'org-a' })).ok, false, 'a changed person');
  // A token that says login is refused even when signed by a listed sender.
  const { SignJWT, importJWK } = await import('jose');
  const login = await new SignJWT({ login: true })
    .setProtectedHeader({ alg: 'ES256', typ: 'e9-link+jwt' })
    .setIssuer('acme').setAudience('org-a').setSubject('7').setExpirationTime('1h')
    .sign(await importJWK(acme.privateKey, 'ES256'));
  assert.equal((await verifyLinkToken(login, { issuers, audience: 'org-a' })).reason, 'a link token cannot sign anyone in');
  const plainJwt = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuer('acme').setAudience('org-a').setSubject('7').setExpirationTime('1h')
    .sign(await importJWK(acme.privateKey, 'ES256'));
  assert.equal((await verifyLinkToken(plainJwt, { issuers, audience: 'org-a' })).ok, false, 'another kind of JWT');
});

test('applyLinkToken: one row that names nobody; src fills an empty source code', () => {
  const link = { ok: true, personId: 7, sourceCode: 'em-1' };
  assert.deepEqual(applyLinkToken([{ action: 'sign' }], link).rows, [{ action: 'sign', person_id: 7, source_code: 'em-1' }]);
  assert.equal(applyLinkToken([{ source_code: 'page' }], link).rows[0].source_code, 'page');
  assert.equal(applyLinkToken([{}], link, { defaultSourceCode: 'opt' }).rows[0].source_code, undefined);
  for (const field of ['email', 'phone', 'cell', 'mobile', 'mobile_phone', 'remote_person_id']) {
    const r = applyLinkToken([{ [field]: 'x@example.com' }], link);
    assert.equal(r.filed, false, field);
    assert.equal(r.rows[0].person_id, undefined, field);
  }
  assert.equal(applyLinkToken([{}, {}], link).filed, false, 'two rows');
  assert.equal(applyLinkToken([{ person_id: 3 }], link).rows[0].person_id, 3, 'the signed-in person wins');
  assert.equal(applyLinkToken([{}], { ok: false }).filed, false);
});

test('POST /people: a one-click row with a link token is filed on the recipient', async () => {
  const { call, token, crmPerson } = await setup();
  const bob = await crmPerson({ email: 'bob@example.com', given_name: 'Bob' });
  const res = await call('POST', '/people', { body: { people: [{}], options: { linkToken: await token(bob, { sourceCode: 'petition-email-1' }) } } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.personIds[0], bob);
  assert.equal(res.body.warnings, undefined);
});

test('POST /people: a forwarded link with the reader\'s own address, or a phone, is filed by that, not the link', async () => {
  const { call, token, crmPerson, emailsOf, worker } = await setup();
  const bob = await crmPerson({ email: 'bob@example.com' });
  const t = await token(bob);
  const alice = await call('POST', '/people', { body: { people: [{ email: 'alice@example.com' }], options: { linkToken: t } } });
  assert.notEqual(alice.body.personIds[0], bob);
  assert.deepEqual(await emailsOf(bob), ['bob@example.com'], "Alice's address is not joined to Bob");
  assert.match(alice.body.warnings.map((w) => w.reason).join(), /filed by its email/);
  const phone = await call('POST', '/people', { body: { people: [{ phone: '+15555550123' }], options: { linkToken: t } } });
  assert.notEqual(phone.body.personIds[0], bob);
  const { data } = await worker.query({ sql: 'select person_id from person_phone' });
  assert.ok(data.every((r) => Number(r.person_id) !== bob), 'the token joins no phone to Bob');
  const same = await call('POST', '/people', { body: { people: [{ email: 'bob@example.com' }], options: { linkToken: t } } });
  assert.equal(same.body.personIds[0], bob, "Bob's own address finds Bob, as any form does");
});

test('POST /people: a sender the site does not list, another account, or an unknown person changes nothing', async () => {
  const { call, crmPerson, stranger, worker, token } = await setup();
  const bob = await crmPerson({ email: 'bob@example.com' });
  const unlisted = await createLinkToken({ privateKey: stranger.privateKey, issuer: 'stranger', audience: worker.accountHandle, personId: bob });
  const r1 = await call('POST', '/people', { body: { people: [{}], options: { linkToken: unlisted } } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.personIds[0], bob);
  assert.match(r1.body.warnings[0].reason, /not one this site trusts/);
  const r2 = await call('POST', '/people', { body: { people: [{}], options: { linkToken: await token(99999) } } });
  assert.match(r2.body.warnings[0].reason, /person this site does not have/);
  const r3 = await call('POST', '/people', { body: { people: [{ person_id: bob }] } });
  assert.notEqual(r3.body.personIds[0], bob, 'without a token, a public row still cannot name a person');
});

test('a link token is never a session or a sign-in', async () => {
  const { call, token, crmPerson } = await setup();
  const bob = await crmPerson({ email: 'bob@example.com' });
  const t = await token(bob);
  const me = await call('GET', '/auth/me', { body: undefined, cookie: `e9_session=${t}` });
  assert.equal(me.status, 401);
  const asLink = await call('GET', `/auth/link?t=${encodeURIComponent(t)}`, { key: null });
  assert.equal(asLink.status, 400);
  const meBearer = await call('GET', '/auth/me', { key: t });
  assert.equal(meBearer.status, 401);
});

/* ----------------------------------------------------------- sign-in links */

async function invite(ctx, email, extra = {}) {
  return ctx.call('POST', '/admin/logins', { key: ctx.adminKey, body: { action: 'invite', email, ...extra } });
}

test('invite: only for an address that has a login; link first, then invite', async () => {
  const ctx = await setup();
  const dana = await ctx.crmPerson({ email: 'dana@example.org', given_name: 'Dana' });
  const none = await invite(ctx, 'dana@example.org');
  assert.equal(none.status, 422);
  assert.match(none.body.error, /has no login\. Link it/);
  await linkLogin({ worker: ctx.worker, email: 'dana@example.org', personId: dana });
  const made = await invite(ctx, 'dana@example.org', { return_to: '/members' });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.body.person_id, dana);
  assert.match(made.body.url, /^https:\/\/site\.example\.com\/api\/auth\/link\?t=/);
  assert.ok(ctx.audit.some((r) => r.action === 'login.signin_link' && r.meta.person_id === dana), 'audited');
  const publicTry = await ctx.call('POST', '/admin/logins', { body: { action: 'invite', email: 'dana@example.org' } });
  assert.equal(publicTry.status, 403, 'admin scope only');
});

test('a sign-in link: opening it changes nothing; the button signs in once, at Level 2', async () => {
  const ctx = await setup();
  const dana = await ctx.crmPerson({ email: 'dana@example.org' });
  await linkLogin({ worker: ctx.worker, email: 'dana@example.org', personId: dana });
  const { url } = (await invite(ctx, 'dana@example.org', { return_to: '/members' })).body;
  const t = new URL(url).searchParams.get('t');

  const page = await ctx.call('GET', `/auth/link?t=${encodeURIComponent(t)}`, { key: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /Sign in as <strong>dana@example\.org<\/strong>/);
  assert.match(page.text, /<form method="post" action="\/api\/auth\/link">/);
  // same-origin, not no-referrer: under no-referrer a browser sends Origin: null on the form POST.
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(page.text, /<meta name="referrer" content="same-origin">/);
  assert.deepEqual(page.cookies, []);
  assert.equal((await loginRow(ctx.worker, 'email', 'dana@example.org')).last_sign_in_at, null, 'a scanner opening the link uses nothing');

  const crossSite = await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t }, origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const noOrigin = await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t }, origin: null });
  assert.equal(noOrigin.status, 403);

  const used = await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t } });
  assert.equal(used.status, 303, used.text);
  assert.equal(used.headers.get('location'), '/members');
  const cookie = used.cookies.find((c) => c.startsWith('e9_session='));
  assert.ok(cookie);
  const me = await ctx.call('GET', '/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.personId, me.body.email, me.body.level, me.body.auth.signInProvider], [dana, 'dana@example.org', 2, 'email_link']);

  const again = await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t } });
  assert.equal(again.status, 400);
  assert.match(again.text, /already used/);
});

test('a later sign-in ends an unused link; a locked login cannot use one', async () => {
  const ctx = await setup();
  const dana = await ctx.crmPerson({ email: 'dana@example.org' });
  await linkLogin({ worker: ctx.worker, email: 'dana@example.org', personId: dana });
  const tOf = async () => new URL((await invite(ctx, 'dana@example.org')).body.url).searchParams.get('t');
  const first = await tOf();
  await new Promise((r) => setTimeout(r, 1100)); // the stored timestamp has whole seconds
  const second = await tOf();
  assert.equal((await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t: second } })).status, 303);
  assert.equal((await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t: first } })).status, 400, 'the older link ended');
  await new Promise((r) => setTimeout(r, 1100));
  const third = await tOf();
  await lockLogin({ worker: ctx.worker, email: 'dana@example.org' });
  const locked = await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t: third } });
  assert.equal(locked.status, 403);
  assert.match(locked.text, /turned off/);
});

test('a sign-in link is Level 2: an admin cannot reach admin with one', async () => {
  const ctx = await setup();
  const granted = await ctx.delegateAuth.addPeople({ role: 'admin', emails: ['ada@example.org'] });
  const ada = granted.byEmail['ada@example.org'];
  const { url } = (await invite(ctx, 'ada@example.org')).body;
  const res = await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t: new URL(url).searchParams.get('t') } });
  const cookie = res.cookies.find((c) => c.startsWith('e9_session='));
  const gate = await requireRole({ auth: ctx.delegateAuth, request: new Request(`${SITE}/admin`, { headers: { cookie } }), role: 'admin' });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'auth_not_met');
  const me = await ctx.call('GET', '/auth/me', { cookie });
  assert.equal(me.body.personId, ada);
});

test('sign-in links and sessions are never each other; an expired link does nothing', async () => {
  const ctx = await setup();
  const dana = await ctx.crmPerson({ email: 'dana@example.org' });
  await linkLogin({ worker: ctx.worker, email: 'dana@example.org', personId: dana });
  const t = new URL((await invite(ctx, 'dana@example.org')).body.url).searchParams.get('t');
  assert.equal((await ctx.call('GET', '/auth/me', { cookie: `e9_session=${t}` })).status, 401, 'a link is not a session');
  const session = ctx.delegateAuth.issueToken({ personId: dana, roles: [], email: 'dana@example.org', level: 2, auth: {} });
  assert.equal((await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t: session } })).status, 400, 'a session is not a link');
  const expired = createSessionToken({ login: true, email: 'dana@example.org', after: null }, { secret: SECRET, ttlSeconds: -1, typ: SIGN_IN_LINK_TOKEN_TYPE });
  assert.equal((await ctx.call('GET', `/auth/link?t=${expired}`, { key: null })).status, 400);
  assert.equal((await ctx.call('POST', '/auth/link', { key: null, form: true, body: { t: expired } })).status, 400);
});

/* ------------------------------------------- the filter reads names as the pipeline does */

test('the public filter reads field names as the pipeline does: no case or punctuation tricks', async () => {
  const { filterPublicRows } = await import('../api/publicRows.js');
  const { rows, warnings } = filterPublicRows([
    { PERSON_ID: 1, 'Delegate-ID': 'x', Identifiers: [], Email_Hash_V1: 'h', Confirmation_Status: 'ok', Input_ID: 'i', Remote_Input_ID: 'Delegate', Email: 'a@x.org' }
  ]);
  assert.deepEqual(rows, [{ email: 'a@x.org' }]);
  assert.deepEqual(warnings.map((w) => w.field).sort(), ['confirmation_status', 'delegate_id', 'email_hash_v1', 'identifiers', 'input_id', 'person_id', 'remote_input_id']);
});

test('POST /people: upper-case PERSON_ID, Delegate_ID, a row-level sign-in input, or "Delegate" in options reach nobody', async () => {
  const { call, crmPerson, emailsOf, worker, token } = await setup();
  const admin = await crmPerson({ email: 'boss@example.com', phone: '+15555550143' });
  await call('POST', '/people', { body: { people: [{ PERSON_ID: admin, email: 'evil@attacker.test' }] } });
  await call('POST', '/people', { body: { people: [{ Delegate_ID: 'site.example.com:abc', phone: '+15555550143' }] } });
  await call('POST', '/people', { body: { people: [{ email: 'evil2@attacker.test', remote_input_id: 'DELEGATE' }] } });
  await call('POST', '/people', { body: { people: [{ email: 'evil3@attacker.test' }], options: { remoteInputId: 'Delegate' } } });
  assert.deepEqual(await emailsOf(admin), ['boss@example.com']);
  const { data } = await worker.query({ sql: "select count(*) as n from input where lower(remote_input_id)='delegate'" });
  assert.equal(Number(data[0].n), 0, 'no form row was written under sign-in\'s input');
  const linked = await call('POST', '/people', { body: { people: [{ Email: 'x@attacker.test' }], options: { linkToken: await token(admin) } } });
  assert.notEqual(linked.body.personIds[0], admin, 'Email in any case is an address: the link does not apply');
  assert.deepEqual(await emailsOf(admin), ['boss@example.com']);
});

/* --------------------------------------------- fixes from the 1.22 review */

test('Add a sign-in address does not turn back on a login an administrator locked', async () => {
  const { worker, crmPerson } = await setup();
  const { addSignInAddress, personForSignIn, lockLogin } = await import('../auth/logins.js');
  const pid = await crmPerson({ email: 'pat@example.org' });
  await linkLogin({ worker, email: 'pat@example.org', personId: pid });
  await linkLogin({ worker, email: 'old@example.org', personId: pid });
  await lockLogin({ worker, email: 'old@example.org' });
  const subject = `${HOST}:${'a'.repeat(64)}`;
  await personForSignIn({ worker, pluginId: getPluginUUID(worker.accountHandle, 'website'), identity: { subject, email: 'pat@example.org', level: 3 } });
  const r = await addSignInAddress({
    worker,
    session: { personId: pid, domainUnid: subject, email: 'pat@example.org', level: 3 },
    identity: { subject: `${HOST}:${'b'.repeat(64)}`, email: 'old@example.org', level: 3 }
  });
  assert.equal(r.refused, 'login_locked');
  assert.equal((await loginRow(worker, 'email', 'old@example.org')).state, 'locked');
});

test("a sign-in does not mark another person's address as used", async () => {
  const { worker, crmPerson } = await setup();
  const { personForSignIn } = await import('../auth/logins.js');
  const p1 = await crmPerson({ email: 'x@example.org' });
  await linkLogin({ worker, email: 'x@example.org', personId: p1 });
  const subject = `${HOST}:${'c'.repeat(64)}`;
  const first = await personForSignIn({ worker, pluginId: getPluginUUID(worker.accountHandle, 'website'), identity: { subject, email: 'y@example.org', level: 3 } });
  const again = await personForSignIn({ worker, pluginId: getPluginUUID(worker.accountHandle, 'website'), identity: { subject, email: 'x@example.org', level: 3 } });
  assert.equal(again.personId, first.personId, 'the Delegate account keeps its person');
  assert.notEqual(again.personId, p1);
  assert.equal((await loginRow(worker, 'email', 'x@example.org')).last_sign_in_at, null, "p1's login is untouched, so its sign-in links still work");
});
