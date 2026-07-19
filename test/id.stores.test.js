import { test, describe } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import PersonWorker from '../lib/PersonWorker.js';
import {
  assignPersonIds,
  bulkConvertPersonIdentifiers,
  hashIdValueToU128,
  hashIdValueToU128Hex,
  u128ToHexKey,
  identifierMapKey,
  durableObjectStorageKey,
  createCompactSqlIdentifierStore,
  createPersonIdentifierSqlStore,
  createDefaultIdentifierStore,
  createDurableObjectIdentifierStore,
  personIdTableName
} from '../lib/id/index.js';

/** Map-backed stand-in that mirrors Durable Object layout (storage key → person_id). */
function createMemoryIdentifierStore() {
  const storage = new Map();

  return {
    _storage: storage,
    async findByIdentifiers(entries) {
      const results = [];
      for (const e of entries || []) {
        if (!e?.id_type || e.id_value == null || e.id_value === '') continue;
        const hex = hashIdValueToU128Hex(e.id_value);
        const key = durableObjectStorageKey(e.id_type, hex);
        const personId = storage.get(key);
        if (personId == null) continue;
        results.push({ id_type: e.id_type, id_value: e.id_value, person_id: personId });
      }
      return results;
    },
    async insertIdentifiers(rows) {
      for (const row of rows || []) {
        if (!row?.id_type || row.id_value == null || row.id_value === '') continue;
        const hex = hashIdValueToU128Hex(row.id_value);
        const key = durableObjectStorageKey(row.id_type, hex);
        if (storage.has(key)) continue; // first-wins
        storage.set(key, Number(row.person_id));
      }
    }
  };
}

describe('createDefaultIdentifierStore', () => {
  test('SQLite worker → compact SQL store', () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    const store = createDefaultIdentifierStore(worker);
    assert.equal(store.kind, 'person_id_compact');
  });

  test('Durable Object binding → DO store (over SQLite)', () => {
    const worker = new PersonWorker({ accountId: 'acct-1', auth: { database_connection: 'sqlite://:memory:' } });
    worker.personIds = { idFromName: () => ({}), get: () => ({}) };
    const store = createDefaultIdentifierStore(worker);
    assert.equal(typeof store.findByIdentifiers, 'function');
    assert.equal(typeof store.insertIdentifiers, 'function');
    assert.notEqual(store.kind, 'person_id_compact');
    assert.notEqual(store.kind, 'person_identifier');
  });

  test('MySQL-shaped worker → person_identifier store', () => {
    const store = createDefaultIdentifierStore({
      accountId: 'test',
      auth: { database_connection: 'mysql://user:pass@localhost/db' }
    });
    assert.equal(store.kind, 'person_identifier');
  });
});

describe('id hash helpers', () => {
  test('hashIdValueToU128 is stable 16-byte buffer; hex matches', () => {
    const a = hashIdValueToU128('alice@example.com');
    const b = hashIdValueToU128('alice@example.com');
    assert.ok(Buffer.isBuffer(a));
    assert.equal(a.length, 16);
    assert.ok(a.equals(b));
    const expected = crypto
      .createHash('sha256')
      .update('alice@example.com', 'utf8')
      .digest()
      .subarray(0, 16);
    assert.ok(a.equals(expected));
    assert.equal(hashIdValueToU128Hex('alice@example.com'), expected.toString('hex'));
    assert.equal(u128ToHexKey(a), expected.toString('hex'));
    // Cloudflare D1 deserializes BLOBs as plain number arrays
    assert.equal(u128ToHexKey(Array.from(a)), expected.toString('hex'));
  });

  test('different id_values usually differ', () => {
    assert.notEqual(hashIdValueToU128Hex('a'), hashIdValueToU128Hex('b'));
  });

  test('key helpers namespace by id_type', () => {
    assert.equal(
      durableObjectStorageKey('email_hash_v1', 'aabbccddeeff00112233445566778899'),
      'email_hash_v1:aabbccddeeff00112233445566778899'
    );
    assert.equal(identifierMapKey('email_hash_v1', 'x'), 'email_hash_v1\0x');
    assert.equal(personIdTableName('email_hash_v1'), 'person_id_email_hash_v1');
    assert.equal(personIdTableName('remote_person_id'), 'person_id_remote_person_id');
    assert.throws(() => personIdTableName('bad-type!'), /Invalid id_type/);
  });

});

describe('memory identifier store (DO-shaped)', () => {
  test('find/insert and id_type namespace isolation', async () => {
    const store = createMemoryIdentifierStore();
    await store.insertIdentifiers([
      { id_type: 'email_hash_v1', id_value: 'same', person_id: 1 },
      { id_type: 'phone_hash_v1', id_value: 'same', person_id: 2 }
    ]);
    const found = await store.findByIdentifiers([
      { id_type: 'email_hash_v1', id_value: 'same' },
      { id_type: 'phone_hash_v1', id_value: 'same' },
      { id_type: 'remote_person_id', id_value: 'same' }
    ]);
    assert.equal(found.length, 2);
    assert.equal(found.find((r) => r.id_type === 'email_hash_v1').person_id, 1);
    assert.equal(found.find((r) => r.id_type === 'phone_hash_v1').person_id, 2);
  });

  test('insertIdentifiers is first-wins', async () => {
    const store = createMemoryIdentifierStore();
    await store.insertIdentifiers([{ id_type: 'email_hash_v1', id_value: 'x', person_id: 10 }]);
    await store.insertIdentifiers([{ id_type: 'email_hash_v1', id_value: 'x', person_id: 99 }]);
    const found = await store.findByIdentifiers([{ id_type: 'email_hash_v1', id_value: 'x' }]);
    assert.equal(found[0].person_id, 10);
  });
});

describe('compact SQL person_id_<id_type> store', () => {
  test('creates per-type tables with hashed value + person_id', async () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    try {
      await worker.installStandard();
      const store = createCompactSqlIdentifierStore(worker);
      await store.insertIdentifiers([
        { id_type: 'email_hash_v1', id_value: 'same', person_id: 1 },
        { id_type: 'phone_hash_v1', id_value: 'same', person_id: 2 }
      ]);

      const { data: tables } = await worker.query(
        "select name from sqlite_master where type='table' and name in ('person_id_email_hash_v1','person_id_phone_hash_v1') order by name"
      );
      assert.deepEqual(
        tables.map((t) => t.name),
        ['person_id_email_hash_v1', 'person_id_phone_hash_v1']
      );

      const binary = hashIdValueToU128('same');
      const { data: emailRows } = await worker.query({
        sql: 'select value, person_id from person_id_email_hash_v1',
        values: []
      });
      assert.equal(emailRows.length, 1);
      assert.equal(u128ToHexKey(emailRows[0].value), binary.toString('hex'));
      assert.ok(Buffer.isBuffer(emailRows[0].value) || emailRows[0].value instanceof Uint8Array);
      assert.equal(emailRows[0].value.length, 16);
      assert.equal(emailRows[0].person_id, 1);

      const found = await store.findByIdentifiers([
        { id_type: 'email_hash_v1', id_value: 'same' },
        { id_type: 'phone_hash_v1', id_value: 'same' }
      ]);
      assert.equal(found.find((r) => r.id_type === 'email_hash_v1').person_id, 1);
      assert.equal(found.find((r) => r.id_type === 'phone_hash_v1').person_id, 2);

      // first-wins
      await store.insertIdentifiers([{ id_type: 'email_hash_v1', id_value: 'same', person_id: 99 }]);
      const again = await store.findByIdentifiers([{ id_type: 'email_hash_v1', id_value: 'same' }]);
      assert.equal(again[0].person_id, 1);
    } finally {
      await worker.destroy();
    }
  });

  test('bulkConvert into compact SQL + assignPersonIds dedupes', async () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    try {
      await worker.installStandard();
      await worker.insertArray({ table: 'person', array: [{ id: 1 }, { id: 2 }] });
      const { data: people } = await worker.query('select id from person order by id');
      const p1 = people[0].id;
      const p2 = people[1].id;
      await worker.insertArray({
        table: 'person_identifier',
        array: [
          { person_id: p1, source_input_id: null, id_type: 'email_hash_v1', id_value: 'hash-a' },
          { person_id: p2, source_input_id: null, id_type: 'email_hash_v1', id_value: 'hash-b' }
        ]
      });

      const compact = createCompactSqlIdentifierStore(worker);
      const summary = await bulkConvertPersonIdentifiers({ worker, store: compact });
      assert.equal(summary.written, 2);

      const inputId = '00000000-0000-0000-0000-000000000011';
      const batch = await assignPersonIds({
        worker,
        identifierStore: compact,
        batch: [
          {
            input_id: inputId,
            identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: 'hash-a' }]
          }
        ]
      });
      assert.equal(batch[0].person_id, p1);
    } finally {
      await worker.destroy();
    }
  });

  test('assignPersonIds on SQLite defaults to compact tables', async () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    try {
      await worker.installStandard();
      const inputId = '00000000-0000-0000-0000-000000000013';
      const batch = await assignPersonIds({
        worker,
        batch: [
          {
            input_id: inputId,
            identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: 'default-compact-key' }]
          }
        ]
      });
      assert.ok(batch[0].person_id);
      const { data: compact } = await worker.query('select person_id from person_id_email_hash_v1');
      assert.equal(compact.length, 1);
      assert.equal(compact[0].person_id, batch[0].person_id);
      const { data: legacy } = await worker.query('select * from person_identifier');
      assert.equal(legacy.length, 0);
    } finally {
      await worker.destroy();
    }
  });

  test('person_identifier store still writes the full table', async () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    try {
      await worker.installStandard();
      const store = createPersonIdentifierSqlStore(worker);
      const inputId = '00000000-0000-0000-0000-000000000012';
      await assignPersonIds({
        worker,
        identifierStore: store,
        batch: [
          {
            input_id: inputId,
            identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: 'full-table-key' }]
          }
        ]
      });
      const { data } = await worker.query('select id_type, id_value, person_id from person_identifier');
      assert.equal(data.length, 1);
      assert.equal(data[0].id_type, 'email_hash_v1');
      assert.equal(data[0].id_value, 'full-table-key');
    } finally {
      await worker.destroy();
    }
  });
});

describe('bulkConvertPersonIdentifiers + assignPersonIds with injectable store', () => {
  test('bulk converts SQL person_identifier into a memory store', async () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    try {
      await worker.installStandard();
      await worker.insertArray({
        table: 'person',
        array: [{ id: 1 }, { id: 2 }]
      });
      const { data: people } = await worker.query('select id from person order by id');
      const p1 = people[0].id;
      const p2 = people[1].id;
      await worker.insertArray({
        table: 'person_identifier',
        array: [
          { person_id: p1, source_input_id: null, id_type: 'email_hash_v1', id_value: 'hash-a' },
          { person_id: p2, source_input_id: null, id_type: 'email_hash_v1', id_value: 'hash-b' },
          { person_id: p1, source_input_id: null, id_type: 'phone_hash_v1', id_value: 'hash-a' }
        ]
      });

      const store = createMemoryIdentifierStore();
      const summary = await bulkConvertPersonIdentifiers({ worker, store, batchSize: 2 });
      assert.equal(summary.read, 3);
      assert.equal(summary.written, 3);
      assert.equal(summary.skipped, 0);

      const found = await store.findByIdentifiers([
        { id_type: 'email_hash_v1', id_value: 'hash-a' },
        { id_type: 'phone_hash_v1', id_value: 'hash-a' }
      ]);
      assert.equal(found.find((r) => r.id_type === 'email_hash_v1').person_id, p1);
      assert.equal(found.find((r) => r.id_type === 'phone_hash_v1').person_id, p1);
    } finally {
      await worker.destroy();
    }
  });

  test('assignPersonIds uses injectable store for lookup and insert', async () => {
    const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
    try {
      await worker.installStandard();
      const store = createMemoryIdentifierStore();
      const inputId = '00000000-0000-0000-0000-000000000010';

      const batch1 = await assignPersonIds({
        worker,
        identifierStore: store,
        batch: [
          {
            input_id: inputId,
            identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: 'dedupe-key-1' }]
          }
        ]
      });
      assert.ok(batch1[0].person_id);
      const personId = batch1[0].person_id;

      // SQL person row exists; identifier lives in compact store only
      const { data: people } = await worker.query('select id from person');
      assert.equal(people.length, 1);
      const { data: sqlIds } = await worker.query('select * from person_identifier');
      assert.equal(sqlIds.length, 0);

      const batch2 = await assignPersonIds({
        worker,
        identifierStore: store,
        batch: [
          {
            input_id: inputId,
            identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: 'dedupe-key-1' }]
          }
        ]
      });
      assert.equal(batch2[0].person_id, personId);
      const { data: people2 } = await worker.query('select id from person');
      assert.equal(people2.length, 1, 'no second person created on dedupe');
    } finally {
      await worker.destroy();
    }
  });
});
