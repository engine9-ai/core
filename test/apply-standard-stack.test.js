import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';

test('installStandard bootstraps a SQLite database for the person pipeline', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    const r = await worker.installStandard();
    assert.equal(r.complete, true);
    const { tables } = await worker.tables();
    for (const t of ['plugin', 'person', 'person_identifier', 'person_email', 'person_phone', 'person_address', 'segment', 'person_segment', 'timeline', 'source_code_dictionary', 'transaction']) {
      assert.ok(tables.indexOf(t) >= 0, `expected table ${t}, got ${tables.join(',')}`);
    }
    const { data: pluginRows } = await worker.query('select path from plugin order by path');
    assert.ok(pluginRows.length >= 10, `expected >=10 plugin rows, got ${pluginRows.length}`);

    await worker.installStandard();
    const { data: plugins2 } = await worker.query('select path from plugin');
    assert.equal(plugins2.length, pluginRows.length, 'no duplicate plugin rows');
  } finally {
    await worker.destroy();
  }
});
