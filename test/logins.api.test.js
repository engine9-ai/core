/*
  person_login through the HTTP API and the upgrade:
  - POST /people with a public key: the fields that point a row at a record
    are removed, with warnings; everything else is as before;
  - the other_login stop on the Login button's route (POST /auth/login with
    cookie: true) and its "This isn't me", once, for the same account only;
  - the no-JavaScript fallback page on /auth/callback;
  - roles read through the login on every request (lock takes effect at once);
  - POST /admin/logins (e9core signin --url);
  - e9core upgrade on a database from before person_login: the backfill,
    sign-in before and after it, and the login.* status checks;
  - sign-in is a plugin (@engine9/schemas/login): a database without it has
    no sign-in, a data-only database stays that way, and one command turns
    sign-in on later.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { ensureRoleSegments, roleSegmentId } from '../auth/roles.js';
import { forgetLoginTable, loginMode, loginRow, loginTableReady } from '../auth/logins.js';
import { rolesForEmail } from '../auth/roles.js';
import { getPluginUUID } from '../lib/utilities.js';
import { runStatus } from '../lib/status/index.js';
import { applyWebsitePlugins, ensurePluginRow } from './helpers/applySchemas.js';

const DELEGATE_URL = 'https://delegate.network';
const HOST = 'site.example.com';
const SITE = `https://${HOST}`;
const unid = (name) => `${HOST}:${Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64)}`;

async function setup() {
  const worker = new PersonWorker({ accountId: 'logins', auth: { database_connection: 'sqlite://:memory:' } });
  await applyWebsitePlugins(worker);
  const pluginId = getPluginUUID(worker.accountHandle, 'website');
  await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
  await ensureRoleSegments({ worker, accountId: worker.accountHandle });
  const admin = roleSegmentId(worker.accountHandle, 'admin');

  const kid = 'logins-test';
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const sign = ({ sub, email, level = 3, nonce }) => {
    const fields = email ? { email, email_verified: true } : {};
    const jwt = new SignJWT({ level, nonce, auth: {}, fields });
    jwt.setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' });
    jwt.setIssuer(DELEGATE_URL).setAudience(HOST).setSubject(sub).setIssuedAt().setExpirationTime('5m');
    return jwt.sign(privateKey);
  };

  const delegateAuth = createDelegateAuth({
    worker,
    delegateUrl: DELEGATE_URL,
    sessionSecret: '0123456789abcdef'.repeat(4),
    pluginId,
    roles: 'standard',
    jwks: { keys: [jwk] }
  });
  const keyStore = new SqlApiKeyStore({ worker });
  await keyStore.deploy();
  const { key: publicKey9 } = await keyStore.create({ name: 'form', scopes: ['public'] });
  const { key: writeKey } = await keyStore.create({ name: 'crm', scopes: ['people:write'] });
  const { key: adminKey } = await keyStore.create({ name: 'admin', scopes: ['admin'] });
  const api = createApi({ worker, keyStore, delegateAuth, config: { pluginId, roles: 'standard' } });

  const call = async (method, path, { key = publicKey9, body, cookie, origin = SITE } = {}) => {
    const headers = { authorization: `Bearer ${key}`, origin };
    if (cookie) headers.cookie = cookie;
    const payload = method === 'GET' ? undefined : JSON.stringify(body || {});
    if (payload) headers['content-type'] = 'application/json';
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
  const jar = (cookies) => cookies.filter((c) => !/=$/.test(c)).join('; ');

  /* The Login button's sign-in: begin, then POST /auth/login with cookie: true. */
  async function buttonSignIn({ sub, email, level = 3, newAccount = false, retry = null }) {
    let begin = retry;
    if (!begin) {
      const b = await call('POST', '/auth/begin');
      begin = { state: b.body.state, nonce: b.body.nonce, cookie: jar(b.cookies) };
    }
    const token = await sign({ sub, email, level, nonce: begin.nonce });
    const res = await call('POST', '/auth/login', {
      body: { delegate_token: token, state: begin.state, cookie: true, ...(newAccount ? { new_account: true } : {}) },
      cookie: begin.cookie
    });
    return { ...res, begin: { ...begin, cookie: jar(res.cookies) || begin.cookie }, session: jar(res.cookies.filter((c) => c.startsWith('e9_session='))) };
  }

  return { worker, pluginId, admin, delegateAuth, api, call, sign, buttonSignIn, jar, keys: { publicKey: publicKey9, writeKey, adminKey } };
}

const LOGIN_PATH = '@engine9/schemas/login';

/* No login plugin: no table and no plugin row. */
async function removeLoginPlugin(worker) {
  await worker.query('drop table person_login');
  await worker.query({ sql: 'delete from plugin where path=?', values: [LOGIN_PATH] });
  forgetLoginTable(worker);
}

/* A database from before this release: no login plugin, and its person plugin last installed by @engine9/schemas 1.14. */
async function asPreReleaseDatabase(worker) {
  await removeLoginPlugin(worker);
  await worker.query({ sql: 'update plugin set last_install=? where path=?', values: [JSON.stringify({ trigger: 'install', package: '@engine9/schemas', version: '1.14.0' }), '@engine9/schemas/person'] });
  forgetLoginTable(worker);
}

test('POST /people with a public key: steering fields removed with warnings, the rest as before', async () => {
  const t = await setup();
  try {
    const crm = await t.call('POST', '/people', { key: t.keys.writeKey, body: { people: [{ email: 'admin@example.com', phone: '202-555-0143' }] } });
    assert.equal(crm.status, 200);
    const adminPid = crm.body.personIds[0];
    assert.ok(adminPid, 'a server key still gets person ids');

    const res = await t.call('POST', '/people', {
      body: {
        people: [{ email: 'invader@example.com', person_id: adminPid, confirmation_status: 'Confirmed' }],
        options: { remoteInputId: 'delegate', sourceCode: 'spring' }
      }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.personIds.length, 1, 'person ids are returned, as before');
    const fields = res.body.warnings.map((w) => w.field).sort();
    assert.deepEqual(fields, ['confirmation_status', 'options.remoteInputId', 'person_id']);
    const { data } = await t.worker.query({ sql: 'select person_id from person_email where email=?', values: ['invader@example.com'] });
    assert.notEqual(Number(data[0].person_id), adminPid, 'the row was filed by its own email, not the admin');

    // A plain form row, and another remoteInputId, behave exactly as before.
    const plain = await t.call('POST', '/people', { body: { people: [{ email: 'fan@example.com', phone: '202-555-0177' }], options: { remoteInputId: 'newsletter' } } });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.warnings, undefined);
    const lookup = await t.call('POST', '/people', { body: { people: [{ email: 'admin@example.com' }], options: { doNotUpsert: true } } });
    assert.equal(lookup.status, 200, 'lookups work as before');
  } finally {
    await t.worker.destroy();
  }
});

test('Login button: other_login shows a masked address; "This isn\'t me" makes a new person once, for that account only', async () => {
  const t = await setup();
  try {
    const crm = getPluginUUID('logins', 'crm');
    // One imported household record with two addresses.
    const [pid] = (await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'robin@home.example', remote_person_id: `${crm}.1` }] })).personIds;
    await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'casey@home.example', remote_person_id: `${crm}.1` }] });

    const robin = await t.buttonSignIn({ sub: unid('robin'), email: 'robin@home.example' });
    assert.equal(robin.status, 200, JSON.stringify(robin.body));
    assert.equal(robin.body.session.personId, pid, 'the first sign-in adopts the imported person');

    const casey = await t.buttonSignIn({ sub: unid('casey'), email: 'casey@home.example' });
    assert.equal(casey.status, 403);
    assert.equal(casey.body.reason, 'other_login');
    assert.equal(casey.body.masked, 'r***n@h***e.example');
    assert.equal(casey.body.new_account, true);
    assert.ok(!casey.text.includes('robin@home.example'), 'no full address');
    assert.ok(!casey.text.includes(`"personId"`), 'no person id');
    assert.equal(casey.session, '', 'no session');

    // Another account cannot use Casey's "This isn't me".
    const other = await t.buttonSignIn({ sub: unid('mallory'), email: 'casey@home.example', newAccount: true, retry: casey.begin });
    assert.equal(other.status, 401);
    assert.equal(other.body.reason, 'state_mismatch');

    const again = await t.buttonSignIn({ sub: unid('casey'), email: 'casey@home.example' });
    const mine = await t.buttonSignIn({ sub: unid('casey'), email: 'casey@home.example', newAccount: true, retry: again.begin });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.notEqual(mine.body.session.personId, pid, 'a new person');
    assert.ok(mine.session.startsWith('e9_session='));
    const later = await t.buttonSignIn({ sub: unid('casey'), email: 'casey@home.example' });
    assert.equal(later.body.session.personId, mine.body.session.personId, 'and it stays theirs');
  } finally {
    await t.worker.destroy();
  }
});

test('no-JavaScript fallback: /auth/callback shows the stop with both choices', async () => {
  const t = await setup();
  try {
    const crm = getPluginUUID('logins', 'crm');
    await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'lee@work.example', remote_person_id: `${crm}.2` }] });
    await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'lee@home.example', remote_person_id: `${crm}.2` }] });
    assert.equal((await t.buttonSignIn({ sub: unid('lee-w'), email: 'lee@work.example' })).status, 200);

    const start = await t.api.handleFetch(new Request(`${SITE}/api/auth/start?returnTo=/members`));
    const location = new URL(start.headers.get('location'));
    const state = location.searchParams.get('state');
    const nonce = location.searchParams.get('nonce');
    const loginCookie = t.jar(start.headers.getSetCookie().map((c) => c.split(';')[0]));
    const token = await t.sign({ sub: unid('lee-h'), email: 'lee@home.example', nonce });
    const callback = await t.api.handleFetch(
      new Request(`${SITE}/api/auth/callback?${new URLSearchParams({ delegate_token: token, state })}`, { headers: { cookie: loginCookie } })
    );
    assert.equal(callback.status, 403);
    const html = await callback.text();
    assert.match(html, /l\*\*\*e@w\*\*\*k\.example/);
    assert.match(html, /Sign in with a different address/);
    assert.match(html, /This isn&#39;t me|This isn't me/);
    assert.ok(!html.includes('lee@work.example'));
    assert.match(html, /reason=access_denied/);
    const href = html.match(/href="([^"]*new_account=1[^"]*)"/)[1].replace(/&amp;/g, '&');
    const retryCookie = t.jar(callback.headers.getSetCookie().map((c) => c.split(';')[0]));
    const done = await t.api.handleFetch(new Request(`${SITE}${href}`, { headers: { cookie: retryCookie } }));
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/members');
    assert.ok(done.headers.getSetCookie().some((c) => c.startsWith('e9_session=')));
  } finally {
    await t.worker.destroy();
  }
});

test('roles are read through the login on every request; locking a login ends them at once', async () => {
  const t = await setup();
  try {
    await t.delegateAuth.addPeople({ role: 'admin', emails: ['boss@example.com'] });
    const boss = await t.buttonSignIn({ sub: unid('boss'), email: 'boss@example.com' });
    assert.equal(boss.status, 200);
    assert.deepEqual(boss.body.session.roles, [t.admin]);
    const me = await t.call('GET', '/auth/me', { cookie: boss.session });
    assert.deepEqual(me.body.roles, [t.admin]);

    const lock = await t.call('POST', '/admin/logins', { key: t.keys.adminKey, body: { action: 'lock', email: 'boss@example.com' } });
    assert.equal(lock.status, 200, JSON.stringify(lock.body));
    // The subject row still carries roles; lock the account itself too.
    await t.call('POST', '/admin/logins', { key: t.keys.adminKey, body: { action: 'lock', subject: unid('boss') } });
    const after = await t.call('GET', '/auth/me', { cookie: boss.session });
    assert.deepEqual(after.body.roles, [], 'the same cookie holds no role');
    const relogin = await t.buttonSignIn({ sub: unid('boss'), email: 'boss@example.com' });
    assert.equal(relogin.status, 403);
    assert.equal(relogin.body.reason, 'login_locked');

    const list = await t.call('POST', '/admin/logins', { key: t.keys.adminKey, body: { action: 'list', email: 'boss@example.com' } });
    assert.equal(list.body.logins.length, 2);
    assert.ok(list.body.logins.every((l) => l.state === 'locked'));
    const denied = await t.call('POST', '/admin/logins', { body: { action: 'list', email: 'boss@example.com' } });
    assert.equal(denied.status, 403, 'admin only');
  } finally {
    await t.worker.destroy();
  }
});

test('upgrade: a database from before person_login keeps signing in, then the backfill keeps every admin', async () => {
  const t = await setup();
  try {
    const crm = getPluginUUID('logins', 'crm');
    // Today's data: an admin with two addresses, a member of a configured role, a plain person.
    const [adminPid] = (await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'ada@example.com', remote_person_id: `${crm}.9` }] })).personIds;
    await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'ada@home.example', remote_person_id: `${crm}.9` }] });
    await t.worker.upsertArray({ table: 'person_segment', array: [{ person_id: adminPid, segment_id: t.admin }] });
    await asPreReleaseDatabase(t.worker);
    assert.equal(await loginMode(t.worker), 'legacy');

    // Deployed, not upgraded: sign-in works as before, and status says what to do.
    const before = await t.buttonSignIn({ sub: unid('ada-home'), email: 'ada@home.example' });
    assert.equal(before.status, 200);
    assert.equal(before.body.session.personId, adminPid);
    assert.deepEqual(before.body.session.roles, [t.admin], 'nothing breaks between the deploy and the upgrade');
    let status = await runStatus(t.worker, { handleChecks: false });
    assert.equal(status.checks.find((c) => c.id === 'login.table').status, 'fail');
    assert.ok(status.checks.some((c) => c.id === 'upgrade.person_login' && c.status !== 'pass'));

    const plan = await t.worker.upgrade({ dry_run: true });
    const dry = plan.upgrades.find((u) => u.id === 'person_login');
    assert.equal(dry.status, 'pending');
    assert.equal(dry.role_holders, 1);
    assert.equal(dry.addresses, 2);
    assert.equal(await loginTableReady(t.worker), false, 'the dry run changed nothing');

    const run = await t.worker.upgrade({});
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(run.upgrades.find((u) => u.id === 'person_login').status, 'applied');
    forgetLoginTable(t.worker);
    assert.equal((await loginRow(t.worker, 'email', 'ada@example.com')).how, 'backfill');
    assert.equal((await loginRow(t.worker, 'email', 'ada@home.example')).how, 'backfill');

    // The admin's session from before the upgrade keeps its role: found by its address.
    const me = await t.call('GET', '/auth/me', { cookie: before.session });
    assert.deepEqual(me.body.roles, [t.admin]);
    // Each address works from its own Delegate account.
    for (const [who, email] of [['ada-work', 'ada@example.com'], ['ada-home', 'ada@home.example']]) {
      const r = await t.buttonSignIn({ sub: unid(who), email });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.session.personId, adminPid);
      assert.deepEqual(r.body.session.roles, [t.admin]);
    }
    status = await runStatus(t.worker, { handleChecks: false });
    for (const id of ['login.table', 'login.review', 'login.stale']) {
      assert.equal(status.checks.find((c) => c.id === id).status, 'pass', id);
    }
    const again = await t.worker.upgrade({ dry_run: true });
    assert.equal(again.upgrades.find((u) => u.id === 'person_login').status, 'current', 'it runs once');
  } finally {
    await t.worker.destroy();
  }
});

test('POST /admin/upgrade passes the configured roles to the backfill', async () => {
  const t = await setup();
  try {
    const [pid] = (await t.worker.processPeople({ pluginId: t.pluginId, remoteInputId: 'crm', inputType: 'api', batch: [{ email: 'ed@example.com' }] })).personIds;
    await t.worker.upsertArray({ table: 'person_segment', array: [{ person_id: pid, segment_id: t.admin }] });
    // A role segment that a host made itself (no roles plugin row behind it).
    await t.worker.query({ sql: 'update segment set plugin_id=? where id=?', values: [t.pluginId, t.admin] });
    await asPreReleaseDatabase(t.worker);
    const res = await t.call('POST', '/admin/upgrade', { key: t.keys.adminKey, body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const u = res.body.upgrades.find((x) => x.id === 'person_login');
    assert.equal(u.status, 'applied');
    assert.equal(u.role_holders, 1);
    assert.equal((await loginRow(t.worker, 'email', 'ed@example.com')).how, 'backfill');
  } finally {
    await t.worker.destroy();
  }
});

test('Add a sign-in address from a signed-in session, then stop using the old one', async () => {
  const t = await setup();
  try {
    await t.delegateAuth.addPeople({ role: 'admin', emails: ['pat@old.example'] });
    const first = await t.buttonSignIn({ sub: unid('pat-old'), email: 'pat@old.example' });
    assert.equal(first.status, 200);
    const personId = first.body.session.personId;

    // The Login button begins a second sign-in, then posts its token with the session cookie.
    const b = await t.call('POST', '/auth/begin', { cookie: first.session });
    const loginCookie = t.jar(b.cookies);
    const token = await t.sign({ sub: unid('pat-new'), email: 'pat@new.example', nonce: b.body.nonce });
    const add = await t.call('POST', '/auth/add-address', {
      body: { delegate_token: token, state: b.body.state },
      cookie: `${first.session}; ${loginCookie}`
    });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal(add.body.person_id, personId);

    const fresh = await t.buttonSignIn({ sub: unid('pat-new'), email: 'pat@new.example' });
    assert.equal(fresh.body.session.personId, personId, 'the new account signs in as the same person');
    assert.deepEqual(fresh.body.session.roles, [t.admin], 'with the same roles');

    const retire = await t.call('POST', '/auth/retire-address', { body: { email: 'pat@old.example' }, cookie: fresh.session });
    assert.equal(retire.status, 200, JSON.stringify(retire.body));
    const last = await t.call('POST', '/auth/retire-address', { body: { email: 'pat@new.example' }, cookie: fresh.session });
    assert.equal(last.status, 409, 'never the last address');

    // Someone else's account cannot be added: the address already signs in elsewhere.
    await t.buttonSignIn({ sub: unid('sam'), email: 'sam@example.com' });
    const b2 = await t.call('POST', '/auth/begin', { cookie: fresh.session });
    const steal = await t.call('POST', '/auth/add-address', {
      body: { delegate_token: await t.sign({ sub: unid('sam'), email: 'sam@example.com', nonce: b2.body.nonce }), state: b2.body.state },
      cookie: `${fresh.session}; ${t.jar(b2.cookies)}`
    });
    assert.equal(steal.status, 409);
    assert.equal(steal.body.refused, 'login_belongs_to_another_account');
  } finally {
    await t.worker.destroy();
  }
});

test('a site without the login plugin has no sign-in, and one command turns it on', async () => {
  const t = await setup();
  try {
    await t.delegateAuth.addPeople({ role: 'admin', emails: ['kim@example.com'] });
    const before = await t.buttonSignIn({ sub: unid('kim'), email: 'kim@example.com' });
    assert.equal(before.status, 200);
    await removeLoginPlugin(t.worker);
    assert.equal(await loginMode(t.worker), 'off', 'upgraded, without the plugin');

    // Every sign-in stops, before Delegate (no-JavaScript link) and after it (the Login button).
    const start = await t.call('GET', '/auth/start?returnTo=/');
    assert.equal(start.status, 403);
    assert.match(start.text, /login plugin/);
    const r = await t.buttonSignIn({ sub: unid('kim'), email: 'kim@example.com' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, 'sign_in_off');
    // Sessions already issued behave as before this release; nothing falls back to dedupe by email.
    assert.equal((await t.call('GET', '/auth/me', { cookie: before.session })).status, 200);
    assert.deepEqual(await rolesForEmail({ worker: t.worker, email: 'kim@example.com', roleIds: [t.admin] }), []);
    const admin = await t.call('POST', '/admin/logins', { key: t.keys.adminKey, body: { action: 'list', email: 'kim@example.com' } });
    assert.equal(admin.status, 409);
    assert.equal(admin.body.reason, 'sign_in_off');

    // Status: fails for a site with sign-in, warns when roles exist and it cannot tell, silent otherwise.
    const loginTable = async (signIn) => (await runStatus(t.worker, { handleChecks: false, signIn })).checks.find((c) => c.id === 'login.table');
    assert.equal((await loginTable(true)).status, 'fail');
    assert.match((await loginTable(true)).fix, /--plugin @engine9\/schemas\/login/);
    assert.equal((await loginTable(undefined)).status, 'warn');
    assert.equal(await loginTable(false), undefined);

    // Turn sign-in on: the named upgrade creates the table and copies the admin.
    const on = await t.worker.upgrade({ plugins: [LOGIN_PATH] });
    assert.equal(on.upgrades.find((u) => u.id === 'person_login').status, 'applied', JSON.stringify(on));
    forgetLoginTable(t.worker);
    assert.equal(await loginMode(t.worker), 'on');
    const after = await t.buttonSignIn({ sub: unid('kim'), email: 'kim@example.com' });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(after.body.session.roles, [t.admin]);
  } finally {
    await t.worker.destroy();
  }
});

test('a data-only database: the upgrade leaves sign-in off and status says nothing about it', async () => {
  const worker = new PersonWorker({ accountId: 'dataonly', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installRequiredPlugins();
    const crm = getPluginUUID(worker.accountHandle, 'crm');
    await ensurePluginRow(worker, { id: crm, path: 'crm', name: 'CRM' });
    await worker.processPeople({ pluginId: crm, remoteInputId: 'crm', inputType: 'api', batch: [{ email_hash_v1: 'a'.repeat(64) }] });
    const run = await worker.upgrade({});
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(run.upgrades.find((u) => u.id === 'person_login').status, 'current');
    forgetLoginTable(worker);
    assert.equal(await loginMode(worker), 'off');
    const status = await runStatus(worker, { handleChecks: false });
    assert.deepEqual(status.checks.filter((c) => c.id.startsWith('login.')), []);

    // The same database behind a site with sign-in: POST /admin/upgrade passes sign_in.
    const site = await worker.upgrade({ sign_in: true });
    assert.equal(site.upgrades.find((u) => u.id === 'person_login').status, 'applied');
    forgetLoginTable(worker);
    assert.equal(await loginMode(worker), 'on');
  } finally {
    await worker.destroy();
  }
});
