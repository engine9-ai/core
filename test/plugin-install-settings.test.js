import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';
import {
  SETTING_VALUE_TEXT_MAX,
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
        metadata: { name: 'Test Settings', unique: true },
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
        metadata: { name: 'Test Settings', unique: true },
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

const REMOTE_PLUGIN_PATH = '@acme-remote/bots/CrmBot';
const REMOTE_PLUGIN_ID = '22222222-2222-4222-a222-222222222222';
const REMOTE_CATALOG_ENTRY = {
  path: REMOTE_PLUGIN_PATH,
  name: 'CrmBot',
  metadata: {
    name: 'Acme CRM',
    auth_fields: { api_key: { label: 'API key' } },
    settings: [{ name: 'default_phone_type', type: 'string', values: ['home', 'mobile'], default: 'mobile' }]
  },
  submodules: {
    Gifts: {
      metadata: {
        settings: [
          { name: 'transaction_custom_fields', type: 'array', default: [], description: 'Custom fields to load' }
        ]
      }
    },
    People: {
      metadata: {
        settings: [{ name: 'person_custom_fields', type: 'array', section: 'Constituents' }]
      }
    }
  }
};

async function withRemotePlugin(plugins) {
  await plugins.install({ path: '@engine9/schemas/plugin', unique: true });
  await plugins.insertArray({
    table: 'plugin',
    array: [{ id: REMOTE_PLUGIN_ID, path: REMOTE_PLUGIN_PATH, name: 'CRM bot' }]
  });
  plugins.getPluginCatalogEntry = async ({ path }) => (path === REMOTE_PLUGIN_PATH ? REMOTE_CATALOG_ENTRY : null);
}

test('listSettings reads catalog settings for a plugin the host cannot compile', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await withRemotePlugin(plugins);
    await plugins.setSetting({ pluginId: REMOTE_PLUGIN_ID, name: 'transaction_custom_fields', value: '["a","b"]' });

    const catalog = await plugins.listSettings({ path: REMOTE_PLUGIN_PATH });
    assert.deepEqual(catalog.errors, []);
    const group = catalog.plugins[0];
    assert.equal(group.path, REMOTE_PLUGIN_PATH);
    assert.deepEqual(
      group.settings.map((row) => row.name),
      ['default_phone_type', 'transaction_custom_fields', 'person_custom_fields']
    );

    const phone = group.settings.find((row) => row.name === 'default_phone_type');
    assert.equal(phone.section, undefined);
    assert.equal(phone.default, 'mobile');

    const fields = group.settings.find((row) => row.name === 'transaction_custom_fields');
    assert.equal(fields.section, 'Gifts');
    assert.equal(fields.declared, true);
    assert.deepEqual(fields.value, ['a', 'b']);
    assert.equal(group.form.properties.transaction_custom_fields.type, 'array');

    assert.equal(group.settings.find((row) => row.name === 'person_custom_fields').section, 'Constituents');
    assert.equal(group.settings.find((row) => row.name === 'api_key'), undefined);
  } finally {
    await plugins.destroyAll();
  }
});

test('updateSetting validates against catalog declarations', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await withRemotePlugin(plugins);
    await assert.rejects(
      () => plugins.updateSetting({ plugin_id: REMOTE_PLUGIN_ID, name: 'default_phone_type', value: 'fax' }),
      /must be one of/
    );
    await assert.rejects(
      () => plugins.updateSetting({ plugin_id: REMOTE_PLUGIN_ID, name: 'transaction_custom_fields', value: '[oops' }),
      /valid JSON/
    );
    const updated = await plugins.updateSetting({
      plugin_id: REMOTE_PLUGIN_ID,
      name: 'transaction_custom_fields',
      value: ['renxt_custom_fund']
    });
    assert.deepEqual(updated.value, ['renxt_custom_fund']);
  } finally {
    await plugins.destroyAll();
  }
});

test('duplicate setting names are an error', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  const duplicateEntry = {
    path: REMOTE_PLUGIN_PATH,
    metadata: {
      settings: [{ name: 'default_phone_type', type: 'string', default: 'mobile' }]
    },
    submodules: {
      Transactions: {
        metadata: {
          settings: [{ name: 'people_custom_fields', type: 'array' }]
        }
      },
      People: {
        metadata: {
          settings: [{ name: 'people_custom_fields', type: 'array' }]
        }
      }
    }
  };
  try {
    await withRemotePlugin(plugins);
    plugins.getPluginCatalogEntry = async ({ path }) => (path === REMOTE_PLUGIN_PATH ? duplicateEntry : null);
    const catalog = await plugins.listSettings({ path: REMOTE_PLUGIN_PATH });
    assert.deepEqual(catalog.plugins, []);
    assert.equal(catalog.errors.length, 1);
    assert.match(catalog.errors[0].error, /Duplicate setting "people_custom_fields"/);
    assert.match(catalog.errors[0].error, /Transactions/);
    assert.match(catalog.errors[0].error, /People/);
    await assert.rejects(
      () => plugins.updateSetting({ plugin_id: REMOTE_PLUGIN_ID, name: 'people_custom_fields', value: ['a'] }),
      /Duplicate setting "people_custom_fields"/
    );
  } finally {
    await plugins.destroyAll();
  }
});

test('catalog settings win over package settings with the same name', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [
    { name: 'color', values: ['blue', 'red'], default: 'blue' },
    { name: 'size', default: 'm' }
  ]);
  plugins.getPluginCatalogEntry = async ({ path }) =>
    path === TEST_PLUGIN_PATH ? { metadata: { settings: [{ name: 'color', values: ['green'], default: 'green' }] } } : null;
  try {
    await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    const catalog = await plugins.listSettings({ path: TEST_PLUGIN_PATH });
    const group = catalog.plugins[0];
    assert.deepEqual(group.settings.find((row) => row.name === 'color').values, ['green']);
    assert.equal(group.settings.find((row) => row.name === 'size').default, 'm');
  } finally {
    await plugins.destroyAll();
  }
});

test('PluginWorker.getPluginCatalogEntry hook supplies catalog entries', async () => {
  const previous = PluginWorker.getPluginCatalogEntry;
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    assert.equal(await plugins.getPluginCatalogEntry({ path: REMOTE_PLUGIN_PATH }), null);
    PluginWorker.getPluginCatalogEntry = async function ({ path }) {
      assert.equal(this, plugins);
      return path === REMOTE_PLUGIN_PATH ? REMOTE_CATALOG_ENTRY : null;
    };
    assert.equal(await plugins.getPluginCatalogEntry({ path: REMOTE_PLUGIN_PATH }), REMOTE_CATALOG_ENTRY);
    assert.equal(await plugins.getPluginCatalogEntry({ path: '@acme-remote/bots/Other' }), null);
  } finally {
    if (previous === undefined) delete PluginWorker.getPluginCatalogEntry;
    else PluginWorker.getPluginCatalogEntry = previous;
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

test('setSetting rejects values longer than setting.value', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [{ name: 'blob', default: '' }]);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    const valueCol = (await plugins.describe({ table: 'setting' })).columns.find((c) => c.name === 'value');
    assert.ok(Number(valueCol.length) > 0);

    const tooLong = 'x'.repeat(Number(valueCol.length) + 1);
    await assert.rejects(
      () => plugins.setSetting({ pluginId: installed.id, name: 'blob', value: tooLong }),
      /Setting value is too long/
    );

    const ok = 'y'.repeat(Math.min(Number(valueCol.length), SETTING_VALUE_TEXT_MAX));
    await plugins.setSetting({ pluginId: installed.id, name: 'blob', value: ok });
    const settings = await plugins.getSettings({ pluginId: installed.id });
    assert.equal(settings.blob, ok);
  } finally {
    await plugins.destroyAll();
  }
});

test('setSetting uses live column length (varchar still rejects oversize)', async () => {
  const plugins = new PluginWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  withSettingsPlugin(plugins, [{ name: 'blob', default: '' }]);
  try {
    const installed = await plugins.install({ path: TEST_PLUGIN_PATH, unique: true });
    const origDescribe = plugins.describe.bind(plugins);
    plugins.describe = async (opts) => {
      const desc = await origDescribe(opts);
      if (opts?.table !== 'setting') return desc;
      return {
        ...desc,
        columns: desc.columns.map((c) => (c.name === 'value' ? { ...c, length: 255, type: 'string', column_type: 'varchar' } : c))
      };
    };
    await assert.rejects(
      () => plugins.setSetting({ pluginId: installed.id, name: 'blob', value: 'x'.repeat(256) }),
      /exceeds setting\.value limit of 255/
    );
  } finally {
    await plugins.destroyAll();
  }
});
