import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { getPluginUUID, getVersionedUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';

const DOMAIN = 'site.example.com';
const UNID = `${DOMAIN}:${'a'.repeat(64)}`;
const PROFILE_LOGIN = `${DOMAIN}:${'1'.repeat(64)}`;
const PROFILE_API = `${DOMAIN}:${'2'.repeat(64)}`;
const RETURN_ORIGIN = 'https://site.example.com';
const DELEGATE_URL = 'https://delegate.engine9.ai';

function memoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

async function signIdentityJwt({ privateKey, kid = 'api-test-key', level = 2, sub = UNID, domainProfile = PROFILE_API, profile, auth }) {
  const jwt = new SignJWT({
    domain_profile: domainProfile,
    level,
    profile: profile || {
      email: 'api@example.com',
      email_verified: true
    },
    auth: auth || { provider: 'google.com', two_factor: false, auth_time: 1700000000 }
  });
  jwt.setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' });
  jwt.setIssuer(DELEGATE_URL);
  jwt.setAudience(DOMAIN);
  jwt.setSubject(sub);
  jwt.setIssuedAt();
  jwt.setExpirationTime('1h');
  jwt.setJti(`jti-${crypto.randomUUID()}`);
  return jwt.sign(privateKey);
}

test('API /auth/login, /auth/me, Bearer JWT, tightened /auth/role', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'website-auth-routes');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });

    const vipRoleId = getVersionedUUID();
    const adminRoleId = getVersionedUUID();
    await worker.insertArray({
      table: 'segment',
      array: [
        { id: vipRoleId, plugin_id: pluginId, name: 'VIP', build_type: 'list' },
        { id: adminRoleId, plugin_id: pluginId, name: 'Admin', build_type: 'list' }
      ]
    });

    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'api-test-key';
    jwk.alg = 'ES256';
    jwk.use = 'sig';

    const fetchImpl = async (url) => {
      if (String(url).includes('/.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const peopleByUnid = new Map();
    let nextPersonId = 1;
    worker.processPeople = async ({ batch }) => {
      const personIds = (batch || []).map((row) => {
        const domainUnid = row.delegate_id;
        if (domainUnid && peopleByUnid.has(domainUnid)) return peopleByUnid.get(domainUnid);
        const id = nextPersonId++;
        if (domainUnid) peopleByUnid.set(domainUnid, id);
        return id;
      });
      return { personIds, records: personIds.length, recordsWithPersonIds: personIds.length };
    };

    const delegateAuth = createDelegateAuth({
      worker,
      delegateUrl: DELEGATE_URL,
      domain: DOMAIN,
      sessionSecret: 'session-secret',
      pluginId,
      roles: {
        [vipRoleId]: { name: 'VIP', scopes: ['data:read'] },
        [adminRoleId]: { name: 'Admin', scopes: ['admin'] }
      },
      fetchImpl
    });

    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key } = await keyStore.create({
      name: 'site',
      scopes: ['data:read', 'people:write']
    });
    const { key: adminKey } = await keyStore.create({
      name: 'admin',
      scopes: ['admin']
    });

    const kv = memoryKv();
    const api = createApi({
      worker,
      keyStore,
      delegateAuth,
      kvEnv: { PERSON_ID_DELEGATE_KV: kv },
      config: {
        pluginId,
        roles: {
          [vipRoleId]: { name: 'VIP', scopes: ['data:read'] },
          [adminRoleId]: { name: 'Admin', scopes: ['admin'] }
        }
      }
    });

    const apiHeaders = { authorization: `Bearer ${key}` };
    const adminHeaders = { authorization: `Bearer ${adminKey}` };

    const loginToken = await signIdentityJwt({
      privateKey,
      domainProfile: PROFILE_LOGIN,
      profile: { email: 'api@example.com', email_verified: true }
    });
    const loginCode = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: apiHeaders,
      body: { delegate_token: loginToken, return_to: `${RETURN_ORIGIN}/auth/delegate` }
    });
    assert.equal(loginCode.status, 200, JSON.stringify(loginCode.body));
    assert.ok(loginCode.body.token);
    assert.ok(loginCode.body.session.personId > 0);
    assert.equal(loginCode.body.session.domainUnid, UNID);
    assert.equal(loginCode.body.session.level, 2);
    assert.equal(loginCode.body.session.domainProfile, PROFILE_LOGIN);
    const personId = loginCode.body.session.personId;
    const sessionToken = loginCode.body.token;

    const meSession = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { ...apiHeaders, 'x-engine9-session': sessionToken }
    });
    assert.equal(meSession.status, 200, JSON.stringify(meSession.body));
    assert.equal(meSession.body.personId, personId);
    assert.equal(meSession.body.domainUnid, UNID);
    assert.equal(meSession.body.level, 2);
    assert.equal(meSession.body.domainProfile, PROFILE_LOGIN);
    assert.ok(meSession.body.auth);

    const noSession = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: apiHeaders
    });
    assert.equal(noSession.status, 401);

    const jwt = await signIdentityJwt({ privateKey });
    const meJwt = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: {
        authorization: `Bearer ${jwt}`,
        'x-api-key': key
      }
    });
    assert.equal(meJwt.status, 200, JSON.stringify(meJwt.body));
    assert.equal(meJwt.body.personId, personId);
    assert.equal(meJwt.body.domainUnid, UNID);
    assert.equal(meJwt.body.level, 2);
    assert.equal(meJwt.body.domainProfile, PROFILE_API);
    assert.equal(meJwt.body.profile?.email, 'api@example.com');
    assert.equal(await kv.get(`delegate:${UNID}`), String(personId));

    const loginJwt = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: apiHeaders,
      body: { delegate_token: jwt, return_to: `${RETURN_ORIGIN}/callback` }
    });
    assert.equal(loginJwt.status, 200, JSON.stringify(loginJwt.body));
    assert.equal(loginJwt.body.session.level, 2);
    assert.equal(loginJwt.body.session.domainProfile, PROFILE_API);

    const logout = await api.handle({
      method: 'POST',
      path: '/auth/logout',
      headers: apiHeaders,
      body: {}
    });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.loggedOut, true);

    const barePerson = await api.handle({
      method: 'POST',
      path: '/auth/role',
      headers: apiHeaders,
      body: { role_id: vipRoleId, person_id: personId }
    });
    assert.equal(barePerson.status, 401, 'bare person_id without session is rejected');

    const mismatch = await api.handle({
      method: 'POST',
      path: '/auth/role',
      headers: { ...apiHeaders, 'x-engine9-session': sessionToken },
      body: { role_id: vipRoleId, person_id: personId + 99 }
    });
    assert.equal(mismatch.status, 403);

    const selfRole = await api.handle({
      method: 'POST',
      path: '/auth/role',
      headers: { ...apiHeaders, 'x-engine9-session': sessionToken },
      body: { role_id: vipRoleId, exclusive: true }
    });
    assert.equal(selfRole.status, 200, JSON.stringify(selfRole.body));
    assert.deepEqual(selfRole.body.roles, [vipRoleId]);

    const adminBare = await api.handle({
      method: 'POST',
      path: '/auth/role',
      headers: adminHeaders,
      body: { role_id: adminRoleId, person_id: personId, exclusive: true }
    });
    assert.equal(adminBare.status, 200, JSON.stringify(adminBare.body));
    assert.deepEqual(adminBare.body.roles, [adminRoleId]);

    const jwtRole = await api.handle({
      method: 'POST',
      path: '/auth/role',
      headers: {
        authorization: `Bearer ${jwt}`,
        'x-api-key': key
      },
      body: { role_id: vipRoleId, exclusive: true }
    });
    assert.equal(jwtRole.status, 200, JSON.stringify(jwtRole.body));
    assert.deepEqual(jwtRole.body.roles, [vipRoleId]);
  } finally {
    await worker.destroy();
  }
});

/*
  The browser library (`@engine9/id` core.login()) posts only
  `{ delegate_token }` with the public key. createApi must build the default
  provider from `delegate.sessionSecret` and take the JWT aud from the request
  (page Origin, else API Host) when no domain is configured anywhere.
*/
test('API login from @engine9/id: delegate option, no configured domain', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'website-auth-id');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });

    // A new kid: the module-level JWKS cache still holds the previous test's
    // key set, so this also covers the "unknown kid → refetch JWKS" path.
    const kid = 'api-test-key-rotated';
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = kid;
    jwk.alg = 'ES256';
    jwk.use = 'sig';
    const fetchImpl = async (url) => {
      if (String(url).includes('/.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const peopleByUnid = new Map();
    let nextPersonId = 1;
    worker.processPeople = async ({ batch }) => {
      const personIds = (batch || []).map((row) => {
        const domainUnid = row.delegate_id;
        if (domainUnid && peopleByUnid.has(domainUnid)) return peopleByUnid.get(domainUnid);
        const id = nextPersonId++;
        if (domainUnid) peopleByUnid.set(domainUnid, id);
        return id;
      });
      return { personIds, records: personIds.length, recordsWithPersonIds: personIds.length };
    };

    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: publicKeyValue } = await keyStore.create({ name: 'public', scopes: ['public'] });
    assert.ok(publicKeyValue.startsWith('e9publickey_'));

    const api = createApi({
      worker,
      keyStore,
      delegate: { sessionSecret: 'session-secret', fetchImpl },
      config: { pluginId }
    });

    const token = await signIdentityJwt({ privateKey, kid, level: 1, profile: { given_name: 'Alex' } });
    const idHeaders = { authorization: `Bearer ${publicKeyValue}`, 'x-api-key': publicKeyValue };

    // The public key is the signup-form key: it may add people…
    const signup = await api.handle({
      method: 'POST',
      path: '/people',
      headers: idHeaders,
      body: { people: [{ email: 'form@example.com', given_name: 'Form' }] }
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    // …and nothing else.
    const upsert = await api.handle({
      method: 'POST',
      path: '/upsert/person_segment',
      headers: idHeaders,
      body: { rows: [{ person_id: 1, segment_id: getVersionedUUID() }] }
    });
    assert.equal(upsert.status, 403);
    const read = await api.handle({ method: 'GET', path: '/read/anything', headers: idHeaders });
    assert.equal(read.status, 403);

    // Same-platform: page and /api share the hostname; browsers send Origin on POST.
    const sameOrigin = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: { ...idHeaders, origin: RETURN_ORIGIN, host: DOMAIN },
      body: { delegate_token: token }
    });
    assert.equal(sameOrigin.status, 200, JSON.stringify(sameOrigin.body));
    assert.equal(sameOrigin.body.session.domainUnid, UNID);
    assert.equal(sameOrigin.body.session.level, 1);
    const sessionToken = sameOrigin.body.token;

    // Host only (no Origin header), explicit default port is dropped.
    const hostOnly = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: { ...idHeaders, host: `${DOMAIN}:443` },
      body: { delegate_token: token }
    });
    assert.equal(hostOnly.status, 200, JSON.stringify(hostOnly.body));

    // Independent hosts: the page Origin wins over the API Host.
    const independent = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: { ...idHeaders, origin: RETURN_ORIGIN, host: 'api.other.example' },
      body: { delegate_token: token }
    });
    assert.equal(independent.status, 200, JSON.stringify(independent.body));

    // A token for another Domain is refused.
    const wrongHost = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: { ...idHeaders, host: 'other.example' },
      body: { delegate_token: token }
    });
    assert.equal(wrongHost.status, 400, JSON.stringify(wrongHost.body));
    assert.equal(wrongHost.body.reason, 'invalid_domain');

    // id's core.me() sends the session header with the public key.
    const me = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { ...idHeaders, 'x-engine9-session': sessionToken, host: DOMAIN }
    });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.domainUnid, UNID);

    // Bearer Identity Token on a GET (no Origin header) uses Host.
    const meJwt = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { authorization: `Bearer ${token}`, 'x-api-key': publicKeyValue, host: DOMAIN }
    });
    assert.equal(meJwt.status, 200, JSON.stringify(meJwt.body));
    assert.equal(meJwt.body.profile?.given_name, 'Alex');

    // Without a secret, login is off but reports why.
    const off = createApi({ worker, keyStore, config: { pluginId } });
    const disabled = await off.handle({
      method: 'POST',
      path: '/auth/login',
      headers: idHeaders,
      body: { delegate_token: token }
    });
    assert.equal(disabled.status, 501);
    assert.match(disabled.body.error, /SESSION_SECRET/);
  } finally {
    await worker.destroy();
  }
});
