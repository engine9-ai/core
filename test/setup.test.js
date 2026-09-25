import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dumpSqliteFile,
  findDatabaseId,
  mergeWranglerConfig,
  parseDatabaseId,
  setup,
} from '../bin/setup.js';

const DB_ID = '11111111-1111-4111-8111-111111111111';

describe('parseDatabaseId', () => {
  it('reads the id wrangler prints', () => {
    const text = `database_name = "engine9"\ndatabase_id = "${DB_ID}"\n`;
    assert.equal(parseDatabaseId(text), DB_ID);
  });
});

describe('findDatabaseId', () => {
  it('finds a database wrangler already created', () => {
    const text = JSON.stringify([{ name: 'engine9', uuid: DB_ID }]);
    assert.equal(findDatabaseId(text, 'engine9'), DB_ID);
  });
});

describe('mergeWranglerConfig', () => {
  it('fills the database id and does not drop an existing setting', () => {
    const cfg = mergeWranglerConfig(
      { name: 'kept', vars: { OTHER: '1' } },
      {
        name: 'my-site',
        databaseName: 'engine9',
        databaseId: DB_ID,
        accountId: 'my-site',
        pluginId: 'plugin-1',
        domain: 'www.example.com',
      }
    );
    assert.equal(cfg.name, 'kept');
    assert.equal(cfg.d1_databases[0].database_id, DB_ID);
    assert.equal(cfg.vars.OTHER, '1');
    assert.equal(cfg.vars.E9_PLUGIN_ID, 'plugin-1');
    assert.equal(cfg.routes[0].pattern, 'www.example.com');
    assert.ok(cfg.compatibility_flags.includes('nodejs_compat'));
  });

  it('writes the Worker aliases and points plugins/site at the site registry', () => {
    const base = { name: 'my-site', databaseName: 'engine9', databaseId: DB_ID, accountId: 'a', pluginId: 'p' };
    const plain = mergeWranglerConfig({}, base);
    assert.equal(plain.alias['@engine9/input-tools'], '@engine9/core/cloudflare/input-tools-shim');
    assert.equal(plain.alias.knex, '@engine9/core/cloudflare/unavailable-module');
    assert.equal(plain.alias['i18n-iso-countries'], 'i18n-iso-countries/index.js');
    assert.equal(plain.alias['@engine9/core/plugins/site'], undefined);
    const site = mergeWranglerConfig({}, { ...base, pluginsModule: './engine9.plugins.js' });
    assert.equal(site.alias['@engine9/core/plugins/site'], './engine9.plugins.js');
  });
});

describe('dumpSqliteFile', () => {
  it('writes create and insert statements without PRAGMA', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e9-dump-'));
    const file = path.join(dir, 't.sqlite');
    try {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE person (id INTEGER, given_name TEXT)");
      db.prepare('INSERT INTO person (id, given_name) VALUES (?, ?)').run(1, "O'Brien");
      db.close();
      const sql = dumpSqliteFile(file);
      assert.match(sql, /CREATE TABLE person/);
      assert.match(sql, /O''Brien/);
      assert.doesNotMatch(sql, /PRAGMA/);
      assert.doesNotMatch(sql, /BEGIN TRANSACTION/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setup', () => {
  it('writes wrangler.jsonc from the wrangler create output', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-site-'));
    try {
      const calls = [];
      const result = await setup({
        cwd,
        name: 'festival',
        skipInstall: true,
        skipKeys: true,
        exec(args) {
          calls.push(args.join(' '));
          if (args.includes('create')) {
            return { status: 0, stdout: `database_id = "${DB_ID}"\n` };
          }
          return { status: 0, stdout: '' };
        },
      });
      const cfg = JSON.parse(readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8'));
      assert.equal(cfg.d1_databases[0].database_id, DB_ID);
      assert.equal(cfg.name, 'festival');
      assert.match(result.notes.join('\n'), /wrangler\.jsonc/);
      assert.ok(calls.some((line) => line.includes('d1 create engine9')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('loads production tables on a later --remote run', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-remote-'));
    try {
      mkdirSync(path.join(cwd, '.e9core'), { recursive: true });
      mkdirSync(path.join(cwd, 'migrations'), { recursive: true });
      writeFileSync(path.join(cwd, '.e9core', 'setup.json'), `${JSON.stringify({ schemaLocal: true })}\n`);
      writeFileSync(path.join(cwd, 'migrations', '0001_engine9.sql'), '-- already built\n');
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: DB_ID }]
      })}\n`);
      const calls = [];
      await setup({
        cwd,
        remote: true,
        deploy: false,
        skipKeys: true,
        exec(args) {
          calls.push(args.join(' '));
          return { status: 0, stdout: '' };
        }
      });
      assert.ok(calls.some((line) => line.includes('d1 execute engine9 --remote')));
      assert.ok(!calls.some((line) => line.includes('d1 create')));
      const state = JSON.parse(readFileSync(path.join(cwd, '.e9core', 'setup.json'), 'utf8'));
      assert.equal(state.schemaRemote, true);
      assert.equal(state.schemaLocal, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
