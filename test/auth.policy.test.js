import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveAuthContext,
  hasScope,
  intersectScopes,
  meetsRequiredAuth
} from '../auth/policy.js';
import { SqlApiKeyStore, hashApiKey } from '../auth/index.js';
import { parseSharedSecrets, signPayload, verifySignedPayload } from '../auth/hmac.js';
import PersonWorker from '../lib/PersonWorker.js';
import { getVersionedUUID } from '../lib/utilities.js';

test('intersectScopes and hasScope', () => {
  assert.deepEqual(intersectScopes([], []), []);
  assert.deepEqual(intersectScopes(['people:write'], []), ['people:write']);
  assert.deepEqual(intersectScopes([], ['data:read']), ['data:read']);
  assert.deepEqual(intersectScopes(['people:write', 'data:read'], ['data:read']), ['data:read']);
  assert.deepEqual(intersectScopes(['*'], ['data:read']), ['data:read']);
  assert.deepEqual(intersectScopes(['people:write'], ['*']), ['people:write']);

  assert.equal(hasScope([], 'people:write'), true);
  assert.equal(hasScope(['*'], 'people:write'), true);
  assert.equal(hasScope(['data:read'], 'people:write'), false);
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
    apiKey: { scopes: [] },
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
    await worker.installStandard();
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
    assert.ok(rotated.key.indexOf('e9k_') === 0);
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

test('HMAC helpers: parseSharedSecrets and verifySignedPayload', () => {
  assert.deepEqual(parseSharedSecrets('a, b ,c'), ['a', 'b', 'c']);
  const encoded = Buffer.from('{"x":1}', 'utf8').toString('base64url');
  const sig = signPayload(encoded, 'secret-a');
  assert.equal(verifySignedPayload(encoded, sig, ['secret-b', 'secret-a']), true);
  assert.equal(verifySignedPayload(encoded, sig, ['secret-b']), false);
});
