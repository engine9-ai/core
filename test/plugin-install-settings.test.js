import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';
import {
  normalizePluginSettings,
  settingFormFromDefs,
  validateSettingValue
} from '../lib/pluginSettings.js';

const TEST_PLUGIN_PATH = '@engine9/plugins/test-settings';

function withSettingsPlugin(worker, settings) {
  const orig = worker.compilePlugin.bind(worker);
  worker.compilePlugin = async (opts) => {
    if (opts.path === TEST_PLUGIN_PATH) {
      return {
        metadata: { name: 'Test Settings', unique: true, version: '1.0.0' },
        settings
      };
    }
    return orig(opts);
  };
}

test('install inserts plugin setting defaults and does not overwrite', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [
    { name: 'color', default: 'blue' },
    { name: 'size', default: 'm' }
  ]);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    const first = await plugins.getSettings({ pluginId: installed.id });
    assert.equal(first.color, 'blue');
    assert.equal(first.size, 'm');

    await plugins.setSetting({ pluginId: installed.id, name: 'color', value: 'red' });
    await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    const again = await plugins.getSettings({ pluginId: installed.id });
    assert.equal(again.color, 'red');
    assert.equal(again.size, 'm');
  } finally {
    await plugins.destroyAll();
  }
});

test('reinstall inserts newly declared settings', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [{ name: 'color', default: 'blue' }]);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    withSettingsPlugin(plugins, [
      { name: 'color', default: 'blue' },
      { name: 'size', default: 'm' }
    ]);
    await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    const settings = await plugins.getSettings({ pluginId: installed.id });
    assert.equal(settings.color, 'blue');
    assert.equal(settings.size, 'm');
  } finally {
    await plugins.destroyAll();
  }
});

test('listSettings groups declared metadata and current values by plugin', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [
    {
      name: 'color',
      type: 'string',
      values: ['blue', 'red'],
      default: 'blue',
      description: 'Accent color'
    },
    { name: 'token', type: 'password', secret: true, default: 's3cret' },
    { name: 'internal_flag', type: 'string', hidden: true, default: 'x' }
  ]);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    await plugins.setSetting({ pluginId: installed.id, name: 'color', value: 'red' });
    await plugins.setSetting({ pluginId: installed.id, name: 'extra_note', value: 'hello' });

    const catalog = await plugins.listSettings();
    const group = catalog.plugins.find((row) => row.path === TEST_PLUGIN_PATH);
    assert.ok(group, JSON.stringify(catalog));
    assert.equal(group.name, 'Test Settings');
    assert.equal(group.plugin.instances[0].id, installed.id);
    assert.equal(group.form.properties.color.enum[0], 'blue');
    assert.equal(group.form.properties.internal_flag, undefined);

    const color = group.settings.find((row) => row.name === 'color');
    assert.equal(color.type, 'string');
    assert.equal(color.description, 'Accent color');
    assert.equal(color.value, 'red');
    assert.equal(color.declared, true);
    assert.equal(color.instances[0].plugin_id, installed.id);

    const token = group.settings.find((row) => row.name === 'token');
    assert.equal(token.value, null);
    assert.equal(token.has_value, true);
    assert.equal(token.secret, true);

    assert.equal(group.settings.find((row) => row.name === 'internal_flag'), undefined);

    const extra = group.settings.find((row) => row.name === 'extra_note');
    assert.equal(extra.declared, false);
    assert.equal(extra.value, 'hello');

    const hidden = await plugins.listSettings({ include_hidden: true, path: TEST_PLUGIN_PATH });
    assert.ok(hidden.plugins[0].settings.find((row) => row.name === 'internal_flag'));
  } finally {
    await plugins.destroyAll();
  }
});

test('updateSetting validates declared values', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [
    { name: 'kind', type: 'string', values: ['legacy', 'current'], default: 'legacy' }
  ]);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    await assert.rejects(
      () => plugins.updateSetting({ plugin_id: installed.id, name: 'kind', value: 'nope' }),
      /must be one of/
    );
    const updated = await plugins.updateSetting({ plugin_id: installed.id, name: 'kind', value: 'current' });
    assert.equal(updated.value, 'current');
    const stored = await plugins.getSettings({ pluginId: installed.id });
    assert.equal(stored.kind, 'current');
  } finally {
    await plugins.destroyAll();
  }
});

test('listSettings continues when one plugin fails to compile', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  const orig = plugins.compilePlugin.bind(plugins);
  plugins.compilePlugin = async (opts) => {
    if (opts.path === TEST_PLUGIN_PATH) {
      return {
        metadata: { name: 'Test Settings', unique: true, version: '1.0.0' },
        settings: [{ name: 'color', default: 'blue' }]
      };
    }
    if (opts.path === '@engine9/plugins/broken-settings') throw new Error('boom');
    return orig(opts);
  };
  try {
    await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    await plugins.insertArray({
      table: 'plugin',
      array: [{ id: '11111111-1111-4111-a111-111111111111', path: '@engine9/plugins/broken-settings', name: 'Broken' }]
    });
    const catalog = await plugins.listSettings();
    assert.ok(catalog.plugins.find((row) => row.path === TEST_PLUGIN_PATH));
    assert.ok(catalog.errors.find((row) => row.path === '@engine9/plugins/broken-settings'));
  } finally {
    await plugins.destroyAll();
  }
});

test('normalizePluginSettings accepts array and object maps', () => {
  assert.deepEqual(
    normalizePluginSettings([{ name: 'a', default: 1 }]).map((row) => row.name),
    ['a']
  );
  const fromObject = normalizePluginSettings({ color: { type: 'string', default: 'blue' }, size: 'm' });
  assert.equal(fromObject[0].name, 'color');
  assert.equal(fromObject[1].name, 'size');
  assert.equal(fromObject[1].default, 'm');
});

test('settingFormFromDefs builds JSON Schema and skips hidden', () => {
  const form = settingFormFromDefs([
    { name: 'kind', type: 'string', values: ['legacy', 'current'], description: 'Mode', default: 'legacy' },
    { name: 'hidden_one', hidden: true, type: 'string' }
  ]);
  assert.equal(form.type, 'object');
  assert.deepEqual(form.properties.kind.enum, ['legacy', 'current']);
  assert.equal(form.properties.hidden_one, undefined);
});

test('validateSettingValue enforces enum and integer', () => {
  assert.equal(validateSettingValue({ name: 'n', type: 'int' }, 3), '3');
  assert.throws(() => validateSettingValue({ name: 'n', type: 'int' }, 'x'), /integer/);
  assert.throws(
    () => validateSettingValue({ name: 'kind', values: ['a', 'b'] }, 'c'),
    /must be one of/
  );
});
