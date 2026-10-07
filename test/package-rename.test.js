import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';
import { getDefaultPluginRegistry, compileRegistryPlugin } from '../lib/pluginRegistry.js';
import { readCorePluginSettings } from '../lib/corePluginSettings.js';
import { packageRenameStatements } from '../lib/packageRename.js';
import {
  equivalentPluginPaths,
  normalizePluginInstallPath,
  normalizePluginPackageName,
  packageNameOf,
  pluginPathMatches,
  resolveAvailablePluginPath
} from '../lib/pluginPaths.js';

const LEGACY = '@engine9/interfaces/';
const CURRENT = '@engine9/schemas/';

test('legacy @engine9/interfaces paths normalize to @engine9/schemas', () => {
  assert.equal(normalizePluginInstallPath('@engine9/interfaces/person'), '@engine9/schemas/person');
  assert.equal(normalizePluginInstallPath('local$@engine9/interfaces/person'), '@engine9/schemas/person');
  assert.equal(
    normalizePluginInstallPath('@engine9/interfaces/person_email:search:emails'),
    '@engine9/schemas/person_email:search:emails'
  );
  assert.equal(normalizePluginInstallPath('@engine9/interfaces-extra/x'), '@engine9/interfaces-extra/x');
  assert.equal(normalizePluginInstallPath('@engine9/plugins/e9email'), '@engine9/plugins/e9email');
  assert.equal(packageNameOf('@engine9/interfaces/person'), '@engine9/schemas');
  assert.equal(normalizePluginPackageName('@engine9/interfaces'), '@engine9/schemas');
  assert.equal(normalizePluginPackageName('@engine9/plugins'), '@engine9/plugins');
});

test('equivalentPluginPaths lists every stored spelling of a schemas path', () => {
  assert.deepEqual(new Set(equivalentPluginPaths('@engine9/schemas/person')), new Set([
    '@engine9/schemas/person',
    'local$@engine9/schemas/person',
    '@engine9/interfaces/person',
    'local$@engine9/interfaces/person'
  ]));
  assert.ok(pluginPathMatches('@engine9/interfaces/person', '@engine9/schemas/person'));
  assert.deepEqual(equivalentPluginPaths('@engine9/plugins/e9email'), [
    '@engine9/plugins/e9email',
    'local$@engine9/plugins/e9email'
  ]);
  assert.equal(
    resolveAvailablePluginPath('@engine9/interfaces/person', ['@engine9/schemas/person']),
    '@engine9/schemas/person'
  );
});

test('a legacy path loads the @engine9/schemas plugin', async () => {
  const plugin = await compileRegistryPlugin(getDefaultPluginRegistry(), '@engine9/interfaces/person_email');
  assert.equal(plugin.path, '@engine9/schemas/person_email');
});

test('package-rename SQL quotes the reserved schema column on MySQL', () => {
  const mysql = packageRenameStatements({ dialect: 'mysql' });
  const schema = mysql.find((s) => s.key === 'plugin.schema');
  assert.match(schema.updateSql, /cast\(`schema` as char\)/);
  assert.match(schema.updateSql, /modified_at = modified_at/);
  const sqlite = packageRenameStatements({ dialect: 'sqlite', inline: true });
  assert.ok(sqlite.every((s) => !s.updateSql.includes('?') && s.updateValues.length === 0));
});

async function legacyAccount() {
  const worker = new PluginWorker({ accountId: 'rename', auth: { database_connection: 'sqlite://:memory:' } });
  await worker.installDefaultPlugins();
  const corePlugin = (await worker.query({ sql: "select id from plugin where path = '@engine9/schemas/plugin'" })).data[0];
  await worker.setSetting({ pluginId: corePlugin.id, name: 'default_stack', value: '@engine9/schemas/stacks/standard' });
  const emailPlugin = (await worker.query({ sql: "select id from plugin where path = '@engine9/schemas/person_email'" })).data[0];
  await worker.query({
    sql: `insert into segment (id, plugin_id, name, definition_path, search, build_type) values (?, ?, ?, ?, ?, 'search')`,
    values: [
      '00000000-0000-4000-a000-0000000000aa',
      emailPlugin.id,
      'Openers',
      '@engine9/schemas/channels/email:segments:email_openers_30d',
      JSON.stringify({ and: [{ path: '@engine9/schemas/person_email:search:emails', options: {} }] })
    ]
  });
  for (const [table, column] of [['plugin', 'path'], ['segment', 'definition_path'], ['segment', 'search'], ['setting', 'value']]) {
    await worker.query({ sql: `update ${table} set ${column} = replace(${column}, ?, ?)`, values: [CURRENT, LEGACY] });
  }
  await worker.query({
    sql: "update plugin set path = 'local$' || path where path = '@engine9/interfaces/person_phone'"
  });
  return worker;
}

test('migratePackageRename rewrites stored paths; reads work before and after', async () => {
  const worker = await legacyAccount();
  try {
    const settingsBefore = await readCorePluginSettings(worker);
    assert.equal(settingsBefore.default_stack, '@engine9/interfaces/stacks/standard');

    const reinstalled = await worker.install({ path: '@engine9/schemas/person', unique: true });
    assert.equal(reinstalled.path, '@engine9/schemas/person');
    const personRows = (await worker.query({ sql: "select id from plugin where path like '%/person'" })).data;
    assert.equal(personRows.length, 1);

    const dry = await worker.migratePackageRename({ dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.before['plugin.path'] > 0);
    assert.equal(dry.before['segment.definition_path'], 1);
    assert.equal(dry.before['segment.search'], 1);
    assert.equal(dry.before['setting.value'], 1);
    const stillLegacy = (await worker.query({ sql: "select count(*) as n from plugin where path like '%@engine9/interfaces/%'" })).data[0].n;
    assert.equal(Number(stillLegacy), dry.before['plugin.path']);

    const done = await worker.migratePackageRename();
    assert.equal(done.complete, true);
    assert.ok(Object.values(done.after).every((n) => n === 0));

    const paths = (await worker.query({ sql: 'select path from plugin' })).data.map((r) => r.path);
    assert.ok(paths.includes('@engine9/schemas/person_phone'));
    assert.ok(paths.every((p) => !p.includes('interfaces') && !p.startsWith('local$')));
    const [segment] = (await worker.query({ sql: 'select definition_path, search from segment' })).data;
    assert.equal(segment.definition_path, '@engine9/schemas/channels/email:segments:email_openers_30d');
    assert.equal(JSON.parse(segment.search).and[0].path, '@engine9/schemas/person_email:search:emails');
    assert.equal((await readCorePluginSettings(worker)).default_stack, '@engine9/schemas/stacks/standard');

    const again = await worker.migratePackageRename();
    assert.ok(Object.values(again.before).every((n) => n === 0 || n === null));
  } finally {
    await worker.destroyAll();
  }
});

test('migratePackageRename refuses when a plugin has rows under both names', async () => {
  const worker = await legacyAccount();
  try {
    await worker.query({
      sql: "insert into plugin (id, path, name, table_prefix) values ('00000000-0000-4000-a000-0000000000bb', '@engine9/schemas/person', 'dup', '')"
    });
    await assert.rejects(() => worker.migratePackageRename(), /@engine9\/schemas\/person/);
    const legacy = (await worker.query({ sql: "select count(*) as n from plugin where path = '@engine9/interfaces/person'" })).data[0].n;
    assert.equal(Number(legacy), 1);
  } finally {
    await worker.destroyAll();
  }
});
