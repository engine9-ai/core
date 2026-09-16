import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';

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
