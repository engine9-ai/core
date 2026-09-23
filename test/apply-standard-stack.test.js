import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { DEFAULT_CORE_INTERFACES } from '../lib/stackMetadata.js';

test('installStandard bootstraps a SQLite database for the person pipeline', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    const r = await worker.installStandard();
    assert.equal(r.complete, true);
    assert.equal(r.path, null);
    assert.deepEqual(r.installed, DEFAULT_CORE_INTERFACES);
    const { tables } = await worker.tables();
    for (const t of [
      'plugin',
      'person',
      'person_identifier',
      'person_email',
      'person_phone',
      'person_address',
      'segment',
      'person_segment'
    ]) {
      assert.ok(tables.indexOf(t) >= 0, `expected table ${t}, got ${tables.join(',')}`);
    }
    for (const t of ['timeline', 'source_code_dictionary', 'transaction']) {
      assert.ok(tables.indexOf(t) < 0, `did not expect table ${t} from no-arg installStandard`);
    }
    const { data: pluginRows } = await worker.query('select path from plugin order by path');
    assert.equal(pluginRows.length, DEFAULT_CORE_INTERFACES.length);
    assert.deepEqual(
      pluginRows.map((row) => row.path).sort(),
      [...DEFAULT_CORE_INTERFACES].sort()
    );

    await worker.installStandard();
    const { data: plugins2 } = await worker.query('select path from plugin');
    assert.equal(plugins2.length, pluginRows.length, 'no duplicate plugin rows');
  } finally {
    await worker.destroy();
  }
});
