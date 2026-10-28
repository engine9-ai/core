import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import PersonWorker from '../lib/PersonWorker.js';
import { createSchemaSnapshot } from '../lib/sql/schemaSnapshot.js';
import { composePluginRegistries, createPluginRegistry, getDefaultPluginRegistry } from '../lib/pluginRegistry.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { ConsoleLogger } from '../logging/index.js';
import { getPluginUUID, getVersionedUUID } from '../lib/utilities.js';
import { renderStatus, runStatusCommand } from '../bin/status.js';
import { ensurePluginRow } from './helpers/applySchemas.js';

const memory = (opts = {}) => new PersonWorker({ accountId: 'status', auth: { database_connection: 'sqlite://:memory:' }, ...opts });
const byId = (report, id, plugin) => report.checks.filter((c) => c.id === id && (!plugin || c.plugin === plugin));
const bad = (report) => report.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => `${c.id} ${c.plugin || ''}`.trim());

/* A third-party plugin outside @engine9/schemas, with its own status hook. */
function acmeRegistry({ version = '1.0.0', columns = { id: 'id_uuid', title: 'string' }, status } = {}) {
  return composePluginRegistries(
    getDefaultPluginRegistry(),
    createPluginRegistry(
      {
        '@acme/plugins/blog': {
          index: {
            default: {
              metadata: { name: 'Blog', unique: true },
              schema: { tables: [{ name: 'acme_blog_post', columns, indexes: [{ columns: 'id', primary: true }] }] },
              ...(status ? { status } : {})
            }
          }
        }
      },
      { packageVersions: { '@acme/plugins': version } }
    )
  );
}

test('a freshly installed stack reports no failures and no warnings, in a few queries', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins({ path: '@engine9/schemas/stacks/standard' });
    let queries = 0;
    const query = worker.query.bind(worker);
    worker.query = (...args) => {
      queries += 1;
      return query(...args);
    };
    const snapshot = await createSchemaSnapshot(worker);
    assert.equal(snapshot.batched, true);
    assert.equal(queries, 3, 'the whole schema in three queries');
    const report = await worker.status();
    assert.equal(report.ok, true);
    assert.deepEqual(bad(report), []);
    assert.ok(byId(report, 'plugin.last_install').every((c) => c.data.status === 'ok' && c.data.trigger === 'install_default'));
  } finally {
    await worker.destroy();
  }
});

test('the batched snapshot and the per-table fallback diff the same', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins();
    await worker.query('alter table person_email drop column created_at').catch(() => {});
    const batched = await createSchemaSnapshot(worker);
    const query = worker.query.bind(worker);
    worker.query = (q, ...rest) => {
      if (/pragma_table_info/.test(typeof q === 'string' ? q : q.sql)) throw new Error('no such function: pragma_table_info');
      return query(q, ...rest);
    };
    const fallback = await createSchemaSnapshot(worker);
    assert.equal(fallback.batched, false);
    const schema = (await worker.compilePlugin({ path: '@engine9/schemas/person_email' })).schema;
    assert.deepEqual(await worker.diff({ schema, snapshot: fallback }), await worker.diff({ schema, snapshot: batched }));
  } finally {
    await worker.destroy();
  }
});

test('status finds what a failed deploy leaves behind', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins({ path: '@engine9/schemas/stacks/standard' });
    await worker.query('drop table person_phone');
    await worker.query('alter table person_address drop column created_at').catch(() => {});
    await worker.query('drop trigger person_email_modified_at_auto_update');
    await worker.query("update plugin set transforms=null where path='@engine9/schemas/person_email'");
    await ensurePluginRow(worker, { path: '@acme/plugins/gone', name: 'gone' });
    const nameRow = (await worker.list()).find((r) => r.path === '@engine9/schemas/person_name');
    await worker.query({
      sql: "update plugin set last_install_at='2026-10-20 14:02:00', last_install_status='failed', last_install=? where id=?",
      values: [JSON.stringify({ step: 'schema', trigger: 'upgrade', error: 'Cannot add a column with non-constant default' }), nameRow.id]
    });
    const remote = (await worker.list()).find((r) => r.path === '@engine9/schemas/person_remote');
    await worker.query({
      sql: "update plugin set last_install_status='ok', last_install=? where id=?",
      values: [JSON.stringify({ schema_hash: 'older', version: '0.0.1' }), remote.id]
    });

    const report = await worker.status({ fixTarget: '--url https://www.example.com' });
    assert.equal(report.ok, false);
    const [missing] = byId(report, 'plugin.schema', '@engine9/schemas/person_phone');
    assert.equal(missing.status, 'fail');
    assert.match(missing.title, /table person_phone is missing/);
    assert.equal(missing.fix, 'npx e9core upgrade --url https://www.example.com');
    assert.equal(byId(report, 'plugin.schema', '@engine9/schemas/person_address')[0].status, 'fail');
    assert.deepEqual(byId(report, 'core.triggers')[0].data.tables, ['person_email']);
    assert.equal(byId(report, 'plugin.inbound_snapshot', '@engine9/schemas/person_email')[0].status, 'warn');
    const [code] = byId(report, 'plugin.code_present', '@acme/plugins/gone');
    assert.equal(code.status, 'fail');
    assert.match(code.fix, /engine9\.pluginPackages/);
    const [failed] = byId(report, 'plugin.last_install', '@engine9/schemas/person_name');
    assert.equal(failed.status, 'fail');
    assert.match(failed.detail, /non-constant default/);
    assert.match(failed.fix, /^npx e9core upgrade --plugin @engine9\/schemas\/person_name --url https:\/\/www\.example\.com/);
    const [changed] = byId(report, 'plugin.code_changed', '@engine9/schemas/person_remote');
    assert.equal(changed.status, 'warn');
    assert.match(changed.detail, /schema changed/);

    const only = await worker.status({ plugins: ['@engine9/schemas/person_phone', '@engine9/schemas/nope'] });
    assert.deepEqual([...new Set(only.checks.filter((c) => c.area === 'plugins').map((c) => c.plugin))].sort(), [
      '@engine9/schemas/nope',
      '@engine9/schemas/person_phone'
    ]);
    assert.match(renderStatus({ ...report, sources: ['database'] }), /✖ @engine9\/schemas\/person_phone: table person_phone is missing/);
  } finally {
    await worker.destroy();
  }
});

test('site keys are checked by hash: missing, turned off, active', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins();
    const store = new SqlApiKeyStore({ worker });
    await store.deploy();
    const { key: active } = await store.create({ name: 'site-public', scopes: ['public'] });
    const { key: off, id: offId } = await store.create({ name: 'site-admin', scopes: ['admin'] });
    await store.revoke({ id: offId });
    const report = await worker.status({
      keys: {
        public: { value: active, source: '.env' },
        admin: { value: off, source: '.env.production' },
        other: { value: 'e9publickey_nowhere', source: 'page' }
      }
    });
    assert.equal(byId(report, 'keys.public')[0].status, 'pass');
    assert.match(byId(report, 'keys.admin')[0].title, /turned off/);
    assert.match(byId(report, 'keys.other')[0].title, /has no row in api_key/);
    assert.ok(!JSON.stringify(report).includes(active), 'a key never appears in the report');
  } finally {
    await worker.destroy();
  }
});

test('a plugin outside @engine9/schemas: upgrade leaves it, status says so, upgrade --plugin applies it', async () => {
  const worker = memory({ plugins: acmeRegistry() });
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: '@acme/plugins/blog' });
    worker.plugins = acmeRegistry({ version: '1.1.0', columns: { id: 'id_uuid', title: 'string', body: 'text' } });

    const refreshed = await worker.upgrade();
    assert.ok(!refreshed.refresh.plugins.includes('@acme/plugins/blog'), 'upgrade refreshes the main package only');
    const report = await worker.status({ fixTarget: '--db x' });
    const [schema] = byId(report, 'plugin.schema', '@acme/plugins/blog');
    assert.equal(schema.status, 'fail');
    assert.match(schema.title, /acme_blog_post\.body is missing/);
    assert.equal(schema.fix, 'npx e9core upgrade --plugin @acme/plugins/blog --db x');
    assert.match(byId(report, 'plugin.code_changed', '@acme/plugins/blog')[0].detail, /1\.1\.0, installed from 1\.0\.0/);

    const dry = await worker.upgrade({ plugins: ['@acme/plugins/blog'], dry_run: true, sql: true });
    assert.equal(dry.plugins[0].status, 'pending');
    assert.deepEqual(dry.plugins[0].sql, ['alter table "acme_blog_post" add column "body" text']);
    assert.ok(!(await worker.describe({ table: 'acme_blog_post' })).columns.some((c) => c.name === 'body'), 'dry run changes nothing');

    const applied = await worker.upgrade({ plugins: '@acme/plugins/blog' });
    assert.equal(applied.ok, true);
    assert.equal(applied.plugins[0].before.length, 1);
    assert.deepEqual(applied.plugins[0].after, []);
    assert.deepEqual(bad(await worker.status({ plugins: ['@acme/plugins/blog'] })), []);

    const missing = await worker.upgrade({ plugins: ['@acme/plugins/none'] });
    assert.equal(missing.ok, false);
    assert.equal(missing.plugins[0].status, 'not_installed');
  } finally {
    await worker.destroy();
  }
});

test('a failed install is recorded, audited, and retried with upgrade --failed', async () => {
  const audited = [];
  const worker = memory({ audit: { log: async (r) => audited.push(r), flush: async () => {} } });
  try {
    await worker.installDefaultPlugins();
    const deploy = worker.deploy.bind(worker);
    worker.deploy = async () => {
      throw new Error('D1_ERROR: no');
    };
    const result = await worker.upgrade({ plugins: ['@engine9/schemas/person_email'] });
    worker.deploy = deploy;
    assert.equal(result.plugins[0].status, 'failed');
    assert.equal(result.plugins[0].step, 'schema');
    const failure = audited.find((r) => r.action === 'plugin.install' && r.meta.status === 'failed');
    assert.equal(failure.meta.path, '@engine9/schemas/person_email');
    assert.equal(failure.meta.trigger, 'upgrade_plugin');
    assert.match(failure.meta.error, /D1_ERROR/);
    assert.equal(byId(await worker.status(), 'plugin.last_install', '@engine9/schemas/person_email')[0].status, 'fail');

    const retried = await worker.upgrade({ failed: true });
    assert.deepEqual(retried.plugins.map((p) => [p.path, p.status]), [['@engine9/schemas/person_email', 'ok']]);
    assert.equal(byId(await worker.status(), 'plugin.last_install', '@engine9/schemas/person_email')[0].status, 'pass');
    const email = (await worker.list({ fields: '*' })).find((r) => r.path === '@engine9/schemas/person_email');
    assert.equal(email.last_install_status, 'ok');
    assert.equal(JSON.parse(email.last_install).trigger, 'upgrade_plugin');
    assert.deepEqual(await worker.getSettings({ pluginId: email.id }), {});
  } finally {
    await worker.destroy();
  }
});

test('a plugin table without the last_install columns: installs skip the record, upgrade adds the columns', async () => {
  const worker = memory();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await worker.installDefaultPlugins();
    for (const c of ['last_install', 'last_install_status', 'last_install_at']) await worker.query(`alter table plugin drop column ${c}`);
    await worker.install({ path: '@engine9/schemas/person_email' });
    assert.deepEqual(warnings, []);
    assert.deepEqual(byId(await worker.status(), 'plugin.last_install'), []);
    assert.deepEqual(await worker.upgrade({ failed: true }), { ok: true, dry_run: false, mode: 'plugins', plugins: [] });
    assert.equal(byId(await worker.status(), 'plugin.schema', '@engine9/schemas/plugin')[0].status, 'fail');

    await worker.upgrade({});
    const rows = await worker.list({ fields: '*' });
    assert.equal(rows.find((r) => r.path === '@engine9/schemas/person_email').last_install_status, 'ok');
    assert.equal(byId(await worker.status(), 'plugin.schema', '@engine9/schemas/plugin')[0].status, 'pass');
  } finally {
    console.warn = warn;
    await worker.destroy();
  }
});

test("a plugin's status hook adds checks; a hook that throws is a failure, not a crash", async () => {
  const worker = memory({
    plugins: acmeRegistry({
      status: async ({ plugin }) => [{ id: 'webhook', status: 'warn', title: `no webhook for ${plugin.path}`, fix: 'Register it' }]
    })
  });
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: '@acme/plugins/blog' });
    const [hook] = byId(await worker.status(), 'plugin.custom.webhook');
    assert.equal(hook.status, 'warn');
    assert.equal(hook.title, 'no webhook for @acme/plugins/blog');
    worker.plugins = acmeRegistry({
      status: () => {
        throw new Error('remote API down');
      }
    });
    const [error] = byId(await worker.status(), 'plugin.custom.error');
    assert.equal(error.status, 'fail');
    assert.match(error.detail, /remote API down/);
  } finally {
    await worker.destroy();
  }
});

test('GET /admin/status: admin only, checks the secrets by hash, warns without an audit sink', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins();
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: adminKey } = await keyStore.create({ name: 'site-admin', scopes: ['admin'] });
    const { key: publicKey } = await keyStore.create({ name: 'site-public', scopes: ['public'] });
    const api = createApi({
      worker,
      keyStore,
      environment: { E9_ADMIN_API_KEY: adminKey, E9_PUBLIC_API_KEY: 'e9publickey_lost_from_the_database' },
      config: {}
    });
    assert.ok(worker.audit instanceof ConsoleLogger, 'with no audit sink the worker audits to the console');
    const denied = await api.handle({ method: 'GET', path: '/admin/status', headers: { authorization: `Bearer ${publicKey}` } });
    assert.equal(denied.status, 403);
    const res = await api.handle({
      method: 'GET',
      path: '/admin/status',
      headers: { authorization: `Bearer ${adminKey}` },
      apiBase: 'https://www.example.com/api'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(byId(res.body, 'keys.admin')[0].status, 'pass');
    const [lost] = byId(res.body, 'keys.public');
    assert.equal(lost.status, 'fail');
    assert.equal(lost.data.source, 'E9_PUBLIC_API_KEY secret');
    assert.equal(byId(res.body, 'secrets.SESSION_SECRET')[0].status, 'warn');
    assert.equal(byId(res.body, 'audit.configured')[0].status, 'warn');
    assert.ok(!JSON.stringify(res.body).includes(adminKey));
  } finally {
    await worker.destroy();
  }
});

test('role grants go to the audit log; other segment changes go to the data log', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins();
    const pluginId = getPluginUUID('status', 'website');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: adminKey } = await keyStore.create({ name: 'site-admin', scopes: ['admin'] });
    const logged = [];
    const audited = [];
    const api = createApi({
      worker,
      keyStore,
      logger: { log: async (e) => logged.push(e), flush: async () => {} },
      audit: { log: async (e) => audited.push(e), flush: async () => {} },
      config: { pluginId, roles: 'standard' }
    });
    const add = (segment) =>
      api.handle({
        method: 'POST',
        path: '/auth/segments',
        headers: { authorization: `Bearer ${adminKey}` },
        body: { add: [{ segment_id: segment, email: 'ada@example.com' }] }
      });
    const granted = await add('admin');
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    const grant = audited.find((e) => e.action === 'role.grant');
    assert.equal(grant.meta.changes[0].email, 'ada@example.com');
    assert.equal(grant.meta.changes[0].role, 'admin');
    assert.ok(!logged.some((e) => e.action === 'segment.membership'), 'a role grant is not in the data log');

    const members = getVersionedUUID();
    await worker.insertArray({ table: 'segment', array: [{ id: members, plugin_id: pluginId, name: 'Members', build_type: 'list' }] });
    const joined = await add(members);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(logged.filter((e) => e.action === 'segment.membership').length, 1);
    assert.equal(audited.filter((e) => e.action === 'role.grant').length, 1, 'an ordinary segment is not a role grant');
  } finally {
    await worker.destroy();
  }
});

/* ---------------------------------------------------- e9core status CLI */

function fakeWrangler(dbFile, { accounts = ['a'.repeat(32), 'b'.repeat(32)], secrets = ['E9_ADMIN_API_KEY', 'E9_PUBLIC_API_KEY', 'SESSION_SECRET', 'E9_SETUP_TOKEN'] } = {}) {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    const [, cmd, sub] = args;
    if (cmd === 'whoami') return { status: 0, stdout: accounts.map((id, i) => `│ Account ${i} │ ${id} │`).join('\n') };
    if (cmd === 'd1' && sub === 'info') return { status: 0, stdout: '{}' };
    if (cmd === 'secret') return { status: 0, stdout: JSON.stringify(secrets.map((name) => ({ name, type: 'secret_text' }))) };
    const db = new DatabaseSync(dbFile);
    try {
      if (cmd === 'd1' && sub === 'export') {
        const out = args[args.indexOf('--output') + 1];
        const sql = db.prepare("select sql from sqlite_master where sql is not null and name not like 'sqlite_%'").all().map((r) => `${r.sql};`).join('\n');
        writeFileSync(out, sql);
        return { status: 0, stdout: '' };
      }
      if (cmd === 'd1' && sub === 'execute') {
        const command = args[args.indexOf('--command') + 1];
        return { status: 0, stdout: JSON.stringify(command.split('; ').map((sql) => ({ results: db.prepare(sql).all(), success: true }))) };
      }
    } finally {
      db.close();
    }
    return { status: 1, stderr: `unexpected ${args.join(' ')}` };
  };
  return { exec, calls };
}

test('e9core status in a Cloudflare project: account, secrets, legacy file, and a D1 copy when the site refuses the admin key', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-status-cli-'));
  const dbFile = path.join(cwd, 'remote.db');
  const worker = new PersonWorker({ accountId: 'site', auth: { database_connection: `sqlite://${dbFile}` } });
  try {
    await worker.installDefaultPlugins();
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: publicKey, id: publicId } = await keyStore.create({ name: 'site-public', scopes: ['public'] });
    await worker.query({ sql: 'delete from api_key where id=?', values: [publicId] });
    await worker.query('drop table person_phone');
    writeFileSync(path.join(cwd, 'wrangler.jsonc'), JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'engine9', database_id: 'x' }] }));
    writeFileSync(path.join(cwd, '.env'), `E9_PUBLIC_API_KEY=${publicKey}\n`);
    writeFileSync(path.join(cwd, '.env.production'), 'E9_ADMIN_API_KEY=e9key_not_in_the_database\n');
    mkdirSync(path.join(cwd, 'migrations'));
    writeFileSync(path.join(cwd, 'migrations', '0001_engine9.sql'), '-- generated by e9core setup\n');

    const api = createApi({ worker, keyStore, config: {} });
    const fetchImpl = (url, init) => api.handleFetch(new Request(url, init));
    const { exec, calls } = fakeWrangler(dbFile);
    const report = await runStatusCommand({ url: 'https://www.example.com' }, { cwd, exec, fetchImpl });

    assert.equal(report.ok, false);
    assert.match(byId(report, 'keys.admin_live')[0].title, /refuses the admin key \(unknown_key\)/);
    assert.match(byId(report, 'keys.live_public')[0].title, /refuses the public key from \.env \(unknown_key\)/);
    assert.equal(byId(report, 'account.pinned')[0].status, 'warn');
    assert.equal(byId(report, 'account.owns_database')[0].status, 'pass');
    assert.equal(byId(report, 'secrets.E9_SETUP_TOKEN')[0].status, 'warn');
    assert.equal(byId(report, 'schema_file.legacy')[0].status, 'warn');
    assert.equal(byId(report, 'database.copy')[0].status, 'pass');
    assert.match(byId(report, 'keys.public')[0].title, /has no row in api_key/);
    assert.match(byId(report, 'keys.admin')[0].title, /has no row in api_key/);
    assert.equal(byId(report, 'plugin.schema', '@engine9/schemas/person_phone')[0].status, 'fail');
    assert.equal(byId(report, 'upgrades.none')[0].status, 'pass', 'a schema-only copy still runs shouldUpgrade');
    assert.equal(byId(report, 'upgrades.window')[0].status, 'pass');
    assert.ok(calls.some((c) => c.includes('d1 export engine9 --remote --no-data')));
    assert.ok(!calls.some((c) => /select \* from setting|select value from setting/.test(c)), 'plugin setting values stay in D1');
    const text = renderStatus(report);
    assert.match(text, /engine9 status: site https:\/\/www\.example\.com \+ wrangler/);
  } finally {
    await worker.destroy();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('e9core status --url uses the site report when the admin key works, and skips the D1 copy', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-status-cli-'));
  const worker = memory();
  try {
    await worker.installDefaultPlugins();
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const { key: adminKey } = await keyStore.create({ name: 'site-admin', scopes: ['admin'] });
    const { key: publicKey } = await keyStore.create({ name: 'site-public', scopes: ['public'] });
    writeFileSync(path.join(cwd, '.env'), `E9_PUBLIC_API_KEY=${publicKey}\n`);
    const api = createApi({ worker, keyStore, environment: { E9_ADMIN_API_KEY: adminKey, E9_PUBLIC_API_KEY: publicKey }, config: {} });
    const fetchImpl = (url, init) => api.handleFetch(new Request(url, init));
    const report = await runStatusCommand({ url: 'https://www.example.com', key: adminKey }, { cwd, fetchImpl, exec: () => assert.fail('no wrangler.jsonc here') });
    assert.deepEqual(report.sources, ['site https://www.example.com']);
    assert.equal(byId(report, 'keys.live_public')[0].status, 'pass');
    assert.equal(byId(report, 'keys.public')[0].status, 'pass');
    assert.equal(report.summary.fail, 0, JSON.stringify(report.checks.filter((c) => c.status === 'fail')));
  } finally {
    await worker.destroy();
    rmSync(cwd, { recursive: true, force: true });
  }
});
