import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';
import { getDefaultPluginRegistry, compileRegistryPlugin } from '../lib/pluginRegistry.js';
import { readCorePluginSettings } from '../lib/corePluginSettings.js';
import { packageRenameStatements } from '../lib/packageRename.js';
import { resolveAvailablePluginPath } from '../lib/pluginPaths.js';

const LEGACY = '@engine9/interfaces/';
const CURRENT = '@engine9/schemas/';

test('old path spellings do not load', async () => {
  const registry = getDefaultPluginRegistry();
  await assert.rejects(() => compileRegistryPlugin(registry, '@engine9/interfaces/person_email'));
  await assert.rejects(() => compileRegistryPlugin(registry, 'local$@engine9/schemas/person_email'));
  assert.throws(() => resolveAvailablePluginPath('@engine9/interfaces/person', ['@engine9/schemas/person']));
});

test('package-rename SQL quotes the reserved schema column on MySQL', () => {
  const mysql = packageRenameStatements({ dialect: 'mysql' });
  const schema = mysql.find((s) => s.key === 'plugin.schema');
  assert.match(schema.updateSql, /cast\(`schema` as char\)/);
  assert.match(schema.updateSql, /modified_at = modified_at/);
  const sqlite = packageRenameStatements({ dialect: 'sqlite', inline: true });
  assert.ok(sqlite.every((s) => !s.updateSql.includes('?') && s.updateValues.length === 0));
  assert.ok(sqlite.every((s) => s.updateSql.includes("'local$'") && s.updateSql.includes(`'${LEGACY}'`)));
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
      JSON.stringify({
        and: [
          { path: '@engine9/schemas/person_email:search:emails', options: {} },
          { path: 'local$@engine9/schemas/person:search:people', options: {} }
        ]
      })
    ]
  });
  for (const [table, column] of [['plugin', 'path'], ['segment', 'definition_path'], ['segment', 'search'], ['setting', 'value']]) {
    await worker.query({ sql: `update ${table} set ${column} = replace(${column}, ?, ?)`, values: [CURRENT, LEGACY] });
  }
  await worker.query({
    sql: "update plugin set path = 'local$' || path where path = '@engine9/interfaces/person_phone'"
  });
  await worker.query({
    sql: "insert into plugin (id, path, name, table_prefix) values ('00000000-0000-4000-a000-0000000000cc', 'local$acme/crm', 'Acme CRM', '')"
  });
  return worker;
}

test('migratePackageRename rewrites @engine9/interfaces and strips local$', async () => {
  const worker = await legacyAccount();
  try {
    assert.equal((await readCorePluginSettings(worker)).default_stack, null);

    const dry = await worker.migratePackageRename({ dryRun: true });
    assert.equal(dry.dryRun, true);
    const legacyRows = (
      await worker.query({ sql: "select count(*) as n from plugin where path like '%@engine9/interfaces/%' or path like 'local$%'" })
    ).data[0].n;
    assert.equal(dry.before['plugin.path'], Number(legacyRows));
    assert.equal(dry.before['segment.definition_path'], 1);
    assert.equal(dry.before['segment.search'], 1);
    assert.equal(dry.before['setting.value'], 1);

    const done = await worker.migratePackageRename();
    assert.equal(done.complete, true);
    assert.ok(Object.values(done.after).every((n) => n === 0));

    const paths = (await worker.query({ sql: 'select path from plugin' })).data.map((r) => r.path);
    assert.ok(paths.includes('@engine9/schemas/person_phone'));
    assert.ok(paths.includes('acme/crm'));
    assert.ok(paths.every((p) => !p.includes('interfaces') && !p.includes('local$')));
    const [segment] = (await worker.query({ sql: 'select definition_path, search from segment' })).data;
    assert.equal(segment.definition_path, '@engine9/schemas/channels/email:segments:email_openers_30d');
    assert.deepEqual(
      JSON.parse(segment.search).and.map((c) => c.path),
      ['@engine9/schemas/person_email:search:emails', '@engine9/schemas/person:search:people']
    );
    assert.equal((await readCorePluginSettings(worker)).default_stack, '@engine9/schemas/stacks/standard');

    const again = await worker.migratePackageRename();
    assert.ok(Object.values(again.before).every((n) => n === 0 || n === null));
  } finally {
    await worker.destroyAll();
  }
});

test('migratePackageRename refuses when a plugin has rows under an old and the current path', async () => {
  const worker = await legacyAccount();
  try {
    await worker.query({
      sql: "insert into plugin (id, path, name, table_prefix) values ('00000000-0000-4000-a000-0000000000bb', '@engine9/schemas/person_phone', 'dup', '')"
    });
    await assert.rejects(() => worker.migratePackageRename(), /@engine9\/schemas\/person_phone/);
    const legacy = (await worker.query({ sql: "select count(*) as n from plugin where path = 'local$@engine9/interfaces/person_phone'" })).data[0].n;
    assert.equal(Number(legacy), 1);
  } finally {
    await worker.destroyAll();
  }
});
