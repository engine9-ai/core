import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMariaDb, supportsColumnLevelCheckConstraints, dialectToStandard, getType } from '../lib/sql/dialects/MySQL.js';
import {
  dialectToStandard as sqliteToStandard,
  getType as sqliteGetType
} from '../lib/sql/dialects/SQLite.js';

test('isMariaDb detects MariaDB version() strings only', () => {
  assert.equal(isMariaDb('10.11.8-MariaDB-1:10.11.8+maria~deb12'), true);
  assert.equal(isMariaDb('11.4.2-MariaDB'), true);
  assert.equal(isMariaDb('11.8.2-MariaDB-ubu2404'), true);
  assert.equal(isMariaDb('8.0.42'), false);
  assert.equal(isMariaDb('8.0.42-log'), false);
  assert.equal(isMariaDb('8.0.mysql_aurora.3.08.0'), false);
  assert.equal(isMariaDb('8.0.42-33'), false); // Percona
  assert.equal(isMariaDb(undefined), false);
  assert.equal(isMariaDb(''), false);
});

test('supportsColumnLevelCheckConstraints is MariaDB-only (MySQL 8 has no LEVEL column)', () => {
  assert.equal(supportsColumnLevelCheckConstraints('10.6.16-MariaDB-log'), true);
  assert.equal(supportsColumnLevelCheckConstraints('8.0.42'), false);
  assert.equal(supportsColumnLevelCheckConstraints(undefined), false);
});

test('id_u128 maps MySQL binary(16) from compact person_id_* tables', () => {
  assert.equal(getType('id_u128').column_type, 'binary(16)');
  const fromDescribe = dialectToStandard(
    {
      name: 'value',
      column_type: 'binary(16)',
      length: 16,
      nullable: false,
      default_value: undefined,
      auto_increment: false
    },
    {}
  );
  assert.equal(fromDescribe.type, 'id_u128');
  assert.equal(fromDescribe.column_type, 'binary(16)');
  assert.equal(fromDescribe.nullable, false);
  const fromBinaryLength = dialectToStandard(
    { name: 'value', column_type: 'binary', length: 16, nullable: false, auto_increment: false },
    {}
  );
  assert.equal(fromBinaryLength.type, 'id_u128');
});

test('id_u128 maps SQLite blob from compact person_id_* tables', () => {
  assert.equal(sqliteGetType('id_u128').column_type, 'blob');
  const fromBlob = sqliteToStandard(
    {
      name: 'value',
      column_type: 'blob',
      nullable: false,
      default_value: undefined,
      auto_increment: false
    },
    {}
  );
  assert.equal(fromBlob.type, 'id_u128');
  assert.equal(fromBlob.column_type, 'blob');
  const fromBinary16 = sqliteToStandard(
    { name: 'value', column_type: 'binary(16)', nullable: false, auto_increment: false },
    {}
  );
  assert.equal(fromBinary16.type, 'id_u128');
  assert.equal(fromBinary16.column_type, 'blob');
});
