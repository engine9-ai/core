import { test } from 'node:test';
import assert from 'node:assert';
import { resolvePluginInstallUnique } from '../lib/utilities.js';
import SchemaWorker from '../lib/SchemaWorker.js';

test('resolvePluginInstallUnique: interfaces unique, person_custom and third-party not', () => {
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/interfaces/person' }), true);
  assert.equal(resolvePluginInstallUnique({ path: 'local$@engine9/interfaces/person_email' }), true);
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/interfaces/person', unique: false }), true);
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/interfaces/person_hash', metadata: { unique: true } }), true);

  assert.equal(resolvePluginInstallUnique({ path: '@engine9/interfaces/person_custom' }), false);
  assert.equal(resolvePluginInstallUnique({ path: 'local$@engine9/interfaces/person_custom' }), false);
  assert.equal(
    resolvePluginInstallUnique({ path: '@engine9/interfaces/person_custom', metadata: { unique: false } }),
    false
  );
  assert.equal(resolvePluginInstallUnique({ path: '@engine9/interfaces/person_custom', unique: true }), false);

  assert.equal(resolvePluginInstallUnique({ path: '@engine9/plugins/e9email', metadata: { unique: true } }), true);
  assert.equal(resolvePluginInstallUnique({ path: '@some-org/crm-sync' }), false);
  assert.equal(resolvePluginInstallUnique({ path: '@some-org/crm-sync', unique: true }), true);
});

test('client SchemaWorker: person_custom installs more than once; person does not', async () => {
  const schema = new SchemaWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await schema.installStandard();
    const customSchema = {
      tables: [{ name: 'field', columns: { id: 'id', custom_string: 'string' } }]
    };
    const first = await schema.install({
      path: '@engine9/interfaces/person_custom',
      name: 'Custom A',
      schema: customSchema
    });
    const second = await schema.install({
      path: '@engine9/interfaces/person_custom',
      name: 'Custom B',
      schema: customSchema
    });
    assert.notEqual(second.id, first.id, 'person_custom must create a new plugin row');
    const { data: customRows } = await schema.query(
      "select id from plugin where path='@engine9/interfaces/person_custom'"
    );
    assert.equal(customRows.length, 2);

    const personFirst = await schema.install({ path: '@engine9/interfaces/person' });
    const personSecond = await schema.install({ path: '@engine9/interfaces/person' });
    assert.equal(personSecond.id, personFirst.id, 'person installs uniquely by path');
  } finally {
    await schema.destroy();
  }
});
