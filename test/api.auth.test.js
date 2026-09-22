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

const UNID = '11111111-2222-8e91-8333-444444444444';
const SITE = 'https://site.example.com';
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

async function signIdentityJwt({ privateKey, kid = 'api-test-key', level = 2, unid = UNID, profile, auth }) {
  const jwt = new SignJWT({
    unid,
    level,
    profile: profile || {
      id: 'prof-api',
      email: 'api@example.com',
      email_verified: true
    },
    auth: auth || { provider: 'google.com', two_factor: false, auth_time: 1700000000 }
  });
  jwt.setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' });
  jwt.setIssuer(DELEGATE_URL);
  jwt.setAudience(SITE);
  jwt.setSubject(profile?.id || 'prof-api');
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

    const fetchImpl = async (url, options) => {
      if (String(url).includes('/.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (String(url).includes('/handoff/exchange')) {
        return new Response(
          JSON.stringify({
            unid: UNID,
            firebaseUid: 'fb-api',
            email: 'api@example.com',
            level: 2,
            profile_id: 'prof-handoff',
            auth: { loggedIn: true, signInProvider: 'google.com', twoFactor: false }
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const peopleByUnid = new Map();
    let nextPersonId = 1;
    worker.processPeople = async ({ batch }) => {
      const personIds = (batch || []).map((row) => {
        const unid = row.delegate_id;
        if (unid && peopleByUnid.has(unid)) return peopleByUnid.get(unid);
        const id = nextPersonId++;
        if (unid) peopleByUnid.set(unid, id);
        return id;
      });
      return { personIds, records: personIds.length, recordsWithPersonIds: personIds.length };
    };

    const delegateAuth = createDelegateAuth({
      worker,
      delegateUrl: DELEGATE_URL,
      site: SITE,
      handoffSecret: 'shared',
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

    const loginCode = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: apiHeaders,
      body: { delegate_code: 'one-time-code', return_to: `${SITE}/auth/delegate` }
    });
    assert.equal(loginCode.status, 200, JSON.stringify(loginCode.body));
    assert.ok(loginCode.body.token);
    assert.ok(loginCode.body.session.personId > 0);
    assert.equal(loginCode.body.session.unid, UNID);
    assert.equal(loginCode.body.session.level, 2);
    assert.equal(loginCode.body.session.profileId, 'prof-handoff');
    const personId = loginCode.body.session.personId;
    const sessionToken = loginCode.body.token;

    const meSession = await api.handle({
      method: 'GET',
      path: '/auth/me',
      headers: { ...apiHeaders, 'x-engine9-session': sessionToken }
    });
    assert.equal(meSession.status, 200, JSON.stringify(meSession.body));
    assert.equal(meSession.body.personId, personId);
    assert.equal(meSession.body.unid, UNID);
    assert.equal(meSession.body.level, 2);
    assert.equal(meSession.body.profileId, 'prof-handoff');
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
    assert.equal(meJwt.body.unid, UNID);
    assert.equal(meJwt.body.level, 2);
    assert.equal(meJwt.body.profileId, 'prof-api');
    assert.equal(meJwt.body.profile?.email, 'api@example.com');
    assert.equal(await kv.get(`unid:${UNID}`), String(personId));

    const loginJwt = await api.handle({
      method: 'POST',
      path: '/auth/login',
      headers: apiHeaders,
      body: { delegate_token: jwt, return_to: `${SITE}/callback` }
    });
    assert.equal(loginJwt.status, 200, JSON.stringify(loginJwt.body));
    assert.equal(loginJwt.body.session.level, 2);
    assert.equal(loginJwt.body.session.profileId, 'prof-api');

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
