/*
  Account upgrades: what an account needs after a new @engine9/schemas (or
  core) is deployed. PluginWorker.upgrade runs this; `e9core upgrade --db`,
  `e9core upgrade --url` (POST /admin/upgrade inside the deployed site), the
  server's `e9 pluginworker upgrade`, and MCP `plugin` upgrade all call it.

  1. Each entry in UPGRADES, in order: a data move a schema deploy cannot make
     (deploy only adds tables and columns). An upgrade inspects the database,
     does nothing when the account is already current, installs any plugin it
     needs itself, and is safe to re-run after a partial run. A blocked
     upgrade throws and stops the run. An upgrade with `optIn` (a step that
     removes something code may still read) runs only when that option is
     true; otherwise the run reports it as `opt_in` and changes nothing.
  2. Refresh: reinstall every installed @engine9/schemas plugin from the
     deployed package. That adds new tables and columns and refreshes each
     plugin's inbound snapshot. Stacks go first, so a stack that now includes
     a new plugin installs it.

  The ledger is one `setting` row per upgrade on the @engine9/schemas/plugin
  row, named `upgrade.<id>`, written the first time a real run finds that
  account current. The database is still the source of truth: every run checks
  every upgrade, and the ledger records when and with which @engine9/schemas
  version each account got there.
*/
import { bool } from '../utilities.js';
import { pluginRegistryFor } from '../pluginRegistry.js';
import personName, { dropNameColumns } from './personName.js';

export const UPGRADES = [personName, dropNameColumns];

const CORE_PLUGIN_PATH = '@engine9/schemas/plugin';
const SCHEMAS_PREFIX = '@engine9/schemas/';
const STACKS_PREFIX = '@engine9/schemas/stacks/';
export const LEDGER_PREFIX = 'upgrade.';

async function schemasVersion(worker) {
  try {
    return (await pluginRegistryFor(worker)?.packageVersion('@engine9/schemas')) || null;
  } catch {
    return null;
  }
}

async function readLedger(worker, corePluginId) {
  if (!corePluginId) return {};
  const settings = await worker.getSettings({ pluginId: corePluginId });
  return Object.entries(settings).reduce((ledger, [name, value]) => {
    if (!name.startsWith(LEDGER_PREFIX)) return ledger;
    try {
      ledger[name.slice(LEDGER_PREFIX.length)] = JSON.parse(value);
    } catch {
      ledger[name.slice(LEDGER_PREFIX.length)] = { value };
    }
    return ledger;
  }, {});
}

async function refreshSchemaPlugins(worker, { dryRun }) {
  const rows = (await worker.list()).filter((row) => String(row.path || '').startsWith(SCHEMAS_PREFIX));
  const isStack = (row) => (row.path.startsWith(STACKS_PREFIX) ? 1 : 0);
  rows.sort((a, b) => isStack(b) - isStack(a) || a.path.localeCompare(b.path));
  if (dryRun) return { dry_run: true, plugins: [...new Set(rows.map((row) => row.path))], failed: [] };
  const refreshed = new Set();
  const viaStack = new Set();
  const failed = [];
  for (const row of rows) {
    if (viaStack.has(row.path)) continue;
    try {
      const result = await worker.install({ id: row.id, path: row.path });
      refreshed.add(row.path);
      (result.included || []).forEach((p) => {
        viaStack.add(p);
        refreshed.add(p);
      });
    } catch (e) {
      failed.push({ path: row.path, id: row.id, error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) });
    }
  }
  return { plugins: [...refreshed], failed };
}

/**
 * options: dry_run (report, change nothing), refresh (default true; false
 * skips the reinstall step), each opt-in upgrade's switch (drop_name_columns),
 * plus each upgrade's own options (discard_names).
 */
export async function runUpgrades(worker, options = {}) {
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const refresh = bool(options.refresh, true);
  const version = await schemasVersion(worker);
  const corePluginId = (await worker.list()).find((row) => row.path === CORE_PLUGIN_PATH)?.id || null;
  const ledger = await readLedger(worker, corePluginId);

  const upgrades = [];
  for (const upgrade of UPGRADES) {
    const skipped = upgrade.optIn && !bool(options[upgrade.optIn], false);
    const result = await upgrade.run(worker, skipped ? { ...options, dry_run: true } : options);
    let status;
    if (skipped) status = result.pending ? 'opt_in' : 'current';
    else if (result.blocked) status = 'blocked';
    else if (dryRun) status = result.pending ? 'pending' : 'current';
    else status = result.changed ? 'applied' : 'current';
    const entry = {
      id: upgrade.id,
      since: upgrade.since,
      description: upgrade.description,
      ...(upgrade.optIn ? { opt_in: upgrade.optIn } : {}),
      status,
      ...result
    };
    if (ledger[upgrade.id]) {
      entry.recorded = ledger[upgrade.id];
    } else if (!dryRun && !skipped && corePluginId) {
      entry.recorded = { at: new Date().toISOString(), status, schemas: version };
      await worker.setSetting({
        pluginId: corePluginId,
        name: `${LEDGER_PREFIX}${upgrade.id}`,
        value: JSON.stringify(entry.recorded)
      });
    }
    upgrades.push(entry);
  }

  const refreshed = refresh ? await refreshSchemaPlugins(worker, { dryRun }) : { skipped: true, plugins: [], failed: [] };
  const ok = refreshed.failed.length === 0 && !upgrades.some((u) => u.status === 'blocked');
  return { ok, dry_run: dryRun, schemas_version: version, upgrades, refresh: refreshed };
}
