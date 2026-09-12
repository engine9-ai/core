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

test('SQLWorker describe maps compact person_id_* value column to id_u128', async () => {
  const sql = new SQLWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await sql.query(
      'create table if not exists person_id_email_hash_v1 (value blob not null primary key, person_id bigint not null)'
    );
    const desc = await sql.describe({ table: 'person_id_email_hash_v1' });
    const value = desc.columns.find((c) => c.name === 'value');
    assert.equal(value.type, 'id_u128');
    assert.equal(value.column_type, 'blob');
    assert.equal(value.nullable, false);
  } finally {
    await sql.destroy();
  }
});

test('SQLWorker createTable/alterTable keep index names within identifier limit', async () => {
  const sql = new SQLWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  const table = 'model_authentic_origin_transaction_stats_by_date';
  try {
    await sql.createTable({
      table,
      columns: [
        { name: 'source_code_id', type: 'bigint' },
        { name: 'date', type: 'date' },
        { name: 'revenue', type: 'currency' }
      ],
      indexes: [
        { columns: ['date', 'source_code_id'], primary: true },
        { columns: ['source_code_id'] }
      ]
    });
    await sql.alterTable({
      table,
      indexes: [{ columns: ['date'] }]
    });
    const idx = await sql.indexes({ table });
    for (const i of idx) {
      assert.ok(i.index_name.length <= 64, i.index_name);
    }
    assert.ok(idx.find((i) => i.columns.join(',') === 'source_code_id'));
    assert.ok(idx.find((i) => i.columns.join(',') === 'date'));
  } finally {
    await sql.destroy();
  }
});

test('SQLWorker.createApiKey deploys api_key and returns plaintext once', async () => {
  const sql = new SQLWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await assert.rejects(() => sql.createApiKey({ name: 'x' }), /scopes are required/);
    const created = await sql.createApiKey({
      name: 'partner-tasks',
      scopes: 'tasks:read,tasks:schedule'
    });
    assert.ok(created.key.indexOf('e9key_') === 0);
    assert.equal(created.name, 'partner-tasks');
    assert.deepEqual(created.scopes, ['tasks:read', 'tasks:schedule']);
    const { data } = await sql.query('select name, key_hash, scopes from api_key');
    assert.equal(data.length, 1);
    assert.equal(data[0].name, 'partner-tasks');
    assert.notEqual(data[0].key_hash, created.key);
    const again = await sql.createApiKey({ name: 'second', scopes: ['admin'] });
    assert.ok(again.key.indexOf('e9key_') === 0);
    const { data: rows } = await sql.query('select name from api_key order by name');
    assert.equal(rows.length, 2);
    const listed = await sql.listApiKeys();
    assert.equal(listed.length, 2);
    assert.equal(listed.every((row) => !('key_hash' in row) && !('key' in row)), true);
    const updated = await sql.updateApiKey({ id: created.id, scopes: ['tasks:read'] });
    assert.deepEqual(updated.scopes, ['tasks:read']);
    const revoked = await sql.revokeApiKey({ id: created.id });
    assert.equal(revoked.active, false);
  } finally {
    await sql.destroy();
  }
});
