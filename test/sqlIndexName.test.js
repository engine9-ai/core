import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateTable, buildAlterTable } from '../lib/sql/sqliteDDL.js';
import { SQL_IDENTIFIER_MAX_LENGTH, sqlIndexName } from '../lib/sql/sqlIndexName.js';

test('sqlIndexName keeps short names intact', () => {
  assert.equal(sqlIndexName('person', ['person_id']), 'person_person_id_idx');
  assert.equal(sqlIndexName('person', ['email'], { unique: true }), 'person_email_uidx');
  assert.equal(sqlIndexName('person', 'source_code_id, date'), 'person_source_code_id_date_idx');
});

test('sqlIndexName truncates knex-style overflow and appends a stable id', () => {
  const table = 'model_authentic_origin_transaction_stats_by_date';
  const knexDefault = `${table}_source_code_id_index`;
  assert.ok(knexDefault.length > SQL_IDENTIFIER_MAX_LENGTH);

  const name = sqlIndexName(table, ['source_code_id']);
  assert.ok(name.length <= SQL_IDENTIFIER_MAX_LENGTH, name);
  assert.match(name, /^model_authentic_origin_transaction_stats_by_date_/);
  assert.match(name, /_[0-9a-f]{8}$/);
  assert.equal(sqlIndexName(table, ['source_code_id']), name);
  assert.notEqual(sqlIndexName(table, ['date', 'source_code_id']), name);
});

test('sqlite DDL uses truncated index names', () => {
  const table = 'model_authentic_origin_transaction_stats_by_date';
  const { statements } = buildCreateTable({
    table,
    columns: [
      { name: 'source_code_id', type: 'source_code_id' },
      { name: 'date', type: 'date' }
    ],
    indexes: [
      { columns: ['date', 'source_code_id'], primary: true },
      { columns: ['source_code_id'] }
    ]
  });
  const indexSql = statements.find((s) => s.startsWith('create ') && s.includes('index'));
  assert.ok(indexSql, statements.join('\n'));
  const quoted = indexSql.match(/"([^"]+)"/);
  assert.ok(quoted);
  assert.ok(quoted[1].length <= SQL_IDENTIFIER_MAX_LENGTH, quoted[1]);

  const alter = buildAlterTable({
    table,
    indexes: [{ columns: ['source_code_id'] }]
  });
  const alterQuoted = alter.statements[0].match(/"([^"]+)"/);
  assert.equal(alterQuoted[1], quoted[1]);
});
