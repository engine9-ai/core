import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  removeLegacySchemaFile,
  setup,
} from '../bin/setup.js';
import { cliAccount } from '../bin/cliAccount.js';
import { getPluginUUID } from '../lib/utilities.js';

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
      { name: 'kept', vars: { OTHER: '1', E9_PLUGIN_ID: 'pinned-plugin-id' } },
      {
        name: 'my-site',
        databaseName: 'engine9',
        databaseId: DB_ID,
        accountId: 'my-site',
        domain: 'www.example.com',
      }
    );
    assert.equal(cfg.name, 'kept');
    assert.equal(cfg.d1_databases[0].database_id, DB_ID);
    assert.equal(cfg.vars.OTHER, '1');
    assert.equal(cfg.vars.E9_ACCOUNT_ID, 'my-site');
    // Deprecated, but an existing value is kept: the site's rows depend on it.
    assert.equal(cfg.vars.E9_PLUGIN_ID, 'pinned-plugin-id');
    assert.equal(cfg.routes[0].pattern, 'www.example.com');
    assert.ok(cfg.compatibility_flags.includes('nodejs_compat'));
  });

  it('never adds E9_PLUGIN_ID to a new project', () => {
    const cfg = mergeWranglerConfig({}, { name: 'new-site', databaseName: 'engine9', databaseId: DB_ID, accountId: 'new-site' });
    assert.equal('E9_PLUGIN_ID' in cfg.vars, false);
  });

  it('writes the Worker aliases and has wrangler build the plugin registry', () => {
    const base = { name: 'my-site', databaseName: 'engine9', databaseId: DB_ID, accountId: 'a' };
    const plain = mergeWranglerConfig({}, base);
    assert.equal(plain.alias['@engine9/input-tools'], '@engine9/core/cloudflare/input-tools-shim');
    assert.equal(plain.alias.knex, '@engine9/core/cloudflare/unavailable-module');
    assert.equal(plain.alias['i18n-iso-countries'], 'i18n-iso-countries/index.js');
    assert.equal(plain.alias['@engine9/core/plugins/site'], './engine9.plugins.js');
    assert.equal(plain.build.command, 'npx e9core build-plugins');
    const astro = mergeWranglerConfig({ build: { command: 'npm run build', watch_dir: 'src' } }, base);
    assert.equal(astro.build.command, 'npx e9core build-plugins && npm run build');
    assert.equal(astro.build.watch_dir, 'src');
    assert.equal(mergeWranglerConfig(astro, base).build.command, 'npx e9core build-plugins && npm run build');
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

  it('loads production tables on a later --remote run from a fresh build it does not keep', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-remote-'));
    try {
      mkdirSync(path.join(cwd, '.e9core'), { recursive: true });
      writeFileSync(path.join(cwd, '.e9core', 'setup.json'), `${JSON.stringify({ schemaLocal: true })}\n`);
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: DB_ID }]
      })}\n`);
      const calls = [];
      let loaded = '';
      const result = await setup({
        cwd,
        remote: true,
        deploy: false,
        skipKeys: true,
        exec(args) {
          calls.push(args.join(' '));
          if (args.includes('--file')) loaded = args[args.indexOf('--file') + 1];
          return { status: 0, stdout: '' };
        }
      });
      assert.ok(calls.some((line) => line.includes('d1 execute engine9 --remote')));
      assert.ok(loaded && !loaded.startsWith(cwd), 'the SQL file is built outside the project');
      assert.ok(!existsSync(loaded), 'and deleted after the load');
      assert.deepEqual(readdirSync(path.join(cwd, '.e9core')), ['setup.json']);
      assert.ok(!existsSync(path.join(cwd, 'engine9.db')), 'a remote-only run does not touch the local database');
      assert.match(result.notes.join('\n'), /Loaded \d+ tables into production D1: .*\bapi_key\b.*\bplugin\b/);
      assert.ok(!calls.some((line) => line.includes('d1 create')));
      assert.ok(calls.some((line) => line.includes("--json --command SELECT name FROM sqlite_master")), 'it asks the target which tables exist');
      const state = JSON.parse(readFileSync(path.join(cwd, '.e9core', 'setup.json'), 'utf8'));
      assert.equal(state.schemaRemote, undefined, 'nothing about the target is kept on this machine');
      assert.equal(state.schemaLocal, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('loads the plugins package.json "engine9.install" names after the required plugins', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-install-'));
    try {
      writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'site', engine9: { install: ['@engine9/schemas/editions/contact'] } }));
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: DB_ID }]
      })}\n`);
      let sql = '';
      const result = await setup({
        cwd,
        remote: true,
        deploy: false,
        skipKeys: true,
        exec(args) {
          if (args.includes('--file')) sql = readFileSync(args[args.indexOf('--file') + 1], 'utf8');
          return { status: 0, stdout: '' };
        }
      });
      for (const table of ['plugin', 'person', 'person_email', 'person_name', 'timeline']) {
        assert.match(sql, new RegExp(`CREATE TABLE "?${table}"? `), `${table} is loaded`);
      }
      assert.match(result.notes.join('\n'), /and @engine9\/schemas\/editions\/contact \(package\.json "engine9\.install"\)/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--remote on a fresh runner loads nothing into a D1 database that already has the tables', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-rerun-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({
        name: 'folio',
        vars: { E9_ACCOUNT_ID: 'folio' },
        d1_databases: [{ binding: 'DB', database_name: 'folio-control', database_id: DB_ID }]
      })}\n`);
      const calls = [];
      const result = await setup({
        cwd,
        remote: true,
        deploy: false,
        skipKeys: true,
        exec(args) {
          calls.push(args.join(' '));
          if (args.join(' ').includes('sqlite_master')) return { status: 0, stdout: JSON.stringify([{ results: [{ name: 'plugin' }, { name: 'api_key' }], success: true }]) };
          return { status: 0, stdout: '' };
        }
      });
      assert.ok(!calls.some((line) => line.includes('--file')), 'no schema load');
      assert.ok(!calls.some((line) => line.includes('--local')), 'no local D1');
      assert.ok(calls.every((line) => !line.includes(' engine9 ')), 'the database name comes from wrangler.jsonc');
      assert.ok(calls.some((line) => line.includes('d1 execute folio-control --remote')));
      assert.ok(!existsSync(path.join(cwd, 'engine9.db')));
      assert.ok(!existsSync(path.join(cwd, '.env')));
      assert.match(result.notes.join('\n'), /already has engine9 tables; loaded nothing/);
      const cfg = JSON.parse(readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8'));
      assert.equal(cfg.d1_databases[0].database_name, 'folio-control', 'the binding keeps its database');
      assert.equal(cfg.vars.E9_ACCOUNT_ID, 'folio');
      assert.equal(result.pluginId, getPluginUUID('folio', 'website'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a new project without --name takes its account from the Worker name in wrangler.jsonc', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-name-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({ name: 'folio' })}\n`);
      const result = await setup({
        cwd,
        skipInstall: true,
        skipKeys: true,
        exec(args) {
          if (args.includes('create')) return { status: 0, stdout: `database_id = "${DB_ID}"\n` };
          return { status: 0, stdout: '' };
        }
      });
      const cfg = JSON.parse(readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8'));
      assert.equal(cfg.vars.E9_ACCOUNT_ID, 'folio');
      assert.equal(result.pluginId, getPluginUUID('folio', 'website'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('stops when it cannot read the target tables, rather than loading over them', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-unreadable-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: DB_ID }] })}\n`);
      const calls = [];
      await assert.rejects(
        setup({
          cwd,
          remote: true,
          deploy: false,
          skipKeys: true,
          exec(args) {
            calls.push(args.join(' '));
            if (args.join(' ').includes('sqlite_master')) return { status: 1, stderr: 'Authentication error [code: 10000]' };
            return { status: 0, stdout: '' };
          }
        }),
        /Authentication error/
      );
      assert.ok(!calls.some((line) => line.includes('--file')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('setup keeps the account a project already has', () => {
  const run = (cwd, options = {}) => setup({
    cwd,
    skipInstall: true,
    skipKeys: true,
    exec: () => ({ status: 0, stdout: `database_id = "${DB_ID}"\n` }),
    ...options
  });
  const readCfg = (cwd) => JSON.parse(readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8'));

  it('a rerun without --name (the wizard) keeps E9_ACCOUNT_ID', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-rerun-'));
    try {
      await run(cwd, { name: 'festival' });
      const again = await run(cwd);
      assert.equal(readCfg(cwd).vars.E9_ACCOUNT_ID, 'festival');
      assert.equal(again.pluginId, getPluginUUID('festival', 'website'));
      await run(cwd, { name: 'other' });
      assert.equal(readCfg(cwd).vars.E9_ACCOUNT_ID, 'festival', '--name does not replace it either');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a project on D1 with no E9_ACCOUNT_ID stays on the Worker default', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-default-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({
        name: 'old-site',
        d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: DB_ID }]
      })}\n`);
      const result = await run(cwd);
      assert.equal('E9_ACCOUNT_ID' in readCfg(cwd).vars, false);
      assert.equal(result.pluginId, getPluginUUID('cloudflare', 'website'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('derives the website id from E9_ACCOUNT_HANDLE', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-handle-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), `${JSON.stringify({
        vars: { E9_ACCOUNT_ID: 'renamed', E9_ACCOUNT_HANDLE: 'original' },
        d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: DB_ID }]
      })}\n`);
      const result = await run(cwd);
      assert.equal(result.pluginId, getPluginUUID('original', 'website'));
      assert.equal(readCfg(cwd).vars.E9_ACCOUNT_ID, 'renamed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('cliAccount', () => {
  it('reads flags, then the environment, then .env, then the fallback', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-cli-account-'));
    try {
      assert.deepEqual(cliAccount({}, { cwd, env: {}, fallback: 'client' }), {
        accountId: 'client', accountHandle: 'client', configured: false
      });
      writeFileSync(path.join(cwd, '.env'), 'E9_ACCOUNT_ID=from-dotenv\n');
      assert.equal(cliAccount({}, { cwd, env: {} }).accountId, 'from-dotenv');
      assert.equal(cliAccount({}, { cwd, env: {} }).accountHandle, 'from-dotenv');
      assert.equal(cliAccount({}, { cwd, env: { E9_ACCOUNT_ID: 'from-env' } }).accountId, 'from-env');
      const flagged = cliAccount({ account: 'a', handle: 'h' }, { cwd, env: { E9_ACCOUNT_ID: 'from-env' } });
      assert.deepEqual(flagged, { accountId: 'a', accountHandle: 'h', configured: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('removeLegacySchemaFile', () => {
  it('deletes a generated schema from wrangler migrations and leaves other files alone', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-legacy-'));
    try {
      mkdirSync(path.join(cwd, 'migrations'), { recursive: true });
      writeFileSync(path.join(cwd, 'migrations', '0001_engine9.sql'), '-- generated by e9core setup\nCREATE TABLE api_key (id TEXT);\n');
      writeFileSync(path.join(cwd, 'migrations', '0002_site.sql'), 'CREATE TABLE acme_page (id TEXT);\n');
      assert.match(removeLegacySchemaFile(cwd), /Deleted migrations\/0001_engine9\.sql/);
      assert.ok(!existsSync(path.join(cwd, 'migrations', '0001_engine9.sql')));
      assert.ok(!existsSync(path.join(cwd, '.e9core')));
      assert.ok(existsSync(path.join(cwd, 'migrations', '0002_site.sql')));
      assert.equal(removeLegacySchemaFile(cwd), '');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('only warns about a file it did not generate', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-legacy-'));
    try {
      mkdirSync(path.join(cwd, 'migrations'), { recursive: true });
      writeFileSync(path.join(cwd, 'migrations', '0001_engine9.sql'), 'CREATE TABLE api_key (id TEXT);\n');
      assert.match(removeLegacySchemaFile(cwd), /never load it with wrangler d1 migrations apply/);
      assert.ok(existsSync(path.join(cwd, 'migrations', '0001_engine9.sql')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
