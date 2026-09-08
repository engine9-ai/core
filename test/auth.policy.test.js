import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveAuthContext,
  hasScope,
  intersectScopes,
  meetsRequiredAuth,
  assertValidKeyScopes
} from '../auth/policy.js';
import {
  SqlApiKeyStore,
  hashApiKey,
  generateApiKey,
  getApiKeyCatalog,
  PUBLIC_API_KEY_PREFIX,
  API_KEY_PREFIX
} from '../auth/index.js';
import { PUBLIC_SCOPE, ADMIN_SCOPE } from '../auth/policy.js';
import { parseSharedSecrets, signPayload, verifySignedPayload } from '../auth/hmac.js';
import PersonWorker from '../lib/PersonWorker.js';
import { getVersionedUUID } from '../lib/utilities.js';
import { applyStandardStack } from './helpers/applySchemas.js';

test('intersectScopes and hasScope', () => {
  assert.deepEqual(intersectScopes([], []), []);
  assert.deepEqual(intersectScopes(['people:write'], []), ['people:write']);
  assert.deepEqual(intersectScopes([], ['data:read']), []);
  assert.deepEqual(intersectScopes(['people:write', 'data:read'], ['data:read']), ['data:read']);
  assert.deepEqual(intersectScopes(['admin'], ['data:read']), ['data:read']);
  assert.deepEqual(intersectScopes(['people:write'], ['admin']), ['people:write']);

  assert.equal(hasScope([], 'people:write'), false);
  assert.equal(hasScope(['admin'], 'people:write'), true);
  assert.equal(hasScope(['data:read'], 'people:write'), false);

  assert.throws(() => assertValidKeyScopes([]), /required/);
  assert.throws(() => assertValidKeyScopes(['*']), /admin/);
  assert.deepEqual(assertValidKeyScopes([' tasks:read ', '']), ['tasks:read']);
  assert.ok(generateApiKey({ scopes: [ADMIN_SCOPE] }).startsWith(API_KEY_PREFIX));
  assert.ok(generateApiKey({ scopes: [PUBLIC_SCOPE] }).startsWith(PUBLIC_API_KEY_PREFIX));
});

test('meetsRequiredAuth and resolveAuthContext', () => {
  const roleId = getVersionedUUID();
  const registry = {
    [roleId]: {
      name: 'VIP',
      scopes: ['data:read'],
      requiredAuth: { twoFactor: true }
    }
  };

  assert.equal(meetsRequiredAuth({}, { twoFactor: false }), true);
  assert.equal(meetsRequiredAuth({ twoFactor: true }, { twoFactor: true }), true);
  assert.equal(meetsRequiredAuth({ twoFactor: true }, { twoFactor: false }), false);

  const ctx = resolveAuthContext({
    apiKey: { id: 'k1', scopes: ['data:read', 'people:write'], default_role_id: roleId },
    rolesRegistry: registry,
    session: { roles: [], auth: { twoFactor: false } }
  });
  assert.equal(ctx.roleId, roleId);
  assert.deepEqual(ctx.scopes, ['data:read']);
  assert.equal(ctx.authSatisfied, false);

  const ok = resolveAuthContext({
    apiKey: { scopes: ['admin'] },
    roleId,
    rolesRegistry: registry,
    session: { roles: [roleId], auth: { twoFactor: true } }
  });
  assert.equal(ok.authSatisfied, true);
  assert.deepEqual(ok.scopes, ['data:read']);
});

test('SqlApiKeyStore default_role_id and rotate', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const store = new SqlApiKeyStore({ worker });
    await store.deploy();
    const roleId = getVersionedUUID();
    const created = await store.create({
      name: 'site',
      scopes: ['data:read'],
      defaultRoleId: roleId
    });
    assert.equal(created.default_role_id, roleId);
    const looked = await store.lookup(created.key);
    assert.equal(looked.default_role_id, roleId);

    const rotated = await store.rotate({ id: created.id });
    assert.ok(rotated.key.indexOf('e9key_') === 0);
    assert.notEqual(rotated.key, created.key);
    assert.equal(rotated.revokedId, created.id);
    assert.equal(rotated.default_role_id, roleId);

    const old = await store.verify(created.key);
    assert.equal(old.valid, false);
    const next = await store.verify(rotated.key);
    assert.equal(next.valid, true);
    assert.equal(hashApiKey(rotated.key).length, 64);
  } finally {
    await worker.destroy();
  }
});

test('getApiKeyCatalog lists known scopes and prefixes', () => {
  const catalog = getApiKeyCatalog();
  assert.equal(catalog.prefixes.standard, API_KEY_PREFIX);
  assert.equal(catalog.prefixes.public, PUBLIC_API_KEY_PREFIX);
  assert.ok(catalog.scopes.some((s) => s.id === 'tasks:read'));
  assert.ok(catalog.scopes.some((s) => s.id === PUBLIC_SCOPE && s.prefix === PUBLIC_API_KEY_PREFIX));
  assert.ok(catalog.commands.includes('create'));
  assert.equal(catalog.plaintext.stored, false);
});

test('SqlApiKeyStore list, update, and revoke', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const store = new SqlApiKeyStore({ worker });
    await store.deploy();
    const created = await store.create({
      name: 'partner-tasks',
      scopes: ['tasks:read', 'tasks:schedule']
    });
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.deepEqual(listed[0].scopes, ['tasks:read', 'tasks:schedule']);
    assert.equal(listed[0].active, true);
    assert.equal('key_hash' in listed[0], false);
    assert.equal('key' in listed[0], false);

    const updated = await store.update({
      id: created.id,
      name: 'partner-read',
      scopes: ['tasks:read']
    });
    assert.equal(updated.name, 'partner-read');
    assert.deepEqual(updated.scopes, ['tasks:read']);
    const stillValid = await store.verify(created.key);
    assert.equal(stillValid.valid, true);

    const revoked = await store.revoke({ id: created.id });
    assert.equal(revoked.active, false);
    const after = await store.verify(created.key);
    assert.equal(after.valid, false);
    const activeOnly = await store.list({ includeInactive: false });
    assert.equal(activeOnly.length, 0);
    const all = await store.list({ includeInactive: true });
    assert.equal(all.length, 1);
    assert.equal(all[0].active, false);
  } finally {
    await worker.destroy();
  }
});

test('HMAC helpers: parseSharedSecrets and verifySignedPayload', () => {
  assert.deepEqual(parseSharedSecrets('a, b ,c'), ['a', 'b', 'c']);
  const encoded = Buffer.from('{"x":1}', 'utf8').toString('base64url');
  const sig = signPayload(encoded, 'secret-a');
  assert.equal(verifySignedPayload(encoded, sig, ['secret-b', 'secret-a']), true);
  assert.equal(verifySignedPayload(encoded, sig, ['secret-b']), false);
});
