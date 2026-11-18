import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  ENTRY_KEYS,
  FIELD_KEYS,
  FIELD_TYPES,
  PLUGIN_CATALOG_SCHEMA_URL,
  buildPluginCatalogEntry,
  bundlePluginCatalog,
  catalogMethodsOf,
  pluginCatalogFile,
  pluginCredentialsDefinition,
  validatePluginCatalogEntry,
  README_MAX_LENGTH
} from '../lib/pluginCatalog.js';
import { catalogSettingDefinitions } from '../lib/pluginSettings.js';

function Orders() {}
Orders.metadata = { description: 'Orders', catalog_methods: ['syncOrders'] };
Orders.prototype.syncOrders = function syncOrders() {};
Orders.prototype.syncOrders.metadata = {
  description: 'Read new orders',
  options: { since: { description: 'Start date', type: 'date' }, page: true }
};
Orders.prototype.internal = function internal() {};
Orders.prototype.internal.metadata = { options: { a: {} } };

const plugin = {
  metadata: {
    name: 'Acme Shop',
    alias: 'acmeshop',
    description: 'Orders from the Acme shop',
    categories: 'commerce,orders',
    logo: 'https://acme.example/logo.png',
    publisher: { name: 'Acme', url: 'https://acme.example' },
    dependencies: { '@engine9/schemas/person': '>=1.9.0' },
    unique: true,
    prefix: 'nope'
  },
  credentials: {
    fields: [
      { name: 'shop_id', label: 'Shop ID', required: true },
      { name: 'api_key', label: 'API key', type: 'password', required: true },
      { name: 'region', label: 'Region', values: ['us', 'eu'], default: 'us' }
    ]
  },
  settings: [{ name: 'late_days', type: 'int', default: 7, min: 1 }],
  Orders,
  status() {}
};

test('buildPluginCatalogEntry: the published surface of a plugin module', () => {
  const entry = buildPluginCatalogEntry({ path: 'acme-plugins/shop', plugin, packageVersion: '1.4.0' });
  assert.equal(entry.$schema, PLUGIN_CATALOG_SCHEMA_URL);
  assert.equal(entry.catalog_version, 1);
  assert.deepEqual(entry.package, { name: 'acme-plugins', version: '1.4.0' });
  assert.equal(entry.name, 'Acme Shop');
  assert.deepEqual(entry.categories, ['commerce', 'orders']);
  assert.deepEqual(entry.publisher, { name: 'Acme', url: 'https://acme.example' });
  assert.equal(entry.unique, undefined, 'install internals stay out');
  assert.equal(entry.prefix, undefined);

  const [shopId, apiKey, region] = entry.credentials.fields;
  assert.deepEqual(shopId, { name: 'shop_id', type: 'string', label: 'Shop ID', required: true, secret: false });
  assert.equal(apiKey.secret, true);
  assert.equal(region.type, 'select');
  assert.deepEqual(region.values, ['us', 'eu']);

  assert.deepEqual(entry.settings, [{ name: 'late_days', type: 'integer', default: 7, min: 1 }]);
  assert.deepEqual(Object.keys(entry.submodules), ['Orders']);
  assert.deepEqual(Object.keys(entry.submodules.Orders.methods), ['syncOrders'], 'only catalog_methods are published');
  assert.deepEqual(entry.submodules.Orders.methods.syncOrders.options, {
    since: { type: 'date', description: 'Start date' },
    page: {}
  });
  assert.deepEqual(validatePluginCatalogEntry(entry), { ok: true, errors: [], warnings: [] });
});

test('buildPluginCatalogEntry: legacy metadata.auth_fields, untyped fields are passwords', () => {
  const entry = buildPluginCatalogEntry({
    path: 'acme-plugins/crm',
    packageVersion: '1.0.0',
    publisher: 'Acme Inc <dev@acme.example> (https://acme.example)',
    plugin: { metadata: { name: 'Acme CRM', auth_fields: { token: { label: 'Token' }, user: { label: 'User', type: 'string' } } } }
  });
  assert.deepEqual(entry.publisher, { name: 'Acme Inc', url: 'https://acme.example', email: 'dev@acme.example' });
  assert.deepEqual(entry.credentials.fields, [
    { name: 'token', type: 'password', label: 'Token', secret: true },
    { name: 'user', type: 'string', label: 'User', secret: false }
  ]);
});

test('catalogMethodsOf: a listed method without metadata is published with none', () => {
  function W() {}
  W.prototype.ping = function ping() {};
  W.prototype.hidden = function hidden() {};
  W.prototype.hidden.metadata = { display: false };
  assert.deepEqual(catalogMethodsOf(W, ['ping', 'hidden', 'missing']), { ping: {} });
});

test('validatePluginCatalogEntry: reports what is wrong', () => {
  const entry = buildPluginCatalogEntry({ path: 'acme-plugins/shop', plugin, packageVersion: '1.4.0' });
  const bad = {
    ...entry,
    package: { name: 'other', version: 'latest' },
    metadata: {},
    credentials: { fields: [{ name: 'api_key', type: 'password', default: 'x' }] },
    settings: [{ name: 'claude_api_key', type: 'string', secret: true }],
    submodules: { Orders: { settings: [{ name: 'claude_api_key', type: 'string' }] } }
  };
  delete bad.publisher;
  const result = validatePluginCatalogEntry(bad);
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /unknown key "metadata"/);
  assert.match(text, /path must start with package.name/);
  assert.match(text, /package.version/);
  assert.match(text, /publisher/);
  assert.match(text, /a secret field has no default/);
  assert.match(text, /"claude_api_key" is also declared at settings\[0\]/);
  assert.match(result.warnings.join('\n'), /declare it under credentials/);
  assert.equal(validatePluginCatalogEntry({ ...entry, 'x-acme': { anything: true } }).ok, true);
});

test('validatePluginCatalogEntry: icon and at most five screenshots', () => {
  const entry = buildPluginCatalogEntry({
    path: 'acme-plugins/shop',
    plugin: {
      ...plugin,
      metadata: { ...plugin.metadata, icon: '/assets/a.png', screenshots: ['/assets/b.png', { url: 'https://acme.example/c.png', caption: 'Orders' }] }
    },
    packageVersion: '1.4.0'
  });
  assert.equal(entry.icon, '/assets/a.png');
  assert.deepEqual(entry.screenshots, [{ url: '/assets/b.png' }, { url: 'https://acme.example/c.png', caption: 'Orders' }]);
  assert.deepEqual(validatePluginCatalogEntry(entry).errors, []);

  const shot = { url: '/assets/b.png' };
  const text = validatePluginCatalogEntry({
    ...entry,
    icon: 'http://acme.example/a.png',
    screenshots: [shot, shot, shot, shot, shot, { url: 'b.png', alt: 'x', caption: 'y'.repeat(201) }]
  }).errors.join('\n');
  assert.match(text, /icon must be an https URL/);
  assert.match(text, /screenshots: at most 5, not 6/);
  assert.match(text, /screenshots\[5\]: unknown key "alt"/);
  assert.match(text, /screenshots\[5\].url must be an https URL/);
  assert.match(text, /screenshots\[5\].caption must be a string of at most 200/);
});

test('validatePluginCatalogEntry: readme and credentials.instructions are Markdown strings', () => {
  const entry = buildPluginCatalogEntry({
    path: 'acme-plugins/shop',
    plugin: { ...plugin, metadata: { ...plugin.metadata, readme: '# Shop\n\nOrders.' } },
    packageVersion: '1.4.0'
  });
  assert.equal(entry.readme, '# Shop\n\nOrders.');
  const documented = { ...entry, credentials: { ...entry.credentials, instructions: '1. Create a key.' } };
  assert.deepEqual(validatePluginCatalogEntry(documented).errors, []);

  const bad = {
    ...entry,
    readme: 'x'.repeat(README_MAX_LENGTH + 1),
    credentials: { ...entry.credentials, instructions: { steps: [] } }
  };
  const text = validatePluginCatalogEntry(bad).errors.join('\n');
  assert.match(text, /readme is 65537 characters/);
  assert.match(text, /credentials.instructions must be a Markdown string/);
});

test('pluginCredentialsDefinition: a secrets definition, or null', () => {
  const entry = buildPluginCatalogEntry({ path: 'acme-plugins/shop', plugin, packageVersion: '1.4.0' });
  const definition = pluginCredentialsDefinition({
    ...entry,
    credentials: {
      fields: [...entry.credentials.fields, { name: 'old', type: 'string', secret: false, deprecated: true }],
      sections: { api: { label: 'API access' } }
    }
  });
  assert.equal(definition.id, 'acme-plugins/shop');
  assert.equal(definition.label, 'Acme Shop');
  assert.deepEqual(
    definition.fields.map((f) => f.name),
    ['shop_id', 'api_key', 'region']
  );
  assert.equal(pluginCredentialsDefinition({ path: 'a/b', name: 'B' }), null);
});

test('bundlePluginCatalog and pluginCatalogFile', () => {
  const a = { path: 'acme-plugins/b' };
  const b = { path: 'acme-plugins/a' };
  assert.deepEqual(Object.keys(bundlePluginCatalog([a, b])), ['acme-plugins/a', 'acme-plugins/b']);
  assert.throws(() => bundlePluginCatalog([a, a]), /Two catalog entries/);
  assert.equal(pluginCatalogFile('@frakture-com/channelbots/ActBlueBot'), '@frakture-com/channelbots/ActBlueBot.json');
  assert.throws(() => pluginCatalogFile('../etc/passwd'), /not a plugin path/);
});

test('plugin settings read both the catalog shape and the older metadata shape', () => {
  const v1 = { settings: [{ name: 'a' }], submodules: { People: { settings: [{ name: 'b' }] } } };
  const legacy = { metadata: { settings: [{ name: 'a' }] }, submodules: { People: { metadata: { settings: [{ name: 'b' }] } } } };
  for (const entry of [v1, legacy]) {
    assert.deepEqual(catalogSettingDefinitions(entry), [{ name: 'a' }, { section: 'People', name: 'b' }]);
  }
});

test('the JSON Schema names the same keys and types as the validator', () => {
  const schema = JSON.parse(readFileSync(new URL('../docs/plugin-catalog.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, PLUGIN_CATALOG_SCHEMA_URL);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...ENTRY_KEYS].sort());
  assert.deepEqual(schema.$defs.field.properties.type.enum, FIELD_TYPES);
  assert.deepEqual(
    ['name', ...Object.keys(schema.$defs.field.properties)].sort(),
    [...FIELD_KEYS].sort()
  );
});

test('core\'s code names no engine9 service host; the schema URL is data in the schema file', () => {
  const root = new URL('..', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (rel.endsWith('.js')) files.push(rel);
    }
  };
  for (const dir of ['lib/', 'bin/', 'auth/', 'api/', 'cloudflare/']) walk(dir);
  const named = files.filter((f) => /[a-z0-9-]+\.engine9\.ai/i.test(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(named, []);
});
