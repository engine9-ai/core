import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PLUGIN_CONFIG_INVALID,
  PLUGIN_IMPORT_FAILED,
  PLUGIN_NOT_FOUND,
  PLUGIN_PACKAGE_NOT_DECLARED,
  createPluginRegistry,
  composePluginRegistries,
  compileRegistryPlugin,
  getDefaultPluginRegistry,
  loadRegistrySchema,
  loadRegistryConsole
} from '../lib/pluginRegistry.js';
import PluginWorker from '../lib/PluginWorker.js';
import { buildPlugins } from '../bin/buildPlugins.js';
import { createNodePluginRegistry, describePluginRegistry } from '../bin/nodePluginRegistry.js';

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
    },
    'acme/broken': {
      index: async () => {
        throw new SyntaxError('Unexpected token');
      }
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

test('error codes: not found, package not declared, import failed, no registry', async () => {
  await assert.rejects(() => compileRegistryPlugin(fixture, 'acme/other'), (e) => {
    assert.equal(e.code, PLUGIN_NOT_FOUND);
    assert.match(e.message, /package "acme"/);
    assert.match(e.message, /nearby: acme\/broken, acme\/crm/);
    return true;
  });
  await assert.rejects(() => compileRegistryPlugin(fixture, 'other-vendor/crm'), (e) => {
    assert.equal(e.code, PLUGIN_PACKAGE_NOT_DECLARED);
    assert.match(e.message, /engine9\.pluginPackages/);
    assert.match(e.message, /declared: acme/);
    return true;
  });
  await assert.rejects(() => compileRegistryPlugin(fixture, 'acme/broken'), (e) => {
    assert.equal(e.code, PLUGIN_IMPORT_FAILED);
    assert.ok(e.cause instanceof SyntaxError);
    assert.match(e.message, /Unexpected token/);
    return true;
  });
  await assert.rejects(() => compileRegistryPlugin(null, 'acme/crm'), { code: PLUGIN_CONFIG_INVALID });
});

test('composePluginRegistries: first registry that has the plugin wins; errors name the owner', async () => {
  const override = createPluginRegistry(
    { 'acme/crm': { index: { default: { metadata: { name: 'Override' } } } } },
    { name: 'override' }
  );
  const other = createPluginRegistry({ 'vendor/x': { index: { default: {} } } }, { name: 'vendor', hint: 'vendor hint.' });
  const composed = composePluginRegistries(override, fixture, other);
  assert.equal((await compileRegistryPlugin(composed, 'acme/crm')).metadata.name, 'Override');
  assert.deepEqual(await composed.paths(), ['acme/broken', 'acme/crm', 'vendor/x']);
  assert.deepEqual(await composed.packages(), ['acme', 'vendor']);
  await assert.rejects(() => compileRegistryPlugin(composed, 'vendor/y'), (e) => {
    assert.equal(e.code, PLUGIN_NOT_FOUND);
    assert.match(e.message, /registry: vendor/);
    assert.match(e.message, /vendor hint/);
    return true;
  });
});

test('PluginWorker install refuses a plugin that is not in the registry', async () => {
  const worker = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' },
    plugins: composePluginRegistries(fixture, getDefaultPluginRegistry())
  });
  try {
    await assert.rejects(() => worker.install({ path: 'acme/other', unique: true }), { code: PLUGIN_NOT_FOUND });
    await assert.rejects(() => worker.install({ path: 'vendor/other', unique: true }), { code: PLUGIN_PACKAGE_NOT_DECLARED });
    const available = await worker.listAvailable();
    assert.ok(available.includes('acme/crm') && available.includes('@engine9/interfaces/person'));
  } finally {
    await worker.destroyAll();
  }
});

/** A throwaway project with @engine9/interfaces linked and a small local package. */
function makeSite(engine9Config) {
  const site = mkdtempSync(path.join(tmpdir(), 'e9-plugins-'));
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
  const setConfig = (engine9) =>
    writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'site', type: 'module', engine9 }));
  setConfig(engine9Config);
  return { site, pkg, write, setConfig, cleanup: () => rmSync(site, { recursive: true, force: true }) };
}

test('build-plugins selects configured plugins, stack includes, and core interfaces', async () => {
  const { site, setConfig, cleanup } = makeSite({
    plugins: ['acme-plugins/crm', 'acme-plugins/exports/gifts.plugin.js', '@engine9/interfaces/stacks/standard']
  });
  try {
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

    setConfig({ plugins: ['acme-plugins/missing'] });
    assert.throws(() => buildPlugins({ cwd: site }), { code: PLUGIN_CONFIG_INVALID });
    assert.throws(() => buildPlugins({ cwd: site, plugins: ['acme-plugins/crm'], check: true }), /out of date/);

    setConfig({ pluginPackages: ['acme-plugins'], dynamicPluginPackages: ['acme-plugins'] });
    assert.throws(() => buildPlugins({ cwd: site }), /one or the other/);
    setConfig({ pluginPackages: ['@engine9/interfaces'], dynamicPluginPackages: ['acme-plugins'] });
    assert.throws(() => buildPlugins({ cwd: site }), (e) => {
      assert.equal(e.code, PLUGIN_CONFIG_INVALID);
      assert.match(e.message, /bundle cannot read plugins from disk/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('Node registry: static packages are read at start, dynamic packages on every use', async () => {
  const { site, pkg, write, setConfig, cleanup } = makeSite({
    pluginPackages: ['@engine9/interfaces'],
    dynamicPluginPackages: ['acme-plugins']
  });
  try {
    const registry = createNodePluginRegistry({ cwd: site });
    assert.deepEqual(await registry.packages(), ['@engine9/interfaces', 'acme-plugins']);
    assert.match(await describePluginRegistry(registry, { cwd: site }), /static: @engine9\/interfaces; dynamic: acme-plugins/);

    const person = await compileRegistryPlugin(registry, '@engine9/interfaces/person');
    assert.equal(person.path, '@engine9/interfaces/person');
    assert.ok(person.resolvedFsEntry.endsWith(path.join('person', 'index.js')));
    assert.ok((await loadRegistrySchema(registry, '@engine9/interfaces/person_email')).tables.length);

    const crm = await compileRegistryPlugin(registry, 'acme-plugins/crm');
    assert.equal(crm.metadata.name, 'CRM');
    assert.deepEqual(crm.settings, [{ name: 'region', default: 'us' }]);
    assert.deepEqual(await loadRegistryConsole(registry, 'acme-plugins/crm'), { menu: { crm: { title: 'CRM' } } });

    // New file: visible without restart.
    write('exports/pledges.plugin.js', "import { label } from './label.js';\nexport default { metadata: { name: label } };\n");
    write('exports/label.js', "export const label = 'Pledges';\n");
    assert.equal((await compileRegistryPlugin(registry, 'acme-plugins/exports/pledges.plugin.js')).metadata.name, 'Pledges');
    assert.ok((await registry.paths()).includes('acme-plugins/exports/pledges.plugin.js'));

    // Edited sibling: the plugin reloads with it.
    write('exports/label.js', "export const label = 'Pledges v2';\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(pkg, 'exports/label.js'), later, later);
    assert.equal((await compileRegistryPlugin(registry, 'acme-plugins/exports/pledges.plugin.js')).metadata.name, 'Pledges v2');

    // Errors.
    await assert.rejects(() => compileRegistryPlugin(registry, 'acme-plugins/exports/pledge.plugin.js'), (e) => {
      assert.equal(e.code, PLUGIN_NOT_FOUND);
      assert.match(e.message, /Looked for .*acme-plugins\/exports\/pledge\.plugin\.js/);
      assert.match(e.message, /nearby: acme-plugins\/exports\/pledges\.plugin\.js/);
      return true;
    });
    await assert.rejects(() => compileRegistryPlugin(registry, '@engine9/interfaces/persn'), (e) => {
      assert.equal(e.code, PLUGIN_NOT_FOUND);
      assert.match(e.message, /restart after adding one/);
      assert.match(e.message, /nearby: @engine9\/interfaces\/person/);
      return true;
    });
    await assert.rejects(() => compileRegistryPlugin(registry, '@engine9/plugins/e9email'), { code: PLUGIN_PACKAGE_NOT_DECLARED });
    write('exports/bad.plugin.js', "import './missing.js';\nexport default {};\n");
    await assert.rejects(() => compileRegistryPlugin(registry, 'acme-plugins/exports/bad.plugin.js'), (e) => {
      assert.equal(e.code, PLUGIN_IMPORT_FAILED);
      assert.match(e.message, /bad\.plugin\.js/);
      assert.ok(e.cause);
      return true;
    });

    // Boot: a listed package that is not installed.
    setConfig({ pluginPackages: ['@engine9/interfaces', 'not-installed'] });
    assert.throws(() => createNodePluginRegistry({ cwd: site }), (e) => {
      assert.equal(e.code, PLUGIN_CONFIG_INVALID);
      assert.match(e.message, /"not-installed" is listed in package.json "engine9" but is not installed/);
      return true;
    });
  } finally {
    cleanup();
  }
});
