/*
  Plugin lifecycle for an Engine9 account.

  SchemaWorker (this class extends it) owns table DDL: standardize / diff / deploy.
  PluginWorker owns plugin rows and install: compile native plugins, table prefixes,
  semver dependencies, versions, optional segment rows, install hooks, stack
  include/exclude, and account bootstrap.

  Path matching uses pluginPaths so legacy `local$@engine9/...` and `@engine9/...`
  are the same plugin; installs always persist the latter.

  Stack include/exclude is loaded at install time (local package or GitHub),
  never baked in as a static list.
*/
import debug$0 from 'debug';
import semver from 'semver';
import SchemaWorker from './SchemaWorker.js';
import { resolvePluginInstallUnique, camelCase, getPluginUUID, getVersionedUUID } from './utilities.js';
import {
  loadStackMetadata,
  DEFAULT_STACK_PATH,
  DEFAULT_GITHUB_INTERFACES_BASE
} from './stackMetadata.js';
import {
  normalizePluginInstallPath,
  pluginPathInList,
  equivalentPluginPaths,
  resolveAvailablePluginPath
} from './pluginPaths.js';
import { isDuplicateKeyError } from './sql/shared.js';

const debug = debug$0('PluginWorker');
const DEFAULT_PLUGIN_SCHEMA_PATH = '@engine9/interfaces/plugin';

function PluginWorker(worker = {}) {
  SchemaWorker.call(this, worker);
  this.defaultStackPath = worker?.defaultStackPath || resolveDefaultStackPath(this);
  this.githubInterfacesBase = worker?.githubInterfacesBase || DEFAULT_GITHUB_INTERFACES_BASE;
  this.pluginSchemaPath = worker?.pluginSchemaPath || DEFAULT_PLUGIN_SCHEMA_PATH;
  this.fetchFn = worker?.fetch || globalThis.fetch;
}
PluginWorker.prototype = Object.create(SchemaWorker.prototype);
PluginWorker.prototype.constructor = PluginWorker;
PluginWorker.metadata = {
  alias: 'plugin'
};

function resolveDefaultStackPath(worker) {
  if (worker?.defaultStackPath) return worker.defaultStackPath;
  const hook = PluginWorker.resolveDefaultStackPath;
  if (typeof hook === 'function') {
    try {
      const resolved = hook(worker.accountId);
      if (resolved) return resolved;
    } catch {
      // fall through
    }
  }
  return DEFAULT_STACK_PATH;
}

function accountScopedPluginId(worker, pluginPath) {
  return getPluginUUID(`engine9.${worker.accountId}`, pluginPath);
}

async function validatePluginDependencies(worker, { pluginPath, dependencies = {} }) {
  if (!dependencies || typeof dependencies !== 'object' || Object.keys(dependencies).length === 0) return;
  const failures = [];
  for (const [dependencyPath, range] of Object.entries(dependencies)) {
    if (!semver.validRange(range)) {
      failures.push(`${dependencyPath} declares invalid version range ${range}`);
      continue;
    }
    const paths = equivalentPluginPaths(dependencyPath);
    const placeholders = paths.map(() => '?').join(',');
    const { data: installed } = await worker.query({
      sql: `select path, deployed_version from plugin where path in (${placeholders})`,
      values: paths
    });
    if (!installed.length) {
      failures.push(`${dependencyPath}@${range} is not installed`);
      continue;
    }
    const satisfied = installed.some(
      (dep) => semver.valid(dep.deployed_version) && semver.satisfies(dep.deployed_version, range)
    );
    if (!satisfied) {
      const installedVersions = installed
        .map((dep) => `${dep.path}@${dep.deployed_version || 'unversioned'}`)
        .join(', ');
      failures.push(`${dependencyPath}@${range} is not satisfied by installed ${installedVersions}`);
    }
  }
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
  const { data } = await this.query(sql);
  return data;
};
PluginWorker.prototype.list.metadata = {
  options: {
    fields: { description: "Omit or leave empty for id, name, and path only; use '*' for all columns." }
  }
};

PluginWorker.prototype.listAvailable = async function () {
  const hook = this.listAvailablePlugins || PluginWorker.listAvailablePlugins;
  if (typeof hook !== 'function') return [];
  const paths = await hook.call(this);
  return Array.isArray(paths) ? paths : [];
};
PluginWorker.prototype.listAvailable.metadata = {
  options: {}
};

PluginWorker.prototype.loadStackMetadata = function loadStackMetadataForWorker(pluginPath) {
  return loadStackMetadata(pluginPath, {
    githubInterfacesBase: this.githubInterfacesBase,
    fetch: this.fetchFn
  });
};

PluginWorker.prototype.aggregatedExcludes = async function aggregatedExcludes() {
  const excludes = [];
  const sources = [];
  let rows = [];
  try {
    ({ data: rows } = await this.query({ sql: 'select path from plugin' }));
  } catch {
    return { excludes, sources };
  }
  for (const row of rows) {
    const metadata = await this.loadStackMetadata(row.path);
    if (!metadata.exclude.length) continue;
    excludes.push(...metadata.exclude);
    sources.push({ path: normalizePluginInstallPath(row.path), exclude: metadata.exclude });
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
  const installed = [];
  try {
    const { data } = await this.query({ sql: 'select path from plugin' });
    installed.push(...(data || []).map((row) => row.path));
  } catch {
    // plugin table may not exist
  }
  for (const pluginPath of pluginPaths) {
    if (pluginPathInList(pluginPath, installed)) continue;
    if (!pluginPathInList(pluginPath, allExcludes)) continue;
    const source = allSources.find((s) => pluginPathInList(pluginPath, s.exclude));
    const by = source?.path || 'an installed plugin';
    throw new Error(`Cannot install ${pluginPath}: excluded by ${by}`);
  }
};

async function resolveInstallPath(worker, opts) {
  const resolved = { ...opts };
  if (resolved.path != null && String(resolved.path).trim() !== '') {
    const trimmed = normalizePluginInstallPath(String(resolved.path).trim());
    const available = await worker.listAvailable();
    if (available.includes(trimmed)) {
      resolved.path = trimmed;
    } else if (!trimmed.startsWith('@') && !trimmed.startsWith('/')) {
      if (!available.length) {
        throw new Error(
          `Cannot resolve shorthand plugin path "${trimmed}": no plugin catalog is available. Pass the full package path (e.g. @engine9/interfaces/... or @engine9/plugins/...).`
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
    resolved.path = opts.defaultStackPath || worker.defaultStackPath || resolveDefaultStackPath(worker);
  }
  return resolved;
}

PluginWorker.prototype.getSettings = async function ({ pluginId }) {
  const { data: settingsArr } = await this.query({
    sql: 'select * from setting where plugin_id=?',
    values: [pluginId]
  });
  return (settingsArr || []).reduce((s, r) => {
    s[r.name] = r.value;
    return s;
  }, {});
};

PluginWorker.prototype.setSetting = async function ({ pluginId, name, value }) {
  await this.insertArray({
    table: 'setting',
    array: [{ plugin_id: pluginId, name, value: value == null ? '' : String(value) }],
    upsert: true
  });
};

PluginWorker.prototype.getNextTablePrefixCounter = async function () {
  const plugin = await this.install({
    id: '00000000-0000-4000-a000-000000000001',
    path: '@engine9/interfaces/plugin',
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
    source,
    remote_plugin_id,
    unique: optionsUnique = false
  } = options;
  const schemaFromOptions = schema;
  if (!rawPluginPath)
    throw new Error("A path is required, either 'local' for an inline plugin, or a path to the root of the plugin");
  const pluginPath =
    type === 'local' && rawPluginPath === 'local' ? 'local' : normalizePluginInstallPath(rawPluginPath);
  if (type === 'local') {
    if (typeof schema === 'string') throw new Error('For local paths, schema must be an object');
    if (!id) throw new Error('For local paths, you must specify an id');
  }
  const standardPluginDefaults = {
    '@engine9/interfaces/person_custom': {
      metadata: { prefix: 'person_custom', name: 'Custom Fields', unique: false }
    },
    '@engine9-testing/sql-plugin-timeline': { metadata: { prefix: 'testing_timeline', name: 'Testing Timeline' } }
  };
  let pluginConfiguration = null;
  if (standardPluginDefaults[pluginPath]) {
    pluginConfiguration = standardPluginDefaults[pluginPath];
  } else {
    try {
      pluginConfiguration = await this.compilePlugin({ path: pluginPath, source });
    } catch (e) {
      const missingImport = e?.code === 'MODULE_NOT_FOUND' || e?.code === 'ERR_MODULE_NOT_FOUND';
      if (pluginPath?.startsWith('@engine9/interfaces/') && missingImport) {
        pluginConfiguration = standardPluginDefaults[pluginPath] || {};
      } else {
        throw e;
      }
    }
  }
  const segmentsForDeploy =
    pluginConfiguration?.segments && typeof pluginConfiguration.segments === 'object'
      ? pluginConfiguration.segments
      : null;
  const pluginVersion = pluginConfiguration?.metadata?.version;
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
  if (!id && unique && pluginPath && type !== 'local' && !pluginPath.startsWith('@engine9/interfaces/')) {
    id = accountScopedPluginId(this, pluginPath);
  }
  const pathAliases = equivalentPluginPaths(pluginPath);
  let installedPlugins = [];
  if (unique && pluginPath) {
    const placeholders = pathAliases.map(() => '?').join(',');
    ({ data: installedPlugins } = await this.query({
      sql: `select * from plugin where path in (${placeholders}) order by created_at`,
      values: pathAliases
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
  let prefix = installedPlugins[0]?.table_prefix;
  if (installedPlugins.length === 0) {
    if (pluginPath == '@engine9/interfaces/plugin') {
      prefix = '';
    } else if (pluginConfiguration?.metadata?.prefix) {
      const counter = await this.getNextTablePrefixCounter({ path: pluginPath });
      const p = pluginConfiguration.metadata.prefix;
      prefix = `${p}_${counter}_`;
      schema = schema || pluginConfiguration.schema;
    } else if (pluginPath.indexOf('@engine9/interfaces') === 0) {
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
    if (pluginVersion) plugin.deployed_version = pluginVersion;
    if (typeof schema === 'object') plugin.schema = schema;
    try {
      const insertablePlugin = {};
      Object.entries(plugin).forEach(([k, v]) => {
        if (v === undefined) return;
        insertablePlugin[k] = v && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      await this.insertArray({ table: 'plugin', array: [insertablePlugin] });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const placeholders = pathAliases.map(() => '?').join(',');
      const { data: existing } = await this.query({
        sql: unique
          ? `select * from plugin where id=? or path in (${placeholders}) order by created_at`
          : 'select * from plugin where id=?',
        values: unique ? [plugin.id, ...pathAliases] : [plugin.id]
      });
      if (!existing.length) throw err;
      plugin = existing[0];
      prefix = plugin.table_prefix;
      if (unique && plugin.path !== pluginPath) {
        await this.query({
          sql: 'update plugin set path=? where id=?',
          values: [pluginPath, plugin.id]
        });
        plugin.path = pluginPath;
      }
    }
  }
  plugin.tablePrefix = prefix;
  delete plugin.table_prefix;
  if (!schema && pluginConfiguration?.schema) schema = pluginConfiguration.schema;
  if (schema && (installedPlugins.length === 0 || schemaFromOptions)) {
    await this.deploy({ schema, prefix });
  }
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
  if (typeof pluginConfiguration?.install === 'function') {
    const m = await pluginConfiguration.install({
      sqlWorker: this,
      account: {
        id: this.accountId,
        name: this.accountName
      },
      plugin
    });
    if (m.message) plugin.messages = [m.message];
  }
  if (pluginVersion && plugin.id) {
    await this.query({
      sql: 'update plugin set deployed_version=? where id=?',
      values: [pluginVersion, plugin.id]
    });
    plugin.deployed_version = pluginVersion;
  }
  await camelCase.init();
  return camelCase(plugin);
};

PluginWorker.prototype.install = async function (opts = {}) {
  const resolved = await resolveInstallPath(this, opts);
  const pluginPath = resolved.path;
  if (!pluginPath) throw new Error('path is required');
  const installing = resolved._installing || new Set();
  const normalizedPath = normalizePluginInstallPath(pluginPath);
  if (installing.has(normalizedPath)) {
    throw new Error(`Plugin include cycle: ${[...installing, normalizedPath].join(' -> ')}`);
  }

  try {
    await this.describe({ table: 'plugin' });
  } catch (e) {
    if (e?.code !== 'DOES_NOT_EXIST') throw e;
    await this.deploy({ schema: this.pluginSchemaPath });
  }

  const metadata = await this.loadStackMetadata(pluginPath);
  const proposed = [normalizedPath, ...metadata.include];
  await this.assertNotExcluded(proposed, {
    extraExclude: metadata.exclude,
    extraSource: normalizedPath
  });

  const nextInstalling = new Set(installing);
  nextInstalling.add(normalizedPath);
  const row = await this.installRow({ ...resolved, path: normalizedPath });
  const included = [];
  for (const includePath of metadata.include) {
    const child = await this.install({
      path: includePath,
      unique: true,
      _installing: nextInstalling
    });
    included.push(child?.path || includePath);
  }
  return { ...row, included, path: row.path || normalizedPath };
};
PluginWorker.prototype.install.metadata = {
  options: {
    path: {
      description:
        'Plugin package identity (@engine9/interfaces/..., @engine9/plugins/...) or shorthand resolved via a host-provided listAvailable catalog (e.g. transaction/profile, e9email). Legacy local$ prefix is accepted and stripped. Defaults to the account default stack.'
    },
    source: {
      description:
        'Optional absolute directory, file, or file: URL to load the module from (unpublished checkout). Identity remains path.'
    },
    id: { description: 'Optional ID, may already be installed' },
    unique: {
      description:
        'Reuse an existing plugin row for this path. Interfaces default unique except person_custom; metadata.unique overrides; third-party plugins default false.'
    }
  }
};

PluginWorker.prototype.installStandard = async function (opts = {}) {
  const pathToInstall = opts.path || opts.stack || this.defaultStackPath || resolveDefaultStackPath(this);
  const result = await this.install({ ...opts, path: pathToInstall });
  return { complete: true, path: pathToInstall, installed: [pathToInstall, ...(result.included || [])] };
};
PluginWorker.prototype.installStandard.metadata = {
  options: {
    path: { description: 'Stack (or plugin) path to install. Defaults to the account default stack.' }
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
  const stackPath = options.stack || options.path || resolveDefaultStackPath(this);
  debug(`Deploying stack ${stackPath}`);
  await this.installStandard({ path: stackPath });
  debug('Deployed stack');
  const ensureFolders = this.ensureInstallStandardSegmentFolders || PluginWorker.ensureInstallStandardSegmentFolders;
  if (typeof ensureFolders === 'function') {
    await ensureFolders.call(this, { consolePluginId: consolePlugin.id });
  }
  return { complete: true };
};
PluginWorker.prototype.bootstrapAccount.metadata = {
  options: {
    path: { description: 'Stack path to install after console/workers/forms. Defaults to the account default stack.' }
  }
};

PluginWorker.prototype.deployEmail = async function () {
  await this.bootstrapAccount();
  await this.install({ path: '@engine9/interfaces/message', unique: true });
  await this.install({ path: '@engine9/plugins/e9email', unique: true });
  await this.install({ path: '@engine9/plugins/e9forms', unique: true });
  await this.install({ path: '@engine9/interfaces/channels/email', unique: true });
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
export { DEFAULT_PLUGIN_SCHEMA_PATH, DEFAULT_STACK_PATH };
