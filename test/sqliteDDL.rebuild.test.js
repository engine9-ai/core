import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildAlterTable, buildTableRebuild } from '../lib/sql/sqliteDDL.js';

test('D1 cannot ADD a CURRENT_TIMESTAMP column, so that alter rebuilds the table', () => {
  const modifiedAt = {
    name: 'modified_at',
    type: 'modified_at',
    nullable: false,
    default_value: 'current_timestamp()',
    differences: 'new'
  };
  const alter = buildAlterTable({
    table: 'person_segment',
    columns: [modifiedAt]
  });
  assert.equal(alter.rebuild, true);
  assert.deepEqual(alter.rebuildColumns.map((col) => col.name), ['modified_at']);
  assert.equal(
    alter.statements.some((sql) => /add column/i.test(sql)),
    false
  );

  const constant = buildAlterTable({
    table: 'segment',
    columns: [{ name: 'join_min_level', type: 'int', nullable: true, differences: 'new' }]
  });
  assert.equal(constant.rebuild, false);
  assert.match(constant.statements[0], /add column "join_min_level"/i);

  const db = new DatabaseSync(':memory:');
  db.exec(
    `create table person_segment (
      id integer not null primary key autoincrement,
      person_id bigint not null default 0,
      segment_id char(36)
    )`
  );
  db.exec('insert into person_segment (person_id, segment_id) values (7, \'seg\')');
  db.exec('create index idx_person_segment_person_id on person_segment (person_id)');
  const statements = buildTableRebuild({
    table: 'person_segment',
    existingColumns: [
      { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
      { name: 'person_id', type: 'bigint', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'segment_id', type: 'char(36)', notnull: 0, dflt_value: null, pk: 0 }
    ],
    newColumns: [modifiedAt],
    indexSql: ['create index "idx_person_segment_person_id" on "person_segment" ("person_id")'],
    autoincrement: true
  });
  for (const sql of statements) db.exec(sql);

  const copied = db.prepare('select person_id, modified_at from person_segment where person_id = 7').get();
  assert.equal(copied.person_id, 7);
  assert.ok(copied.modified_at, 'existing row receives CURRENT_TIMESTAMP from the new column default');

  db.exec('insert into person_segment (person_id) values (8)');
  const inserted = db.prepare('select modified_at from person_segment where person_id = 8').get();
  assert.ok(inserted.modified_at, 'later inserts still receive CURRENT_TIMESTAMP');

  const columns = db.prepare('pragma table_info(person_segment)').all().map((col) => col.name);
  assert.ok(columns.includes('modified_at'));
  db.close();
});

test('a modified_at default difference is its trigger; other differences stay skipped', () => {
  const plan = buildAlterTable({
    table: 'api_key',
    columns: [
      { name: 'modified_at', type: 'modified_at', differences: { default_value: { schema: 'x', db: 'y' } } },
      { name: 'id', type: 'id_uuid', differences: { column_type: { schema: 'uuid', db: 'integer' } } }
    ]
  });
  assert.equal(plan.statements.length, 1);
  assert.match(plan.statements[0], /^create trigger if not exists "api_key_modified_at_auto_update"/);
  assert.deepEqual(plan.skipped.map((s) => s.column), ['id']);
});

test('a rebuild keeps a single non-integer primary key', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table api_key (id char(36) not null, name varchar(255), primary key ("id"))');
  db.exec("insert into api_key (id, name) values ('a', 'site-admin')");
  const statements = buildTableRebuild({
    table: 'api_key',
    existingColumns: db.prepare('pragma table_info(api_key)').all(),
    newColumns: [{ name: 'modified_at', type: 'modified_at', nullable: false, default_value: 'current_timestamp()', differences: 'new' }]
  });
  for (const sql of statements) db.exec(sql);
  const pk = db.prepare('pragma table_info(api_key)').all().filter((col) => col.pk > 0).map((col) => col.name);
  assert.deepEqual(pk, ['id']);
  assert.throws(() => db.exec("insert into api_key (id, name) values ('a', 'again')"), /UNIQUE|PRIMARY/);
  db.close();
});
