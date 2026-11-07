/*
  MySQL and MariaDB without a server: SQLWorker.describe (MariaDB keeps JSON
  as LONGTEXT with a json_valid CHECK, so describe must read that CHECK or
  status reports every json column as different), and setup's local install
  uses only SQL MySQL accepts.
*/
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import SQLWorker from '../lib/SQLWorker.js';

function workerWithVersion(sqlVersion) {
  const sql = new SQLWorker({ accountId: 't', knex: { sqlVersion, raw: async () => [[]] } });
  const queries = [];
  sql.query = async (opts) => {
    const text = typeof opts === 'string' ? opts : opts.sql;
    queries.push(text);
    if (text.includes('information_schema.columns')) {
      return {
        data: [
          { DB: 'd', COLUMN_NAME: 'definition', COLUMN_TYPE: 'longtext', DATA_TYPE: 'longtext', IS_NULLABLE: 'YES', COLUMN_DEFAULT: 'NULL', CHARACTER_MAXIMUM_LENGTH: 4294967295, EXTRA: '' }
        ]
      };
    }
    if (text.includes('information_schema.check_constraints')) {
      return { data: [{ CONSTRAINT_NAME: 'definition', CHECK_CLAUSE: 'json_valid(`definition`)' }] };
    }
    throw new Error(`unexpected describe query: ${text}`);
  };
  return { sql, queries };
}

describe('SQLWorker.describe on MySQL and MariaDB', () => {
  it('MariaDB: a LONGTEXT column with a json_valid CHECK is json', async () => {
    const { sql } = workerWithVersion('11.8.2-MariaDB');
    const { columns } = await sql.describe({ table: 'segment' });
    assert.equal(columns[0].column_type, 'json');
  });

  it('MySQL 8 never asks check_constraints (it has no LEVEL or TABLE_NAME)', async () => {
    const { sql, queries } = workerWithVersion('8.0.42');
    const { columns } = await sql.describe({ table: 'segment' });
    assert.equal(queries.some((q) => q.includes('check_constraints')), false);
    assert.equal(columns[0].type, 'string', 'a real LONGTEXT on MySQL stays a string');
  });
});

describe('setup on MySQL', () => {
  it('the local install writes no SQLite-only SQL (INSERT OR IGNORE)', () => {
    const source = readFileSync(new URL('../bin/setup.js', import.meta.url), 'utf8');
    const install = source.slice(source.indexOf('async function installDefaultSchema'), source.indexOf('async function installLocalDatabase'));
    assert.ok(install.length > 0);
    assert.doesNotMatch(install, /OR IGNORE/i);
  });
});
