/*
  Account upgrades: what an account needs after a new @engine9/core or
  @engine9/schemas is deployed. PluginWorker.upgrade runs this; `e9core
  upgrade --db`, `e9core upgrade --url` (POST /admin/upgrade inside the
  deployed site), the server's `e9 pluginworker upgrade`, and MCP `plugin`
  upgrade all call it.

  Core declares no upgrades. Plugins do (./declared.js, docs/plugin-upgrades.md).

  0. Window: a database last upgraded with a core older than
     CORE_UPGRADE_FROM is refused before anything runs (./window.js).
  1. Upgrades: the `upgrades` of every @engine9/schemas plugin in the build,
     in order (core plugin first). Each one's shouldUpgrade looks at the
     schema; only then does run() inspect the data and change it. An upgrade
     is safe to re-run after a partial run. A blocked upgrade throws and stops
     the run. An upgrade with `optIn` (a step that removes something code may
     still read) runs only when that option is true; otherwise the run
     reports it as `opt_in` and changes nothing.
  2. Refresh: reinstall every installed @engine9/schemas plugin from the
     deployed package. That adds new tables and columns and refreshes each
     plugin's inbound snapshot. The core plugin goes first (every install
     records itself on its plugin row), then stacks, so a stack that now
     includes a new plugin installs it.

  Any other plugin's upgrades run when it is named (`plugins`, ./plugins.js).

  There is no ledger in the database: every run asks every upgrade again. A
  real run writes one `upgrade` (or `upgrade.plugins`) record to the audit log
  (worker.audit), with what it applied and who ran it (options.actor). Each
  install also records itself on its plugin row.
*/
import { bool } from '../utilities.js';
import { pluginRegistryFor } from '../pluginRegistry.js';
import { CORE_PLUGIN_PATH } from '../corePluginSettings.js';
import { runPluginUpgrades } from './plugins.js';
import { applyUpgrades, isRefreshedByUpgrade, unusedOptions, upgradeSources } from './declared.js';
import { coreWindow } from './window.js';
import { auditUpgrade } from './audit.js';

export { isRefreshedByUpgrade };

const STACKS_PREFIX = '@engine9/schemas/stacks/';

async function schemasVersion(worker) {
  try {
    return (await pluginRegistryFor(worker)?.packageVersion('@engine9/schemas')) || null;
  } catch {
    return null;
  }
}

async function refreshSchemaPlugins(worker, rows, { dryRun, skip }) {
  const refreshable = rows.filter((row) => isRefreshedByUpgrade(row.path) && !skip.has(row.path));
  // The core plugin first: its tables (plugin, setting) are where every other install records itself.
  const rank = (row) => (row.path === CORE_PLUGIN_PATH ? 2 : row.path.startsWith(STACKS_PREFIX) ? 1 : 0);
  refreshable.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
  const skipped = [...skip];
  if (dryRun) return { dry_run: true, plugins: [...new Set(refreshable.map((row) => row.path))], failed: [], ...(skipped.length ? { skipped } : {}) };
  const refreshed = new Set();
  const viaStack = new Set();
  const failed = [];
  for (const row of refreshable) {
    if (viaStack.has(row.path)) continue;
    try {
      const result = await worker.install({ id: row.id, path: row.path, trigger: 'upgrade' });
      refreshed.add(row.path);
      (result.included || []).forEach((p) => {
        viaStack.add(p);
        refreshed.add(p);
      });
    } catch (e) {
      failed.push({ path: row.path, id: row.id, error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) });
    }
  }
  return { plugins: [...refreshed], failed, ...(skipped.length ? { skipped } : {}) };
}

/**
 * options: dry_run (report, change nothing), refresh (default true; false
 * skips the reinstall step), and the options plugins' upgrades declare
 * (opt-in switches such as drop_name_columns, and others such as
 * discard_names). plugins (paths) or failed run only those plugins instead
 * (./plugins.js), with sql for the statements. actor goes on the audit record.
 */
export async function runUpgrades(worker, options = {}) {
  if ((options.plugins != null && [].concat(options.plugins).length) || bool(options.failed, false)) {
    return runPluginUpgrades(worker, options);
  }
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const refresh = bool(options.refresh, true);
  const version = await schemasVersion(worker);
  const rows = await worker.list({ fields: '*' });

  const window = coreWindow(rows.filter((row) => isRefreshedByUpgrade(row.path)));
  if (window.status === 'too_old') {
    return {
      ok: false,
      dry_run: dryRun,
      schemas_version: version,
      window,
      blocked: window.reason,
      upgrades: [],
      refresh: { skipped: true, plugins: [], failed: [] }
    };
  }

  const sources = await upgradeSources(worker, { rows });
  const { upgrades, outsideWindow } = await applyUpgrades(worker, sources, { options, dryRun });
  // Listed again: an upgrade may have installed a plugin.
  const refreshed = refresh
    ? await refreshSchemaPlugins(worker, await worker.list(), { dryRun, skip: outsideWindow })
    : { skipped: true, plugins: [], failed: [] };
  const ok = refreshed.failed.length === 0 && !upgrades.some((u) => u.status === 'blocked');
  const unused = unusedOptions(sources, options);
  if (!dryRun) {
    await auditUpgrade(
      worker,
      'upgrade',
      {
        upgrades: upgrades.filter((u) => u.status === 'applied').map((u) => ({ plugin: u.plugin, id: u.id })),
        refreshed: refreshed.plugins,
        failed: refreshed.failed.map((f) => f.path),
        schemas: version
      },
      options.actor
    );
  }
  return {
    ok,
    dry_run: dryRun,
    schemas_version: version,
    window,
    upgrades,
    refresh: refreshed,
    ...(unused.length ? { unused_options: unused } : {})
  };
}
