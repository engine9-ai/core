/*
  Upgrades are declared by plugins, never by core. A plugin's default export
  may carry (docs/plugin-upgrades.md is the contract):

    upgrades: [{
      id: 'person_name',               unique in the plugin; status reports upgrade.<id>
      since: '1.10.1',                 the version of the plugin's package that needs it
      description: '…',
      optIn: 'drop_name_columns',      optional: runs only when that option is true
      options: { discard_names: '…' }, optional: the other options run() reads
      shouldUpgrade(ctx),              cheap: the schema snapshot and the plugin and setting rows only
      run(ctx)                         { pending, changed?, plan?, blocked?, … }; ctx.dryRun changes nothing
    }],
    upgradeFrom: '1.9.0'               the oldest version of its package these upgrades bring current (./window.js)

  An upgrade may change tables of any plugin, so one plugin can carry a suite
  of fixes for others. Only `e9core upgrade` and `e9core status` call these
  hooks; installs and requests never do.
*/
import semver from 'semver';
import { bool } from '../utilities.js';
import { pluginRegistryFor, compileRegistryPlugin } from '../pluginRegistry.js';
import { readCorePluginSettings, CORE_PLUGIN_PATH } from '../corePluginSettings.js';
import { createSchemaSnapshot } from '../sql/schemaSnapshot.js';
import { pluginWindow } from './window.js';

const SCHEMAS_PREFIX = '@engine9/schemas/';

/** The main package: `upgrade` checks its upgrades and reinstalls its plugins. Any other plugin is upgraded by naming it. */
export function isRefreshedByUpgrade(pluginPath) {
  return String(pluginPath || '').startsWith(SCHEMAS_PREFIX);
}

/* Options the runner reads itself; everything else belongs to a plugin's upgrades. */
const RUNNER_OPTIONS = new Set(['dry_run', 'dryRun', 'refresh', 'plugins', 'failed', 'sql', 'actor', 'trigger']);

/** A plugin's `upgrades`, checked. Throws on a malformed declaration. */
export function declaredUpgrades(compiled, path) {
  const list = compiled?.upgrades;
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${path}: upgrades must be an array`);
  const ids = new Set();
  list.forEach((u, i) => {
    const where = `${path}: upgrades[${i}]${u?.id ? ` (${u.id})` : ''}`;
    if (!u || typeof u.id !== 'string' || !u.id) throw new Error(`${where} has no id`);
    if (ids.has(u.id)) throw new Error(`${where}: the id is used twice`);
    ids.add(u.id);
    if (typeof u.shouldUpgrade !== 'function') throw new Error(`${where} has no shouldUpgrade function`);
    if (typeof u.run !== 'function') throw new Error(`${where} has no run function`);
    if (u.since != null && !semver.valid(u.since)) throw new Error(`${where}: since ${u.since} is not a version`);
  });
  if (compiled.upgradeFrom != null && !semver.valid(compiled.upgradeFrom)) {
    throw new Error(`${path}: upgradeFrom ${compiled.upgradeFrom} is not a version`);
  }
  return list;
}

/*
  The plugins whose upgrades a run checks, one source per plugin row (a plugin
  installed twice upgrades each row's tables) or one with no row. `paths`
  names them; otherwise every @engine9/schemas plugin in the build, installed
  or not, so an upgrade can find tables its plugin row never recorded. Core
  plugin first, then by path.
*/
export async function upgradeSources(worker, { rows, paths } = {}) {
  const registry = pluginRegistryFor(worker);
  const candidates = paths?.length
    ? paths
    : registry
      ? (await registry.paths()).filter(isRefreshedByUpgrade)
      : [];
  const rank = (p) => (p === CORE_PLUGIN_PATH ? 1 : 0);
  const ordered = [...new Set(candidates)].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  const sources = [];
  for (const path of ordered) {
    if (!registry || !(await registry.has(path))) continue;
    const compiled = await compileRegistryPlugin(registry, path);
    const upgrades = declaredUpgrades(compiled, path);
    if (!upgrades.length && compiled.upgradeFrom == null) continue;
    const pluginRows = (rows || []).filter((r) => r.path === path);
    for (const row of pluginRows.length ? pluginRows : [null]) sources.push({ path, row, compiled, upgrades });
  }
  return sources;
}

export async function upgradeAccount(worker) {
  const { exclude_pii: excludePii } = await readCorePluginSettings(worker);
  return { id: worker.accountId, name: worker.accountName || worker.accountId, excludePii };
}

/** What shouldUpgrade and run receive. */
export function upgradeContext(worker, { snapshot, source, account, options }) {
  const { row, path } = source;
  return {
    sqlWorker: worker,
    snapshot,
    plugin: { id: row?.id ?? null, path, tablePrefix: row?.table_prefix ?? '', installed: Boolean(row) },
    account,
    options
  };
}

export function describeUpgrade(source, upgrade) {
  return {
    id: upgrade.id,
    plugin: source.path,
    ...(source.row ? { plugin_id: source.row.id } : {}),
    ...(upgrade.since ? { since: upgrade.since } : {}),
    description: upgrade.description || '',
    ...(upgrade.optIn ? { opt_in: upgrade.optIn } : {})
  };
}

/** Truthy options no runner or upgrade in `sources` reads (a misspelled opt-in does nothing). */
export function unusedOptions(sources, options = {}) {
  const known = new Set(RUNNER_OPTIONS);
  for (const { upgrades } of sources) {
    for (const u of upgrades) {
      if (u.optIn) known.add(u.optIn);
      Object.keys(u.options || {}).forEach((k) => known.add(k));
    }
  }
  return Object.keys(options).filter((k) => !known.has(k) && bool(options[k], false));
}

/*
  Run (or dry-run) every upgrade of every source, in order. shouldUpgrade
  decides first; a false answer is `current` and run() is not called. An
  opt-in upgrade whose option is not set dry-runs and reports `opt_in`. A
  plugin outside its upgrade window reports `blocked` and runs nothing. In a
  real run, run() throws when it is blocked and the run stops there.
*/
export async function applyUpgrades(worker, sources, { options = {}, dryRun = false } = {}) {
  let snapshot = await createSchemaSnapshot(worker);
  const account = await upgradeAccount(worker);
  const upgrades = [];
  const outsideWindow = new Set();
  for (const source of sources) {
    const window = source.row ? pluginWindow(source.row, source.compiled) : null;
    if (window?.status === 'too_old') outsideWindow.add(source.path);
    for (const upgrade of source.upgrades) {
      const base = describeUpgrade(source, upgrade);
      if (window?.status === 'too_old') {
        upgrades.push({ ...base, status: 'blocked', blocked: window.reason, window });
        continue;
      }
      const ctx = upgradeContext(worker, { snapshot, source, account, options });
      if (!(await upgrade.shouldUpgrade(ctx))) {
        upgrades.push({ ...base, status: 'current' });
        continue;
      }
      const skipped = Boolean(upgrade.optIn) && !bool(options[upgrade.optIn], false);
      const result = (await upgrade.run({ ...ctx, dryRun: skipped || dryRun })) || {};
      let status;
      if (skipped) status = result.pending ? 'opt_in' : 'current';
      else if (result.blocked) status = 'blocked';
      else if (dryRun) status = result.pending ? 'pending' : 'current';
      else status = result.changed ? 'applied' : 'current';
      upgrades.push({ ...base, status, ...result });
      if (result.changed) snapshot = await createSchemaSnapshot(worker);
    }
  }
  return { upgrades, outsideWindow };
}
