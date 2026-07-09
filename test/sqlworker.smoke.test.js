import { test } from 'node:test';
import assert from 'node:assert';
import SQLWorker from '../lib/SQLWorker.js';

test('client SQLWorker: SQLite create/upsert/describe round trip', async () => {
  const sql = new SQLWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await sql.createTable({
      table: 'person_email',
      columns: [
        { name: 'id', type: 'id' },
        { name: 'person_id', type: 'person_id' },
        { name: 'email', type: 'string' },
        { name: 'email_hash_v1', type: 'hash' },
        { name: 'created_at', type: 'created_at' },
        { name: 'modified_at', type: 'modified_at' }
      ],
      indexes: [{ columns: ['email_hash_v1'], unique: true }]
    });
    const { tables } = await sql.tables();
    assert.ok(tables.indexOf('person_email') >= 0, 'table created');

    const desc = await sql.describe({ table: 'person_email' });
    assert.ok(desc.columns.find((c) => c.name === 'email'), 'describe returns email column');
    assert.ok(desc.columns.find((c) => c.name === 'id').auto_increment, 'id is auto_increment');

    await sql.upsertArray({
      table: 'person_email',
      array: [
        { id: 1, person_id: 10, email: 'a@example.com', email_hash_v1: 'h1' },
        { id: 2, person_id: 11, email: 'b@example.com', email_hash_v1: 'h2' }
      ]
    });
    // upsert same key with new value
    await sql.upsertArray({
      table: 'person_email',
      array: [{ id: 1, person_id: 10, email: 'a2@example.com', email_hash_v1: 'h1' }]
    });
    const { data } = await sql.query('select id,person_id,email from person_email order by id');
    assert.equal(data.length, 2);
    assert.equal(data[0].email, 'a2@example.com');

    const idx = await sql.indexes({ table: 'person_email' });
    assert.ok(idx.find((i) => i.primary), 'has primary');
    assert.ok(
      idx.find((i) => !i.primary && i.unique && i.columns.join(',') === 'email_hash_v1'),
      'has unique index'
    );

    const one = await sql.insertOne({ table: 'person_email', row: { person_id: 12, email: 'c@example.com', email_hash_v1: 'h3' } });
    assert.equal(one.id, 3, 'insertOne returns auto id');

    // additive alter
    await sql.alterTable({
      table: 'person_email',
      columns: [{ name: 'status', type: 'string', differences: 'new' }]
    });
    const desc2 = await sql.describe({ table: 'person_email' });
    assert.ok(desc2.columns.find((c) => c.name === 'status'), 'alterTable added column');
  } finally {
    await sql.destroy();
  }
});
