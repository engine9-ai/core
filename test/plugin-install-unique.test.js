import { test } from 'node:test';
import assert from 'node:assert';
import { resolvePluginInstallUnique } from '../lib/utilities.js';

test('resolvePluginInstallUnique: schema plugins unique, person_custom and third-party not', () => {
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/schemas/person' }), true);
  assert.equal(resolvePluginInstallUnique({ path: 'local$@engine9/schemas/person_email' }), true);
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/schemas/person', unique: false }), true);
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/schemas/person_hash', metadata: { unique: true } }), true);

  assert.equal(resolvePluginInstallUnique({ path: '@engine9/schemas/person_custom' }), false);
  assert.equal(resolvePluginInstallUnique({ path: 'local$@engine9/schemas/person_custom' }), false);
  assert.equal(
    resolvePluginInstallUnique({ path: '@engine9/schemas/person_custom', metadata: { unique: false } }),
    false
  );
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/schemas/person_custom', unique: true }), false);

  assert.equal(resolvePluginInstallUnique({ path: '@engine9/plugins/e9email', metadata: { unique: true } }), true);
  assert.equal(resolvePluginInstallUnique({ path: '@some-org/crm-sync' }), false);
  assert.equal(resolvePluginInstallUnique({ path: '@some-org/crm-sync', unique: true }), true);
});
