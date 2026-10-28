/*
  Plugin-declared upgrades (lib/upgrades/declared.js, docs/plugin-upgrades.md):
  shouldUpgrade gates run, a plugin outside @engine9/schemas upgrades only
  when named, a plugin that only carries upgrades runs without a row, the
  upgrade windows (lib/upgrades/window.js), and that installs and requests
  never call the hooks.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { composePluginRegistries, createPluginRegistry, getDefaultPluginRegistry } from '../lib/pluginRegistry.js';
import { CORE_UPGRADE_FROM } from '../lib/version.js';

const BLOG = '@acme/plugins/blog';
const CLEANUP = '@acme/upgrades/cleanup';

const memory = (plugins) => new PersonWorker({ accountId: 'upgrades', auth: { database_connection: 'sqlite://:memory:' }, plugins });
const byId = (report, id, plugin) => report.checks.filter((c) => c.id === id && (!plugin || c.plugin === plugin));

function registry({ version = '1.0.0', upgrades, upgradeFrom, cleanup } = {}) {
  return composePluginRegistries(
    getDefaultPluginRegistry(),
    createPluginRegistry(
      {
        [BLOG]: {
          index: {
            default: {
              metadata: { name: 'Blog', unique: true },
              schema: { tables: [{ name: 'acme_blog_post', columns: { id: 'id_uuid', title: 'string' }, indexes: [{ columns: 'id', primary: true }] }] },
              ...(upgrades ? { upgrades } : {}),
              ...(upgradeFrom ? { upgradeFrom } : {})
            }
          }
        },
        ...(cleanup ? { [CLEANUP]: { index: { default: { metadata: { name: 'Cleanup', unique: true }, upgrades: cleanup } } } } : {})
      },
      { packageVersions: { '@acme/plugins': version, '@acme/upgrades': '1.0.0' } }
    )
  );
}

/* Trims leading spaces from blog titles. Counts its calls. */
function trimTitles(calls = { should: 0, run: 0 }) {
  return {
    calls,
    upgrade: {
      id: 'blog_title_trim',
      since: '1.1.0',
      description: 'Trim leading spaces from blog titles.',
      shouldUpgrade: ({ snapshot }) => {
        calls.should += 1;
        return snapshot.hasTable('acme_blog_post');
      },
      run: async ({ sqlWorker, dryRun }) => {
        calls.run += 1;
        const { data } = await sqlWorker.query("select count(*) as n from acme_blog_post where title like ' %'");
        const n = Number(data[0].n);
        const plan = n ? [`trim ${n} titles`] : [];
        if (dryRun || !n) return { pending: n > 0, changed: false, plan };
        await sqlWorker.query("update acme_blog_post set title=ltrim(title) where title like ' %'");
        return { pending: true, changed: true, plan, trimmed: n };
      }
    }
  };
}

const never = {
  id: 'never',
  description: 'Never applies.',
  shouldUpgrade: () => false,
  run: () => {
    throw new Error('run() must not be called when shouldUpgrade is false');
  }
};

async function post(worker, title) {
  await worker.query({ sql: 'insert into acme_blog_post (id, title) values (?, ?)', values: [crypto.randomUUID(), title] });
}

test('a plugin outside @engine9/schemas: shouldUpgrade gates run, status reports it, only upgrade --plugin runs it', async () => {
  const { calls, upgrade } = trimTitles();
  const worker = memory(registry({ upgrades: [upgrade, never] }));
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: BLOG });
    await post(worker, ' Hello');
    const pluginId = (await worker.list()).find((r) => r.path === BLOG).id;
    await worker.processPeople({ pluginId, inputType: 'api', remoteInputId: 'signup', batch: [{ email: 'ada@example.com' }] });
    assert.deepEqual(calls, { should: 0, run: 0 }, 'installs and loads never call upgrade hooks');

    const plain = await worker.upgrade();
    assert.equal(plain.ok, true);
    assert.ok(!plain.upgrades.some((u) => u.plugin === BLOG), 'upgrade runs only the main package');
    assert.deepEqual(calls, { should: 0, run: 0 });

    const report = await worker.status({ fixTarget: '--db x' });
    const [pending] = byId(report, 'upgrade.blog_title_trim', BLOG);
    assert.equal(pending.status, 'warn');
    assert.equal(pending.fix, `npx e9core upgrade --plugin ${BLOG} --db x`);
    assert.deepEqual(pending.data.plan, ['trim 1 titles']);
    assert.equal(byId(report, 'upgrade.never').length, 0, 'an upgrade that does not apply is not listed');
    assert.equal(byId(report, 'upgrades.none').length, 0);

    const dry = await worker.upgrade({ plugins: [BLOG], dry_run: true });
    assert.equal(dry.upgrades.find((u) => u.id === 'blog_title_trim').status, 'pending');
    assert.equal(dry.upgrades.find((u) => u.id === 'never').status, 'current');
    assert.equal((await worker.query('select title from acme_blog_post')).data[0].title, ' Hello', 'dry run changes nothing');

    const applied = await worker.upgrade({ plugins: BLOG });
    assert.equal(applied.ok, true);
    const step = applied.upgrades.find((u) => u.id === 'blog_title_trim');
    assert.equal(step.status, 'applied');
    assert.equal(step.trimmed, 1);
    assert.equal(step.plugin, BLOG);
    assert.equal(applied.plugins[0].status, 'ok', 'then the plugin is reinstalled');
    assert.equal((await worker.query('select title from acme_blog_post')).data[0].title, 'Hello');

    const after = await worker.status();
    assert.equal(byId(after, 'upgrade.blog_title_trim', BLOG)[0].status, 'pass');

    const runsBefore = calls.run;
    const copy = await worker.status({ upgrades: 'schema_only' });
    assert.equal(byId(copy, 'upgrade.blog_title_trim', BLOG)[0].status, 'warn', 'a schema-only copy can only say it applies');
    assert.equal(calls.run, runsBefore, 'schema_only never calls run()');
  } finally {
    await worker.destroy();
  }
});

test('a plugin that only carries upgrades for other plugins runs by name without a plugin row', async () => {
  const cleanup = [
    {
      id: 'blog_empty_titles',
      since: '1.0.0',
      description: 'Delete blog posts with no title.',
      shouldUpgrade: ({ snapshot }) => snapshot.hasTable('acme_blog_post'),
      run: async ({ sqlWorker, dryRun, plugin }) => {
        assert.deepEqual(plugin, { id: null, path: CLEANUP, tablePrefix: '', installed: false });
        const { data } = await sqlWorker.query("select count(*) as n from acme_blog_post where coalesce(title, '') = ''");
        const n = Number(data[0].n);
        if (dryRun || !n) return { pending: n > 0, changed: false, plan: n ? [`delete ${n} posts`] : [] };
        await sqlWorker.query("delete from acme_blog_post where coalesce(title, '') = ''");
        return { pending: true, changed: true, deleted: n };
      }
    }
  ];
  const worker = memory(registry({ cleanup }));
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: BLOG });
    await post(worker, '');
    await post(worker, 'Kept');

    const report = await worker.status({ plugins: [CLEANUP], fixTarget: '--db x' });
    assert.equal(byId(report, 'plugin.installed').length, 0, 'an upgrades-only plugin needs no row');
    const [pending] = byId(report, 'upgrade.blog_empty_titles', CLEANUP);
    assert.equal(pending.status, 'warn');
    assert.equal(pending.fix, `npx e9core upgrade --plugin ${CLEANUP} --db x`);

    assert.ok(!(await worker.upgrade()).upgrades.some((u) => u.plugin === CLEANUP), 'never run unless named');

    const result = await worker.upgrade({ plugins: [CLEANUP] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.plugins, [], 'nothing to reinstall');
    assert.equal(result.upgrades[0].deleted, 1);
    assert.deepEqual((await worker.query('select title from acme_blog_post')).data, [{ title: 'Kept' }]);
    assert.ok(!(await worker.list()).some((r) => r.path === CLEANUP), 'running it creates no plugin row');
  } finally {
    await worker.destroy();
  }
});

test('plugin upgrade window: a row installed from before upgradeFrom is refused until upgraded through it', async () => {
  const { calls, upgrade } = trimTitles();
  const worker = memory(registry({ version: '1.0.0' }));
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: BLOG });
    worker.plugins = registry({ version: '2.0.0', upgrades: [upgrade], upgradeFrom: '1.1.0' });

    const report = await worker.status();
    const [window] = byId(report, 'plugin.upgrade_window', BLOG);
    assert.equal(window.status, 'fail');
    assert.match(window.detail, /last installed from @acme\/plugins@1\.0\.0\. This build upgrades it from 1\.1\.0/);
    assert.match(window.fix, /^Upgrade with @acme\/plugins@1\.1\.0 first/);

    const refused = await worker.upgrade({ plugins: [BLOG] });
    assert.equal(refused.ok, false);
    assert.equal(refused.upgrades[0].status, 'blocked');
    assert.equal(refused.plugins[0].status, 'blocked', 'and the plugin is not reinstalled');
    assert.equal(calls.run, 0);

    await worker.query({ sql: "update plugin set last_install=json_set(last_install, '$.version', '1.1.0') where path=?", values: [BLOG] });
    assert.equal(byId(await worker.status(), 'plugin.upgrade_window', BLOG)[0].status, 'pass');
    assert.equal((await worker.upgrade({ plugins: [BLOG] })).ok, true);
  } finally {
    await worker.destroy();
  }
});

test('core upgrade window: too old is refused before anything runs; no install records is a warning', async () => {
  const worker = memory();
  try {
    await worker.installDefaultPlugins();
    await worker.query("update plugin set last_install=json_set(last_install, '$.core', '1.8.0') where path like '@engine9/schemas/%'");

    const refused = await worker.upgrade();
    assert.equal(refused.ok, false);
    assert.match(refused.blocked, /last upgraded with @engine9\/core 1\.8\.0\. This release upgrades databases from /);
    assert.deepEqual(refused.upgrades, []);
    assert.equal(refused.refresh.skipped, true);
    const [window] = byId(await worker.status(), 'upgrades.window');
    assert.equal(window.status, 'fail');
    assert.match(window.fix, new RegExp(`@engine9/core@${CORE_UPGRADE_FROM.replace(/\./g, '\\.')} first`));

    await worker.query('update plugin set last_install=null, last_install_status=null, last_install_at=null');
    assert.equal(byId(await worker.status(), 'upgrades.window')[0].status, 'warn', 'records predate 1.17');
    const upgraded = await worker.upgrade();
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.window.status, 'unrecorded');
    assert.equal(byId(await worker.status(), 'upgrades.window')[0].status, 'pass', 'the upgrade records every install');
  } finally {
    await worker.destroy();
  }
});

test('a malformed declaration fails status and the named upgrade; a misspelled option is reported', async () => {
  const worker = memory(registry({ upgrades: [{ id: 'broken', run: () => ({}) }] }));
  try {
    await worker.installDefaultPlugins();
    await worker.install({ path: BLOG });
    const [declaration] = byId(await worker.status(), 'upgrades.declaration', BLOG);
    assert.equal(declaration.status, 'fail');
    assert.match(declaration.detail, /upgrades\[0\] \(broken\) has no shouldUpgrade function/);
    await assert.rejects(worker.upgrade({ plugins: [BLOG] }), /has no shouldUpgrade function/);

    const dry = await worker.upgrade({ dry_run: true, drop_name_colums: true, drop_name_columns: false });
    assert.deepEqual(dry.unused_options, ['drop_name_colums']);
    assert.equal((await worker.upgrade({ dry_run: true, drop_name_columns: true })).unused_options, undefined, 'person declares drop_name_columns');
  } finally {
    await worker.destroy();
  }
});
