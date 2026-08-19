import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMariaDb, supportsColumnLevelCheckConstraints } from '../lib/sql/dialects/MySQL.js';

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
