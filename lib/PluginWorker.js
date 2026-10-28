/*
  Plugin lifecycle for an Engine9 account.

  SchemaWorker (this class extends it) owns table DDL: standardize / diff / deploy.
  PluginWorker owns plugin rows and install: compile native plugins, optional
  metadata.prefix hex table prefixes, host-package semver dependencies, optional
  segment rows, install hooks, stack include/exclude, and account bootstrap.
  Third-party plugins should self-scope table names (acme_blog_*) with an empty
  table_prefix rather than setting metadata.prefix.

  Plugin paths match exactly.

  Stack include/exclude is loaded at install time from the build's plugin
  registry, never baked in as a static list.
*/
import debug$0 from 'debug';
import SchemaWorker from './SchemaWorker.js';
import { bool, resolvePluginInstallUnique, camelCase, getPluginUUID, getVersionedUUID } from './utilities.js';
import { loadStackMetadata, DEFAULT_CORE_SCHEMAS } from './stackMetadata.js';
import { pluginRegistryFor } from './pluginRegistry.js';
import { packageNameOf, resolveAvailablePluginPath } from './pluginPaths.js';
import { isDuplicateKeyError, isMissingTableError } from './sql/shared.js';
import { normalizeInboundSpec } from './peoplePipeline/getInboundTransforms.js';
import {
  getPluginSettings,
  listAccountPluginSettings,
  normalizePluginSettings,
  setPluginSetting,
  settingDefaultValue,
  updateAccountPluginSetting
} from './pluginSettings.js';
import {
  LIMITED_PII_PLUGIN_PATH,
  PLAINTEXT_PII_INSTALL_PATHS,
  readCorePluginSettings,
  resolveDefaultPluginsPath
} from './corePluginSettings.js';
import { pluginDependencyFailures } from './pluginDependencies.js';
import { STANDARD_PLUGIN_DEFAULTS } from './standardPluginDefaults.js';
import { API_KEY_SCHEMA } from '../auth/index.js';
import { pinIdentifierStoreKind } from './id/storeKind.js';
import { runUpgrades } from './upgrades/index.js';
import { runStatus } from './status/index.js';
import { recordInstall, summarizeSchemaChanges } from './installLedger.js';
import { schemaHash } from './schemaHash.js';
import { CORE_VERSION } from './version.js';

const debug = debug$0('PluginWorker');
const DEFAULT_PLUGIN_SCHEMA_PATH = '@engine9/schemas/plugin';

function PluginWorker(worker = {}) {
  SchemaWorker.call(this, worker);
  // Audit log (logging/index.js): plugin installs and schema changes. Hosts pass
  // one; createApi sets its own when the worker has none.
  this.audit = worker?.audit || null;
  this.defaultStackPath = worker?.defaultStackPath || null;
  this.pluginSchemaPath = worker?.pluginSchemaPath || DEFAULT_PLUGIN_SCHEMA_PATH;
}
PluginWorker.prototype = Object.create(SchemaWorker.prototype);
PluginWorker.prototype.constructor = PluginWorker;
PluginWorker.metadata = {
  alias: 'plugin'
};

function accountScopedPluginId(worker, pluginPath) {
  return getPluginUUID(`engine9.${worker.accountId}`, pluginPath);
}

async function packageVersionOf(worker, pluginPath) {
  try {
    return (await pluginRegistryFor(worker)?.packageVersion(packageNameOf(pluginPath))) || null;
  } catch {
    return null;
  }
}

async function validatePluginDependencies(worker, { pluginPath, dependencies = {} }) {
  const failures = await pluginDependencyFailures(worker, { dependencies });
  if (failures.length) {
    throw new Error(`Cannot install ${pluginPath}; unmet plugin dependencies: ${failures.join('; ')}`);
  }
}

function dedupeUniquePluginRows(worker, { pluginPath, installedPlugins, preferredId }) {
  if (installedPlugins.length <= 1) return installedPlugins;
  const preferred =
    (preferredId && installedPlugins.find((p) => p.id === preferredId)) ||
    installedPlugins.find((p) => p.table_prefix) ||
    installedPlugins[0];
  const duplicateIds = installedPlugins.filter((p) => p.id !== preferred.id).map((p) => p.id);
  const idList = duplicateIds.map((id) => worker.escapeValue(id)).join(', ');
  const deleteSql =
    duplicateIds.length === 1
      ? `delete from plugin where id=${worker.escapeValue(duplicateIds[0])};`
      : `delete from plugin where id in (${idList});`;
  throw new Error(
    `Error in plugin table: more than one plugin configured for ${pluginPath} (keep ${preferred.id}). Run to clear invalid plugin(s): ${deleteSql}`
  );
}

PluginWorker.prototype.echo = async function (opts) {
  return {
    echo: true,
    path: 'PluginWorker',
    constructor: this.constructor,
    now: new Date(),
    ...opts
  };
};
PluginWorker.prototype.echo.metadata = {};

PluginWorker.prototype.list = async function (opts = {}) {
  const allFields = String(opts.fields ?? '').trim() === '*';
  const sql = allFields ? 'select * from plugin' : 'select id, name, path from plugin';
  try {
    const { data } = await this.query(sql);
    return data || [];
  } catch (e) {
    // Account warehouse may not be bootstrapped yet (no plugin table).
    if (isMissingTableError(e)) return [];
    throw e;
  }
};
PluginWorker.prototype.list.metadata = {
  options: {
    fields: { description: "Omit or leave empty for id, name, and path only; use '*' for all columns." }
  }
};

/* Plugins this build can install: the registry's paths, unless a host hook overrides. */
PluginWorker.prototype.listAvailable = async function () {
  const hook = this.listAvailablePlugins || PluginWorker.listAvailablePlugins;
  if (typeof hook === 'function') {
    const paths = await hook.call(this);
    return Array.isArray(paths) ? paths : [];
  }
  const registry = pluginRegistryFor(this);
  return registry ? registry.paths() : [];
};
PluginWorker.prototype.listAvailable.metadata = {
  options: {}
};

PluginWorker.prototype.loadStackMetadata = function loadStackMetadataForWorker(pluginPath) {
  return loadStackMetadata(pluginPath, { registry: pluginRegistryFor(this) });
};

PluginWorker.prototype.aggregatedExcludes = async function aggregatedExcludes() {
  const excludes = [];
  const sources = [];
  const rows = await this.list();
  for (const row of rows) {
    const metadata = await this.loadStackMetadata(row.path);
    if (!metadata.exclude.length) continue;
    excludes.push(...metadata.exclude);
    sources.push({ path: row.path, exclude: metadata.exclude });
  }
  return { excludes, sources };
};

PluginWorker.prototype.assertNotExcluded = async function assertNotExcluded(
  pluginPaths,
  { extraExclude = [], extraSource = null } = {}
) {
  const { excludes, sources } = await this.aggregatedExcludes();
  const allExcludes = [...excludes, ...extraExclude];
  const allSources = extraSource ? [...sources, { path: extraSource, exclude: extraExclude }] : sources;
  if (!allExcludes.length) return;
  const installed = (await this.list()).map((row) => row.path);
  for (const pluginPath of pluginPaths) {
    if (installed.includes(pluginPath)) continue;
    if (!allExcludes.includes(pluginPath)) continue;
    const source = allSources.find((s) => s.exclude.includes(pluginPath));
    const by = source?.path || 'an installed plugin';
    throw new Error(`Cannot install ${pluginPath}: excluded by ${by}`);
  }
};

async function resolveInstallPath(worker, opts) {
  const resolved = { ...opts };
  if (resolved.path != null && String(resolved.path).trim() !== '') {
    const trimmed = String(resolved.path).trim();
    const available = await worker.listAvailable();
    if (available.includes(trimmed)) {
      resolved.path = trimmed;
    } else if (!trimmed.startsWith('@') && !trimmed.startsWith('/')) {
      if (!available.length) {
        throw new Error(
          `Cannot resolve shorthand plugin path "${trimmed}": no plugin catalog is available. Pass the full package path (e.g. @engine9/schemas/... or @engine9/plugins/...).`
        );
      }
      try {
        resolved.path = resolveAvailablePluginPath(trimmed, available);
      } catch {
        resolved.path = trimmed;
      }
    } else {
      resolved.path = trimmed;
    }
  } else {
    resolved.path = opts.defaultStackPath || worker.defaultStackPath || null;
  }
  return resolved;
}

PluginWorker.prototype.getSettings = async function ({ pluginId }) {
  return getPluginSettings(this, { pluginId });
};
PluginWorker.prototype.getSettings.metadata = {
  options: {
    pluginId: { required: true, description: 'Installed plugin UUID' }
  }
};

PluginWorker.prototype.setSetting = async function ({ pluginId, name, value }) {
  return setPluginSetting(this, { pluginId, name, value });
};
PluginWorker.prototype.setSetting.metadata = {
  options: {
    pluginId: { required: true, description: 'Installed plugin UUID' },
    name: { required: true, description: 'Setting name declared by the plugin' },
    value: { description: 'Stored as a string in warehouse setting.value' }
  }
};

/**
 * The host's plugin catalog entry for a path (`{ metadata, submodules, ... }`),
 * or null. The host sets PluginWorker.getPluginCatalogEntry; core has no
 * catalog of its own.
 */
PluginWorker.prototype.getPluginCatalogEntry = async function ({ path } = {}) {
  const hook = PluginWorker.getPluginCatalogEntry;
  if (typeof hook !== 'function') return null;
  return (await hook.call(this, { path })) || null;
};

/**
 * Declared plugin settings (types, descriptions, values, current warehouse
 * value) grouped by installed plugin path, from the plugin catalog entry and
 * the package. For UIs; does not include auth_fields.
 */
PluginWorker.prototype.listSettings = async function (opts = {}) {
  return listAccountPluginSettings(this, opts);
};
PluginWorker.prototype.listSettings.metadata = {
  options: {
    plugin_id: { description: 'Optional installed plugin UUID filter' },
    path: { description: 'Optional plugin path filter' },
    include_hidden: { description: 'Include settings declared with hidden: true (default false)' }
  }
};

PluginWorker.prototype.updateSetting = async function (opts = {}) {
  return updateAccountPluginSetting(this, opts);
};
PluginWorker.prototype.updateSetting.metadata = {
  options: {
    plugin_id: { required: true, description: 'Installed plugin UUID' },
    name: { required: true, description: 'Setting name' },
    value: { description: 'New value; validated against the plugin declaration when present' }
  }
};

/**
 * Insert declared plugin settings that are not already in the warehouse.
 * Does not overwrite operator-changed values. Reinstall adds newly declared names.
 */
async function deployPluginSettings(worker, { pluginId, settings }) {
  if (!pluginId) return;
  const defs = normalizePluginSettings(settings);
  if (!defs.length) return;
  let existing;
  try {
    existing = await worker.getSettings({ pluginId });
  } catch (e) {
    if (e?.code === 'DOES_NOT_EXIST') return;
    throw e;
  }
  for (const def of defs) {
    if (Object.prototype.hasOwnProperty.call(existing, def.name)) continue;
    await worker.setSetting({ pluginId, name: def.name, value: settingDefaultValue(def) });
  }
}

PluginWorker.prototype.getNextTablePrefixCounter = async function () {
  const plugin = await this.install({
    id: '00000000-0000-4000-a000-000000000001',
    path: '@engine9/schemas/plugin',
    name: 'Core Plugin',
    unique: true
  });
  const settings = await this.getSettings({ pluginId: plugin.id });
  let value = parseInt(settings?.table_prefix_counter || 2729, 10);
  value += 1;
  await this.setSetting({ pluginId: plugin.id, name: 'table_prefix_counter', value });
  return value.toString(16);
};

/**
 * Insert/update the plugin row, allocate a table prefix, deploy schema, segments, hooks.
 */
PluginWorker.prototype.installRow = async function installRow(options) {
  let {
    id,
    type,
    path: rawPluginPath,
    name,
    schema,
    remote_plugin_id,
    unique: optionsUnique = false
  } = options;
  const schemaFromOptions = schema;
  if (!rawPluginPath)
    throw new Error("A path is required, either 'local' for an inline plugin, or a path to the root of the plugin");
  const pluginPath = String(rawPluginPath);
  if (type === 'local') {
    if (typeof schema === 'string') throw new Error('For local paths, schema must be an object');
    if (!id) throw new Error('For local paths, you must specify an id');
  }
  let pluginConfiguration = null;
  if (STANDARD_PLUGIN_DEFAULTS[pluginPath]) {
    pluginConfiguration = STANDARD_PLUGIN_DEFAULTS[pluginPath];
  } else {
    // Throws PluginLoadError (PLUGIN_NOT_FOUND, …) when the registry cannot load it.
    pluginConfiguration = await this.compilePlugin({ path: pluginPath });
  }
  const segmentsForDeploy =
    pluginConfiguration?.segments && typeof pluginConfiguration.segments === 'object'
      ? pluginConfiguration.segments
      : null;
  // Snapshot of the inbound people pipeline slots this plugin joins. Validated
  // here so a bad metadata.inbound fails at install, not on the first load.
  // metadata.version is ignored; version is the host npm package version.
  const inbound = normalizeInboundSpec(pluginConfiguration?.metadata?.inbound, {
    path: pluginPath,
    transforms: pluginConfiguration?.transforms
  });
  await validatePluginDependencies(this, {
    pluginPath,
    dependencies: pluginConfiguration?.metadata?.dependencies
  });
  const unique = resolvePluginInstallUnique({
    path: pluginPath,
    metadata: pluginConfiguration?.metadata,
    unique: optionsUnique,
    pluginConfiguration
  });
  if (!id && unique && pluginPath && type !== 'local' && !pluginPath.startsWith('@engine9/schemas/')) {
    id = accountScopedPluginId(this, pluginPath);
  }
  let installedPlugins = [];
  if (unique && pluginPath) {
    ({ data: installedPlugins } = await this.query({
      sql: 'select * from plugin where path=? order by created_at',
      values: [pluginPath]
    }));
  } else if (id) {
    ({ data: installedPlugins } = await this.query({ sql: 'select * from plugin where id=?', values: [id] }));
  }
  if (installedPlugins.length === 0 && id) {
    const { data: byId } = await this.query({ sql: 'select * from plugin where id=?', values: [id] });
    installedPlugins = byId;
  }
  if (unique && installedPlugins.length > 1) {
    installedPlugins = dedupeUniquePluginRows(this, {
      pluginPath,
      installedPlugins,
      preferredId: id
    });
  }
  if (unique && installedPlugins.length === 1 && installedPlugins[0].path !== pluginPath) {
    await this.query({
      sql: 'update plugin set path=? where id=?',
      values: [pluginPath, installedPlugins[0].id]
    });
    installedPlugins[0].path = pluginPath;
  }
  let plugin = installedPlugins[0] || {};
  // MySQL stores empty table_prefix as NULL; null + 'table' => 'nulltable' in JS.
  // Empty table_prefix is the third-party default: put a company+plugin stem in the
  // schema table names themselves (acme_blog_post). metadata.prefix still opts into
  // the hex allocator ({prefix}_{hex}_) for multi-instance installs (person_custom).
  let prefix = installedPlugins[0]?.table_prefix ?? '';
  if (installedPlugins.length === 0) {
    if (pluginPath == '@engine9/schemas/plugin') {
      prefix = '';
    } else if (pluginConfiguration?.metadata?.prefix) {
      const counter = await this.getNextTablePrefixCounter({ path: pluginPath });
      const p = pluginConfiguration.metadata.prefix;
      prefix = `${p}_${counter}_`;
      schema = schema || pluginConfiguration.schema;
    } else if (pluginPath.indexOf('@engine9/schemas') === 0) {
      prefix = '';
    } else if (schemaFromOptions || pluginConfiguration?.schema) {
      // Self-scoped schema: table names already include a stable stem; no allocator.
      prefix = '';
      schema = schema || pluginConfiguration.schema;
    } else if (unique) {
      // Settings-only / metadata-only native plugins (no tables).
      prefix = '';
    } else {
      throw new Error(`Disallowed plugin -- can't create a prefix for ${pluginPath}`);
    }
    const n = name || pluginConfiguration?.metadata?.name || pluginConfiguration?.name || pluginPath.split('/').pop();
    plugin = {
      id: id || getVersionedUUID(),
      path: pluginPath,
      name: n,
      table_prefix: prefix,
      remote_plugin_id
    };
    if (typeof schema === 'object') plugin.schema = schema;
    if (inbound) plugin.transforms = { inbound };
    try {
      const insertablePlugin = {};
      Object.entries(plugin).forEach(([k, v]) => {
        if (v === undefined) return;
        insertablePlugin[k] = v && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      await this.insertArray({ table: 'plugin', array: [insertablePlugin] });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const { data: existing } = await this.query({
        sql: unique ? 'select * from plugin where id=? or path=? order by created_at' : 'select * from plugin where id=?',
        values: unique ? [plugin.id, pluginPath] : [plugin.id]
      });
      if (!existing.length) throw err;
      plugin = existing[0];
      prefix = plugin.table_prefix ?? '';
      if (unique && plugin.path !== pluginPath) {
        await this.query({
          sql: 'update plugin set path=? where id=?',
          values: [pluginPath, plugin.id]
        });
        plugin.path = pluginPath;
      }
    }
  }
  plugin.tablePrefix = prefix ?? '';
  delete plugin.table_prefix;
  if (!schema && pluginConfiguration?.schema) schema = pluginConfiguration.schema;
  const deployedSchema = schema || schemaFromOptions;
  const ledger = {
    trigger: options.trigger || 'install',
    package: packageNameOf(pluginPath),
    version: await packageVersionOf(this, pluginPath),
    core: CORE_VERSION,
    schema_hash: schemaHash(typeof deployedSchema === 'object' ? deployedSchema : null, prefix ?? '')
  };
  const firstInstall = installedPlugins.length === 0;
  let step = 'schema';
  let changes = [];
  try {
    // Always diff/deploy when we have a schema. Skipping on reinstall left accounts
    // with plugin rows but missing tables (e.g. after a partial DROP). deploy() is
    // a no-op when already in sync. schemaFromOptions still forces an explicit
    // local schema even when the package has none.
    if (deployedSchema) {
      const deployed = await this.deploy({ schema: deployedSchema, prefix: prefix ?? '' });
      changes = summarizeSchemaChanges(deployed.changes, prefix ?? '');
    }
    step = 'settings';
    await deployPluginSettings(this, {
      pluginId: plugin.id,
      settings: pluginConfiguration?.settings
    });
    step = 'segments';
    if (
      segmentsForDeploy &&
      !pluginConfiguration?.skipSegmentTableDeploy &&
      !pluginConfiguration?.metadata?.skipSegmentTableDeploy
    ) {
      const deploy = this.deployPluginSegments || PluginWorker.deployPluginSegments;
      if (typeof deploy === 'function') {
        const segOut = await deploy.call(this, {
          pluginPath,
          plugin,
          segments: segmentsForDeploy,
          pluginConfiguration
        });
        if (segOut?.message) plugin.messages = [...(plugin.messages || []), segOut.message];
      }
    }
    step = 'install_hook';
    if (typeof pluginConfiguration?.install === 'function') {
      const m = await pluginConfiguration.install({
        sqlWorker: this,
        account: {
          id: this.accountId,
          name: this.accountName || this.accountId
        },
        plugin
      });
      if (m.message) plugin.messages = [m.message];
    }
    step = 'inbound';
    if (inbound && plugin.id) {
      // Reinstall refreshes the snapshot (rows created before snapshots, or changed slots)
      await this.query({
        sql: 'update plugin set transforms=? where id=?',
        values: [JSON.stringify({ inbound }), plugin.id]
      });
      plugin.transforms = { inbound };
    }
  } catch (e) {
    await recordInstall(this, {
      plugin,
      path: pluginPath,
      ledger: { ...ledger, status: 'failed', step, error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) },
      changes,
      firstInstall
    });
    throw e;
  }
  await recordInstall(this, { plugin, path: pluginPath, ledger: { ...ledger, status: 'ok' }, changes, firstInstall });
  await camelCase.init();
  return camelCase(plugin);
};

PluginWorker.prototype.install = async function (opts = {}) {
  const resolved = await resolveInstallPath(this, opts);
  const pluginPath = resolved.path;
  if (!pluginPath) throw new Error('path is required');
  const installing = resolved._installing || new Set();
  if (installing.has(pluginPath)) {
    throw new Error(`Plugin include cycle: ${[...installing, pluginPath].join(' -> ')}`);
  }

  try {
    await this.describe({ table: 'plugin' });
  } catch (e) {
    if (e?.code !== 'DOES_NOT_EXIST') throw e;
    await this.deploy({ schema: this.pluginSchemaPath });
  }

  const metadata = await this.loadStackMetadata(pluginPath);
  const proposed = [pluginPath, ...metadata.include];
  const { exclude_pii: excludePii } = await readCorePluginSettings(this);
  if (excludePii) {
    const blocked = proposed.find((p) => PLAINTEXT_PII_INSTALL_PATHS.includes(p));
    if (blocked) {
      throw new Error(`Cannot install ${blocked}: excluded by plugin setting exclude_pii`);
    }
  }
  await this.assertNotExcluded(proposed, {
    extraExclude: metadata.exclude,
    extraSource: pluginPath
  });

  const nextInstalling = new Set(installing);
  nextInstalling.add(pluginPath);
  const row = await this.installRow({ ...resolved, path: pluginPath });
  const included = [];
  for (const includePath of metadata.include) {
    const child = await this.install({
      path: includePath,
      unique: true,
      trigger: opts.trigger,
      _installing: nextInstalling
    });
    included.push(child?.path || includePath);
  }
  return { ...row, included, path: row.path || pluginPath };
};
PluginWorker.prototype.install.metadata = {
  options: {
    path: {
      description:
        'Plugin package identity (@engine9/schemas/..., @engine9/plugins/...) or shorthand resolved via listAvailable (e.g. transaction/contact_details, e9email). The plugin must be in a package listed in package.json "engine9.pluginPackages" (or dynamicPluginPackages on Node). Defaults to the account default stack.'
    },
    id: { description: 'Optional ID, may already be installed' },
    unique: {
      description:
        'Reuse an existing plugin row for this path. @engine9/schemas plugins default unique except person_custom; metadata.unique overrides; third-party plugins default false.'
    }
  }
};

async function deployApiKeyTable(worker) {
  await worker.deploy({ schema: API_KEY_SCHEMA });
}

PluginWorker.prototype.installDefaultPlugins = async function (opts = {}) {
  opts = { ...opts, trigger: opts.trigger || 'install_default' };
  const pathToInstall = await resolveDefaultPluginsPath(this, opts);

  if (!pathToInstall) {
    const installed = [];
    for (const schemaPath of DEFAULT_CORE_SCHEMAS) {
      await this.install({ ...opts, path: schemaPath, unique: true });
      installed.push(schemaPath);
    }
    await deployApiKeyTable(this);
    await pinIdentifierStoreKind(this);
    return { complete: true, path: null, installed };
  }

  const result = await this.install({ ...opts, path: pathToInstall });
  await deployApiKeyTable(this);
  await pinIdentifierStoreKind(this);
  return { complete: true, path: pathToInstall, installed: [pathToInstall, ...(result.included || [])] };
};
PluginWorker.prototype.installDefaultPlugins.metadata = {
  options: {
    path: {
      description:
        'Optional stack (or plugin) path to install. When omitted: utilities/limited-pii exclude_pii → limited-pii stack, else warehouse default_stack on @engine9/schemas/plugin, else the published person schema plugins (not the standard stack).'
    },
    stack: {
      description: 'Alias for path (stack or plugin path).'
    }
  }
};

/**
 * Bring this account up to the deployed @engine9/core and @engine9/schemas:
 * the upgrades the @engine9/schemas plugins declare (lib/upgrades), then a
 * reinstall of the installed @engine9/schemas plugins. Run after every
 * deploy. Safe to re-run.
 */
PluginWorker.prototype.upgrade = async function (opts = {}) {
  return runUpgrades(this, opts);
};
PluginWorker.prototype.upgrade.metadata = {
  description:
    'Run after deploying a new @engine9/core or @engine9/schemas. Refuses a database older than the upgrade window, then runs the upgrades the @engine9/schemas plugins declare (each checks the schema with shouldUpgrade before it touches data; an opt-in upgrade runs only with its option), then reinstalls every installed @engine9/schemas plugin (the core plugin first) so new tables, columns, and inbound snapshots are deployed. Safe to re-run. Any other option goes to the upgrades of the plugins: an opt-in switch (e.g. drop_name_columns) or an option an upgrade declares (e.g. discard_names); a dry run lists the opt_in of each upgrade, and unused_options names one no upgrade reads.',
  options: {
    dry_run: { description: 'Report what each upgrade would do without changing anything.' },
    refresh: { description: 'Default true. false skips reinstalling the installed @engine9/schemas plugins.' },
    plugins: {
      description:
        "Run only these plugin paths (comma-separated): each one's own upgrades, then a reinstall. A plugin that only carries upgrades needs no plugin row."
    },
    failed: { description: 'Reinstall only the plugins whose last install failed.' },
    sql: { description: 'With plugins or failed: include the statements each diff would run (SQLite and D1).' }
  }
};

/**
 * Read-only: does this database match the deployed code? Core tables, keys,
 * the upgrade window and pending upgrades, and every installed plugin
 * (lib/status). e9core status, GET /api/admin/status, and the server's
 * `e9 pluginworker status` call it.
 */
PluginWorker.prototype.status = async function (opts = {}) {
  const plugins = opts.plugins ?? opts.plugin;
  return runStatus(this, {
    ...opts,
    plugins: plugins == null ? undefined : [].concat(plugins).flatMap((p) => String(p).split(',')).map((p) => p.trim()).filter(Boolean)
  });
};
PluginWorker.prototype.status.metadata = {
  description:
    'Read-only check that the database matches the deployed code: core tables and triggers, the default stack, the upgrade window, the upgrades plugins declare that apply, and for every installed plugin its code, schema diff, settings, inbound snapshot, dependencies, upgrade window, and last install. Returns { ok, summary, checks }.',
  options: {
    plugin: { description: 'Limit the plugin and upgrade checks to these plugin paths (comma-separated). A plugin that only carries upgrades needs no row.' },
    upgrades: { description: "'dry_run' (default): a dry run of each upgrade whose shouldUpgrade applies. 'schema_only': shouldUpgrade only (a copy with no data rows)." }
  }
};

PluginWorker.prototype.bootstrapAccount = async function bootstrapAccount(options = {}) {
  await this.deploy({ schema: this.pluginSchemaPath });
  const consolePlugin = await this.install({
    id: getPluginUUID('engine9.' + this.accountId, '@engine9/plugins/e9console'),
    path: '@engine9/plugins/e9console',
    name: 'Engine9 Console'
  });
  await this.install({
    id: getPluginUUID('engine9.' + this.accountId, '@engine9/plugins/e9workers'),
    path: '@engine9/plugins/e9workers',
    name: 'Engine9 Workers',
    unique: true
  });
  await this.install({
    id: getPluginUUID('engine9.' + this.accountId, '@engine9/plugins/e9forms'),
    path: '@engine9/plugins/e9forms',
    name: 'Engine9 Forms',
    unique: true
  });
  const excludePii = bool(options.exclude_pii ?? options.excludePii, false);
  if (excludePii) {
    await this.install({ path: LIMITED_PII_PLUGIN_PATH, unique: true });
    const { data } = await this.query({
      sql: 'select id from plugin where path=? limit 1',
      values: [LIMITED_PII_PLUGIN_PATH]
    });
    if (!data[0]?.id) throw new Error(`Failed to install ${LIMITED_PII_PLUGIN_PATH}`);
    await this.setSetting({ pluginId: data[0].id, name: 'exclude_pii', value: true });
  }
  const stackPath = options.stack || options.path || undefined;
  debug(`Deploying stack ${stackPath || 'resolved default plugins'}`);
  await this.installDefaultPlugins(stackPath ? { path: stackPath } : {});
  debug('Deployed stack');
  const ensureFolders = this.ensureInstallStandardSegmentFolders || PluginWorker.ensureInstallStandardSegmentFolders;
  if (typeof ensureFolders === 'function') {
    await ensureFolders.call(this, { consolePluginId: consolePlugin.id });
  }
  return { complete: true, ...(excludePii ? { exclude_pii: true } : {}) };
};
PluginWorker.prototype.bootstrapAccount.metadata = {
  options: {
    path: { description: 'Stack path to install after console/workers/forms. Defaults to the account default stack.' },
    exclude_pii: {
      description:
        'When true, install utilities/limited-pii, set exclude_pii, then installDefaultPlugins (limited-pii stack).'
    }
  }
};

PluginWorker.prototype.deployEmail = async function () {
  await this.bootstrapAccount();
  await this.install({ path: '@engine9/schemas/message', unique: true });
  await this.install({ path: '@engine9/plugins/e9email', unique: true });
  await this.install({ path: '@engine9/plugins/e9forms', unique: true });
  await this.install({ path: '@engine9/schemas/channels/email', unique: true });
  await this.install({ path: '@engine9/plugins/reports/messaging', unique: true });
  return { complete: true };
};
PluginWorker.prototype.deployEmail.metadata = {};

PluginWorker.prototype.getPluginUUID = function ({ namespace, value }) {
  return getPluginUUID(namespace, value);
};
PluginWorker.prototype.getPluginUUID.metadata = {
  options: {
    namespace: {
      required: true,
      description: 'Stable namespace prefix (e.g. engine9.{accountId})'
    },
    value: {
      required: true,
      description: 'Plugin identifier within that namespace (e.g. @engine9/plugins/my-plugin)'
    }
  }
};

export default PluginWorker;
export { DEFAULT_PLUGIN_SCHEMA_PATH, DEFAULT_CORE_SCHEMAS };
export { DEFAULT_STACK_PATH } from './stackMetadata.js';
export {
  CORE_PLUGIN_PATH,
  LIMITED_PII_STACK_PATH,
  LIMITED_PII_PLUGIN_PATH,
  STANDARD_STACK_PATH,
  PLAINTEXT_PII_INSTALL_PATHS,
  isTruthyExcludePii,
  readCorePluginSettings
} from './corePluginSettings.js';

