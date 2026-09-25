import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PLUGIN_NOT_IN_BUILD,
  createPluginRegistry,
  composePluginRegistries,
  compileRegistryPlugin,
  loadRegistrySchema,
  loadRegistryConsole
} from '../lib/pluginRegistry.js';
import PluginWorker from '../lib/PluginWorker.js';
import { buildPlugins } from '../bin/buildPlugins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const fixture = createPluginRegistry(
  {
    'acme/crm': {
      index: async () => ({
        default: { metadata: { name: 'CRM' }, transforms: { pull: { transform: () => 1 } } }
      }),
      schema: { default: { tables: [{ name: 'acme_crm', columns: { id: 'id_uuid' } }] } },
      settings: { settings: [{ name: 'api_host', default: 'crm.example.com' }] },
      console: { menu: { crm: { title: 'CRM' } } }
    }
  },
  { name: 'fixture' }
);

test('compileRegistryPlugin stamps path, transforms, and settings', async () => {
  const plugin = await compileRegistryPlugin(fixture, 'local$acme/crm');
  assert.equal(plugin.path, 'acme/crm');
  assert.equal(plugin.transforms.pull.path, 'acme/crm');
  assert.deepEqual(plugin.settings, [{ name: 'api_host', default: 'crm.example.com' }]);
  const schema = await loadRegistrySchema(fixture, 'acme/crm');
  assert.equal(schema.tables[0].name, 'acme_crm');
  assert.deepEqual(await loadRegistryConsole(fixture, 'acme/crm'), { menu: { crm: { title: 'CRM' } } });
  assert.equal(await loadRegistryConsole(fixture, 'acme/other'), null);
});

test('a plugin outside the build fails with PLUGIN_NOT_IN_BUILD', async () => {
  await assert.rejects(() => compileRegistryPlugin(fixture, 'acme/other'), (e) => {
    assert.equal(e.code, PLUGIN_NOT_IN_BUILD);
    assert.match(e.message, /build-plugins/);
    return true;
  });
  await assert.rejects(() => compileRegistryPlugin(null, 'acme/crm'), { code: PLUGIN_NOT_IN_BUILD });
  await assert.rejects(
    () => compileRegistryPlugin(fixture, 'acme/crm', { source: '/tmp/crm' }),
    /only runs pre-compiled plugins/
  );
});

test('composePluginRegistries: first registry that has the plugin wins; source needs support', async () => {
  const override = createPluginRegistry({ 'acme/crm': { index: { default: { metadata: { name: 'Override' } } } } });
  const withSource = {
    name: 'runtime',
    supportsSource: true,
    paths: async () => [],
    has: async () => false,
    load: async (p, { source } = {}) => (source ? { path: p, index: { default: { metadata: { name: source } } } } : null)
  };
  const composed = composePluginRegistries(withSource, override, fixture);
  assert.equal((await compileRegistryPlugin(composed, 'acme/crm')).metadata.name, 'Override');
  assert.equal((await compileRegistryPlugin(composed, 'acme/crm', { source: '/src' })).metadata.name, '/src');
  assert.deepEqual(await composed.paths(), ['acme/crm']);
});

test('PluginWorker install refuses a plugin that is not in the build', async () => {
  const worker = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' },
    plugins: fixture
  });
  try {
    await assert.rejects(() => worker.install({ path: 'acme/other', unique: true }), { code: PLUGIN_NOT_IN_BUILD });
    assert.deepEqual(await worker.listAvailable(), ['acme/crm']);
  } finally {
    await worker.destroyAll();
  }
});

test('lib/plugins/interfaces.js is current (npm run build:plugins)', () => {
  const result = buildPlugins({
    cwd: root,
    packages: ['@engine9/interfaces'],
    out: 'lib/plugins/interfaces.js',
    check: true
  });
  assert.ok(result.count > 10);
});

test('build-plugins selects configured plugins, stack includes, and core interfaces', async () => {
  const site = mkdtempSync(path.join(tmpdir(), 'e9-build-plugins-'));
  try {
    const nm = path.join(site, 'node_modules');
    mkdirSync(path.join(nm, '@engine9'), { recursive: true });
    symlinkSync(path.dirname(require.resolve('@engine9/interfaces/package.json')), path.join(nm, '@engine9/interfaces'));
    const pkg = path.join(nm, 'acme-plugins');
    const write = (rel, text) => {
      mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });
      writeFileSync(path.join(pkg, rel), text);
    };
    write('package.json', JSON.stringify({ name: 'acme-plugins', type: 'module' }));
    write('crm/index.js', "export default { metadata: { name: 'CRM' } };\n");
    write('crm/settings.js', "export const settings = [{ name: 'region', default: 'us' }];\n");
    write('crm/ui.console.json5', "{ menu: { crm: { title: 'CRM' } } }\n");
    write('crm/skills/index.js', 'export default {};\n');
    write('exports/gifts.plugin.js', "export default { metadata: { name: 'Gifts' } };\n");
    writeFileSync(
      path.join(site, 'package.json'),
      JSON.stringify({
        name: 'site',
        type: 'module',
        engine9: { plugins: ['acme-plugins/crm', 'acme-plugins/exports/gifts.plugin.js', '@engine9/interfaces/stacks/standard'] }
      })
    );

    const first = buildPlugins({ cwd: site });
    assert.equal(first.changed, true);
    const text = readFileSync(first.out, 'utf8');
    assert.match(text, /import\("acme-plugins\/crm\/settings\.js"\)/);
    assert.doesNotMatch(text, /skills/);
    assert.doesNotMatch(text, /@engine9\/interfaces\/event/);
    assert.equal(buildPlugins({ cwd: site }).changed, false);

    const { default: entries } = await import(pathToFileURL(first.out).href);
    const registry = createPluginRegistry(entries);
    const paths = await registry.paths();
    for (const p of [
      'acme-plugins/crm',
      'acme-plugins/exports/gifts.plugin.js',
      '@engine9/interfaces/stacks/standard',
      '@engine9/interfaces/transaction/core',
      '@engine9/interfaces/segment'
    ]) {
      assert.ok(paths.includes(p), `${p} in build`);
    }
    const crm = await compileRegistryPlugin(registry, 'acme-plugins/crm');
    assert.deepEqual(crm.settings, [{ name: 'region', default: 'us' }]);
    assert.deepEqual(await loadRegistryConsole(registry, 'acme-plugins/crm'), { menu: { crm: { title: 'CRM' } } });
    assert.equal((await compileRegistryPlugin(registry, 'acme-plugins/exports/gifts.plugin.js')).metadata.name, 'Gifts');

    writeFileSync(
      path.join(site, 'package.json'),
      JSON.stringify({ name: 'site', type: 'module', engine9: { plugins: ['acme-plugins/missing'] } })
    );
    assert.throws(() => buildPlugins({ cwd: site }), /acme-plugins\/missing is not in node_modules/);
    assert.throws(() => buildPlugins({ cwd: site, plugins: ['acme-plugins/crm'], check: true }), /out of date/);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});
