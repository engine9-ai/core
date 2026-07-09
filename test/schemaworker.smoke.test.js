import { test } from 'node:test';
import assert from 'node:assert';
import SchemaWorker from '../lib/SchemaWorker.js';

test('client SchemaWorker: installStandard bootstraps a SQLite database', async () => {
  const schema = new SchemaWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    const r = await schema.installStandard();
    assert.equal(r.complete, true);
    const { tables } = await schema.tables();
    for (const t of ['plugin', 'person', 'person_identifier', 'person_email', 'person_phone', 'person_address', 'segment', 'person_segment', 'timeline', 'source_code_dictionary', 'transaction']) {
      assert.ok(tables.indexOf(t) >= 0, `expected table ${t}, got ${tables.join(',')}`);
    }
    const { data: plugins } = await schema.query('select path from plugin order by path');
    assert.ok(plugins.length >= 10, `expected >=10 plugin rows, got ${plugins.length}`);

    // idempotent: re-run should not error and not duplicate plugin rows
    await schema.installStandard();
    const { data: plugins2 } = await schema.query('select path from plugin');
    assert.equal(plugins2.length, plugins.length, 'no duplicate plugin rows');

    // diff after full deploy should be empty
    const d = await schema.diff({ schema: '@engine9/interfaces/person' });
    assert.equal(d.tables.length, 0, `expected no diffs, got ${JSON.stringify(d.tables)}`);
  } finally {
    await schema.destroy();
  }
});
