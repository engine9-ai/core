/*
  `e9core status`: does this database match the code that is deployed, and if
  not, what failed and what fixes it. Read-only.

  runStatus compares the database with the build's plugin registry:

    core      plugin, setting, and api_key tables; the core plugin row; the
              modified_at triggers (SQLite and D1); the default stack
    keys      the site keys the caller passes, by hash (never the key)
    upgrades  the upgrade window, then the upgrades plugins declare
              (lib/upgrades/declared.js): shouldUpgrade against the schema,
              and a dry run of each that applies. A schema-only copy
              (`upgrades: 'schema_only'`) stops at shouldUpgrade
    plugins   for every installed plugin row: its code is in the build, its
              schema diff, declared settings, inbound snapshot, dependencies,
              duplicate rows, the last install, whether the code changed since,
              and the plugin's own `status` hook

  The schema is read once (lib/sql/schemaSnapshot.js), so a Worker request
  stays inside its D1 query budget. Callers add what only they can see
  (Cloudflare account, secrets, the audit sink) as `checks`.

  Every check: { id, area, status: pass|warn|fail|skip, title, detail?, fix?,
  plugin?, data? }. `id` is stable; docs/status.md lists them.
*/
import { hashApiKey } from '../../auth/index.js';
import { createSchemaSnapshot } from '../sql/schemaSnapshot.js';
import { pluginRegistryFor, compileRegistryPlugin } from '../pluginRegistry.js';
import { packageNameOf } from '../pluginPaths.js';
import { normalizePluginSettings } from '../pluginSettings.js';
import { normalizeInboundSpec } from '../peoplePipeline/getInboundTransforms.js';
import { pluginDependencyFailures } from '../pluginDependencies.js';
import { resolveDefaultPluginsPath, CORE_PLUGIN_PATH } from '../corePluginSettings.js';
import { DEFAULT_CORE_SCHEMAS } from '../stackMetadata.js';
import { STANDARD_PLUGIN_DEFAULTS } from '../standardPluginDefaults.js';
import { parseJSONValue, resolvePluginInstallUnique, stableStringify } from '../utilities.js';
import { lastInstallOf } from '../installLedger.js';
import { schemaHash } from '../schemaHash.js';
import { isRefreshedByUpgrade, upgradeSources, upgradeAccount, upgradeContext, describeUpgrade } from '../upgrades/declared.js';
import { coreWindow, pluginWindow } from '../upgrades/window.js';
import { CORE_VERSION } from '../version.js';

const STATUSES = new Set(['pass', 'warn', 'fail', 'skip']);
const HOOK_TIMEOUT_MS = 5000;

function check(area, id, status, title, extra = {}) {
  return { id, area, status, title, ...extra };
}

async function selectRows(worker, sql, values) {
  const { data } = await worker.query(values ? { sql, values } : sql);
  return data || [];
}

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- core */

async function expandStack(worker, path, seen = new Set()) {
  if (seen.has(path)) return seen;
  seen.add(path);
  const { include = [] } = await worker.loadStackMetadata(path);
  for (const child of include) await expandStack(worker, child, seen);
  return seen;
}

async function coreChecks(worker, snapshot, rows, fixes) {
  const out = [];
  const missingTables = ['plugin', 'setting', 'api_key'].filter((t) => !snapshot.hasTable(t));
  out.push(
    missingTables.length
      ? check('core', 'core.tables', 'fail', `Missing core table${missingTables.length > 1 ? 's' : ''}: ${missingTables.join(', ')}`, {
          fix: fixes.installDefault
        })
      : check('core', 'core.tables', 'pass', 'plugin, setting, and api_key tables exist')
  );
  const corePlugin = rows.find((r) => r.path === CORE_PLUGIN_PATH);
  out.push(
    corePlugin
      ? check('core', 'core.core_plugin', 'pass', `${CORE_PLUGIN_PATH} is installed`)
      : check('core', 'core.core_plugin', 'fail', `${CORE_PLUGIN_PATH} has no plugin row`, { fix: fixes.installDefault })
  );

  if (snapshot.triggers) {
    const triggerNames = new Set(snapshot.triggers.map((t) => t.name));
    const missing = [];
    for (const table of snapshot.tableNames()) {
      if (snapshot.tableType(table) !== 'table') continue;
      const { columns } = await snapshot.describe({ table });
      for (const c of columns) {
        if (c.name === 'modified_at' && !triggerNames.has(`${table}_modified_at_auto_update`)) missing.push(table);
      }
    }
    out.push(
      missing.length
        ? check('core', 'core.triggers', 'warn', `modified_at is not kept current on ${missing.length} table${missing.length > 1 ? 's' : ''}`, {
            detail: `No <table>_modified_at_auto_update trigger on: ${missing.join(', ')}. An import that stopped partway can leave a table without it.`,
            fix: 'Rebuild the trigger from the table\'s schema plugin: npx e9core sqlite-ddl --schema <plugin path>, then load the trigger with wrangler d1 execute --file',
            data: { tables: missing }
          })
        : check('core', 'core.triggers', 'pass', 'Every modified_at column has its trigger')
    );
  }

  if (snapshot.hasTable('plugin')) {
    try {
      const path = await resolveDefaultPluginsPath(worker);
      const expected = path ? [...(await expandStack(worker, path))] : DEFAULT_CORE_SCHEMAS;
      const installed = new Set(rows.map((r) => r.path));
      const missing = expected.filter((p) => !installed.has(p));
      out.push(
        missing.length
          ? check('core', 'core.default_stack', 'warn', `${missing.length} plugin${missing.length > 1 ? 's' : ''} of the default ${path ? `stack ${path}` : 'plugins'} not installed`, {
              detail: missing.join(', '),
              fix: fixes.installDefault,
              data: { stack: path, missing }
            })
          : check('core', 'core.default_stack', 'pass', path ? `The default stack ${path} is installed` : 'The default plugins are installed')
      );
    } catch (e) {
      out.push(check('core', 'core.default_stack', 'warn', 'Could not read the default stack', { detail: String(e.message || e) }));
    }
  }
  return out;
}

/* ---------------------------------------------------------------- keys */

async function keyChecks(worker, snapshot, keys, fixes) {
  const out = [];
  const entries = Object.entries(keys || {}).filter(([, k]) => k && k.value);
  if (!entries.length) return out;
  if (!snapshot.hasTable('api_key')) {
    return entries.map(([name, k]) =>
      check('keys', `keys.${name}`, 'fail', `The ${name} key cannot be checked: there is no api_key table`, {
        detail: `From ${k.source}.`,
        fix: fixes.keys
      })
    );
  }
  for (const [name, k] of entries) {
    const hash = hashApiKey(k.value);
    const [row] = await selectRows(worker, 'select name, active, expires_at from api_key where key_hash=?', [hash]);
    const data = { source: k.source, key_hash: hash.slice(0, 12) };
    const active = row && (row.active === true || row.active === 1 || row.active === '1');
    const expired = row?.expires_at && new Date(row.expires_at) < new Date();
    if (!row) {
      out.push(
        check('keys', `keys.${name}`, 'fail', `The ${name} key (${k.source}) has no row in api_key`, {
          detail: `Every request with this key is refused with unauthorized: unknown_key. key_hash ${data.key_hash}.`,
          fix: fixes.keys,
          data
        })
      );
    } else if (!active || expired) {
      out.push(
        check('keys', `keys.${name}`, 'fail', `The ${name} key (${k.source}) is ${expired ? 'expired' : 'turned off'} in api_key`, {
          detail: `Row "${row.name}". Requests with this key are refused with unauthorized: ${expired ? 'expired_key' : 'inactive_key'}.`,
          fix: `Use the current key, or rotate: ${fixes.keys} --rotate`,
          data
        })
      );
    } else {
      out.push(check('keys', `keys.${name}`, 'pass', `The ${name} key (${k.source}) is active ("${row.name}")`, { data }));
    }
  }
  return out;
}

/* ------------------------------------------------------------ upgrades */

const kebab = (name) => String(name).replace(/_/g, '-');

function windowCheck(window, fixes) {
  if (window.status === 'too_old') {
    return check('upgrades', 'upgrades.window', 'fail', 'This database is older than this release upgrades', {
      detail: window.reason,
      fix: window.fix,
      data: window
    });
  }
  if (window.status === 'unrecorded') {
    return check('upgrades', 'upgrades.window', 'warn', 'The plugins have no install records, so the database version is unknown', {
      detail: `They were last installed by @engine9/core ${window.last}. This release upgrades databases from ${window.from}, so it can upgrade this one; the upgrade records each install.`,
      fix: fixes.upgrade,
      data: window
    });
  }
  return check('upgrades', 'upgrades.window', 'pass', window.last ? `Last upgraded with @engine9/core ${window.last} (this release upgrades from ${window.from})` : 'No plugins to upgrade yet', { data: window });
}

/* The plugins whose upgrades status checks: the main package's, every installed plugin's, or the named ones. */
async function upgradeSourcePaths(registry, rows, only) {
  if (only) return [...only];
  const main = registry ? (await registry.paths()).filter(isRefreshedByUpgrade) : [];
  return [...new Set([...main, ...rows.map((r) => String(r.path || ''))])];
}

function upgradeCheck(entry, result, mode, fixes) {
  const id = `upgrade.${entry.id}`;
  const fix = isRefreshedByUpgrade(entry.plugin) ? fixes.upgrade : fixes.plugin(entry.plugin);
  const base = { plugin: entry.plugin, ...(entry.plugin_id ? { plugin_id: entry.plugin_id } : {}) };
  const optInFix = entry.opt_in ? `${fix} --${kebab(entry.opt_in)} (only once nothing reads what it removes; add --dry-run first)` : null;
  if (mode === 'schema_only') {
    if (entry.opt_in) return check('upgrades', id, 'skip', `${entry.id}: opt-in (${entry.opt_in}), may apply`, { ...base, detail: entry.description, fix: optInFix });
    return check('upgrades', id, 'warn', `${entry.id}: applies to this schema`, {
      ...base,
      detail: `${entry.description} The copy has no data rows, so the plan is not known.`,
      fix: `${fix} --dry-run`
    });
  }
  const data = result.plan?.length ? { plan: result.plan } : undefined;
  if (entry.opt_in && result.pending) return check('upgrades', id, 'skip', `${entry.id}: opt-in (${entry.opt_in}), not run`, { ...base, detail: entry.description, fix: optInFix, data });
  if (result.blocked) return check('upgrades', id, 'fail', `${entry.id}: blocked`, { ...base, detail: result.blocked, fix: 'Resolve the reason above, then run the upgrade', data });
  if (result.pending) return check('upgrades', id, 'warn', `${entry.id}: pending`, { ...base, detail: entry.description, fix, data });
  return check('upgrades', id, 'pass', `${entry.id}: current`, base);
}

/*
  shouldUpgrade (the schema) decides which upgrades apply; only those dry-run
  against the data. A schema-only copy (mode 'schema_only') stops at
  shouldUpgrade. Upgrades that do not apply fold into one check.
*/
async function upgradeChecks(worker, ctx, mode, fixes) {
  const { registry, snapshot, rows, only } = ctx;
  const out = [];
  if (!only) out.push(windowCheck(coreWindow(rows.filter((r) => isRefreshedByUpgrade(r.path))), fixes));
  let account;
  try {
    account = await upgradeAccount(worker);
  } catch (e) {
    out.push(check('upgrades', 'upgrades.account', 'fail', 'Could not read the account settings upgrades need', { detail: String(e.message || e) }));
    return out;
  }
  let checked = 0;
  for (const path of await upgradeSourcePaths(registry, rows, only)) {
    let sources;
    try {
      sources = await upgradeSources(worker, { rows, paths: [path] });
    } catch (e) {
      out.push(check('upgrades', 'upgrades.declaration', 'fail', `${path}: its upgrades cannot be read`, { plugin: path, detail: String(e.message || e) }));
      continue;
    }
    for (const source of sources) {
      // Outside its window: plugin.upgrade_window reports it, and its upgrades may no longer cover it.
      if (source.row && pluginWindow(source.row, source.compiled)?.status === 'too_old') continue;
      for (const upgrade of source.upgrades) {
        checked += 1;
        const entry = describeUpgrade(source, upgrade);
        const upgradeCtx = upgradeContext(worker, { snapshot, source, account, options: {} });
        try {
          if (!(await withTimeout(Promise.resolve(upgrade.shouldUpgrade(upgradeCtx)), HOOK_TIMEOUT_MS, `${path} ${upgrade.id} shouldUpgrade()`))) continue;
          const result = mode === 'schema_only' ? {} : (await upgrade.run({ ...upgradeCtx, dryRun: true })) || {};
          out.push(upgradeCheck(entry, result, mode, fixes));
        } catch (e) {
          out.push(check('upgrades', `upgrade.${upgrade.id}`, 'fail', `${upgrade.id}: the check failed`, { plugin: path, detail: String(e.message || e) }));
        }
      }
    }
  }
  if (!out.some((c) => c.id.startsWith('upgrade.'))) {
    out.push(check('upgrades', 'upgrades.none', 'pass', checked ? `No upgrades apply (${checked} checked)` : 'No plugin declares upgrades'));
  }
  return out;
}

/* ------------------------------------------------------------- plugins */

function describeDiff(tables, prefix) {
  const failures = [];
  const warnings = [];
  for (const t of tables) {
    const name = `${t.prefix === false ? '' : prefix}${t.name}`;
    const diffs = Array.isArray(t.differences) ? t.differences : [t.differences];
    if (diffs.includes('missing')) {
      failures.push(`table ${name} is missing`);
      continue;
    }
    for (const c of t.columns || []) {
      if (c.differences === 'new') failures.push(`${name}.${c.name} is missing`);
      else warnings.push(`${name}.${c.name} differs (${Object.keys(c.differences || {}).join(', ')})`);
    }
    for (const x of t.indexes || []) {
      const cols = Array.isArray(x.columns) ? x.columns.join(',') : x.columns;
      warnings.push(`${name} is missing ${x.primary ? 'its primary key' : x.unique ? 'unique index' : 'index'} (${cols})`);
    }
  }
  return { failures, warnings };
}

async function pluginHookChecks(worker, compiled, row, base) {
  if (typeof compiled?.status !== 'function') return [];
  try {
    const results = await withTimeout(
      Promise.resolve(compiled.status({ sqlWorker: worker, plugin: { id: row.id, path: row.path, tablePrefix: row.table_prefix ?? '' }, account: { id: worker.accountId, name: worker.accountName || worker.accountId } })),
      HOOK_TIMEOUT_MS,
      `${row.path} status()`
    );
    return (Array.isArray(results) ? results : [])
      .filter((r) => r && r.id)
      .map((r) =>
        check('plugins', `plugin.custom.${r.id}`, STATUSES.has(r.status) ? r.status : 'warn', String(r.title || r.id), {
          ...base,
          ...(r.detail ? { detail: String(r.detail) } : {}),
          ...(r.fix ? { fix: String(r.fix) } : {}),
          ...(r.data ? { data: r.data } : {})
        })
      );
  } catch (e) {
    return [check('plugins', 'plugin.custom.error', 'fail', `${row.path}: its status() hook failed`, { ...base, detail: String(e.message || e) })];
  }
}

async function onePluginChecks(worker, ctx, row) {
  const { registry, snapshot, settingsByPlugin, pathCounts, fixes } = ctx;
  const path = String(row.path || '');
  const base = { plugin: path, plugin_id: row.id };
  const out = [];
  const pluginFix = isRefreshedByUpgrade(path) ? fixes.upgrade : fixes.plugin(path);
  const prefix = row.table_prefix ?? '';

  let compiled = STANDARD_PLUGIN_DEFAULTS[path] || null;
  const inBuild = !compiled && registry ? await registry.has(path) : false;
  if (inBuild) {
    try {
      compiled = await compileRegistryPlugin(registry, path);
    } catch (e) {
      out.push(check('plugins', 'plugin.code_present', 'fail', `${path}: its code is in the build but does not load`, { ...base, detail: String(e.message || e), data: e?.code ? { code: e.code } : undefined }));
      return out;
    }
  }
  const isPackagePath = path.startsWith('@') || path.includes('/');
  if (!compiled && isPackagePath) {
    out.push(
      check('plugins', 'plugin.code_present', 'fail', `${path}: installed, but its code is not in the deployed build`, {
        ...base,
        detail: `The plugin row exists, and nothing can load the plugin. ${registry?.hint?.() || ''}`.trim(),
        fix: `Add ${packageNameOf(path)} to "engine9.pluginPackages" in package.json and redeploy, or remove the plugin row`
      })
    );
    return out;
  }
  if (compiled && isPackagePath) out.push(check('plugins', 'plugin.code_present', 'pass', `${path}: code is in the build`, base));

  const storedSchema = parseJSONValue(row.schema);
  const schema = (compiled?.schema && typeof compiled.schema === 'object' ? compiled.schema : null) || storedSchema;
  if (schema) {
    try {
      const { tables } = await worker.diff({ schema, prefix, snapshot });
      const { failures, warnings } = describeDiff(tables, prefix);
      if (failures.length) {
        const all = [...failures, ...warnings];
        out.push(check('plugins', 'plugin.schema', 'fail', `${path}: ${failures[0]}${all.length > 1 ? ` (and ${all.length - 1} more)` : ''}`, { ...base, ...(all.length > 1 ? { detail: all.join('; ') } : {}), fix: pluginFix, data: { tables } }));
      } else if (warnings.length) {
        out.push(check('plugins', 'plugin.schema', 'warn', `${path}: ${warnings.length} schema difference${warnings.length > 1 ? 's' : ''}`, { ...base, detail: warnings.join('; '), fix: pluginFix, data: { tables } }));
      } else {
        out.push(check('plugins', 'plugin.schema', 'pass', `${path}: tables match its schema`, base));
      }
    } catch (e) {
      out.push(check('plugins', 'plugin.schema', 'fail', `${path}: its schema could not be compared`, { ...base, detail: String(e.message || e) }));
    }
  }

  const settings = settingsByPlugin.get(row.id) || new Map();
  if (compiled) {
    const declared = normalizePluginSettings(compiled.settings).map((d) => d.name);
    const missing = declared.filter((n) => !settings.has(n));
    if (declared.length) {
      out.push(
        missing.length
          ? check('plugins', 'plugin.settings', 'warn', `${path}: ${missing.length} declared setting${missing.length > 1 ? 's have' : ' has'} no row`, { ...base, detail: missing.join(', '), fix: pluginFix })
          : check('plugins', 'plugin.settings', 'pass', `${path}: every declared setting has a row`, base)
      );
    }

    try {
      const expected = normalizeInboundSpec(compiled.metadata?.inbound, { path, transforms: compiled.transforms });
      const stored = parseJSONValue(row.transforms)?.inbound || null;
      if (expected || stored) {
        out.push(
          stableStringify(expected) === stableStringify(stored)
            ? check('plugins', 'plugin.inbound_snapshot', 'pass', `${path}: inbound snapshot matches the code`, base)
            : check('plugins', 'plugin.inbound_snapshot', 'warn', `${path}: the people pipeline uses an older inbound snapshot`, {
                ...base,
                detail: `Stored ${stableStringify(stored)}; the code declares ${stableStringify(expected)}.`,
                fix: pluginFix
              })
        );
      }
    } catch (e) {
      out.push(check('plugins', 'plugin.inbound_snapshot', 'fail', `${path}: metadata.inbound is invalid`, { ...base, detail: String(e.message || e) }));
    }

    const failures = await pluginDependencyFailures(worker, { dependencies: compiled.metadata?.dependencies });
    if (failures.length) {
      out.push(check('plugins', 'plugin.dependencies', 'fail', `${path}: unmet dependencies`, { ...base, detail: failures.join('; ') }));
    }

    const unique = resolvePluginInstallUnique({ path, metadata: compiled.metadata, unique: false, pluginConfiguration: compiled });
    if (unique && pathCounts.get(path) > 1 && !ctx.reportedDuplicates.has(path)) {
      ctx.reportedDuplicates.add(path);
      out.push(check('plugins', 'plugin.duplicates', 'warn', `${path}: ${pathCounts.get(path)} plugin rows for a plugin that installs once`, { ...base, detail: 'Install refuses until the extra rows are removed.' }));
    }
  }

  const last = lastInstallOf(row);
  if (last?.status === 'failed') {
    out.push(
      check('plugins', 'plugin.last_install', 'fail', `${path}: the last install failed${last.step ? ` at ${last.step}` : ''}`, {
        ...base,
        detail: `${last.at || ''} ${last.trigger ? `(${last.trigger}) ` : ''}${last.error || ''}`.trim(),
        fix: `${fixes.plugin(path)} (add --dry-run --sql to see the statements first)`,
        data: last
      })
    );
  } else if (last) {
    out.push(check('plugins', 'plugin.last_install', 'pass', `${path}: last installed ${last.at || ''}`.trim(), { ...base, data: last }));
  }

  if (last && compiled) {
    const nowHash = schemaHash(schema, prefix);
    const version = registry ? await registry.packageVersion(packageNameOf(path)).catch(() => null) : null;
    const reasons = [];
    if (last.schema_hash !== undefined && nowHash !== (last.schema_hash ?? null)) reasons.push('its schema changed');
    if (version && last.version && version !== last.version) reasons.push(`${packageNameOf(path)} is ${version}, installed from ${last.version}`);
    out.push(
      reasons.length
        ? check('plugins', 'plugin.code_changed', 'warn', `${path}: the deployed code changed since the last install`, {
            ...base,
            detail: `${reasons.join('; ')}.${isRefreshedByUpgrade(path) ? '' : ' e9core upgrade does not reinstall plugins outside @engine9/schemas; name it.'}`,
            fix: pluginFix
          })
        : check('plugins', 'plugin.code_changed', 'pass', `${path}: installed from the deployed code`, base)
    );
  }

  const window = compiled ? pluginWindow(row, compiled) : null;
  if (window?.status === 'too_old') {
    out.push(check('plugins', 'plugin.upgrade_window', 'fail', `${path}: older than this build upgrades`, { ...base, detail: window.reason, fix: window.fix, data: window }));
  } else if (window?.status === 'ok') {
    out.push(check('plugins', 'plugin.upgrade_window', 'pass', `${path}: installed from ${window.last}, upgrades from ${window.from}`, { ...base, data: window }));
  }

  out.push(...(await pluginHookChecks(worker, compiled, row, base)));
  return out;
}

/* ------------------------------------------------------------- report */

function fixesFor(target = '--url <site>', keysFix = 'npx e9core setup-keys --remote') {
  return {
    upgrade: `npx e9core upgrade ${target}`,
    plugin: (path) => `npx e9core upgrade --plugin ${path} ${target}`,
    installDefault: `npx e9core installDefaultPlugins ${target}`,
    keys: keysFix
  };
}

/** Totals and `ok` (no failures) for a list of checks. */
export function summarize(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
  return { ok: summary.fail === 0, summary };
}

/**
 * @param {object} worker a PluginWorker
 * @param {{
 *   upgrades?: 'dry_run' | 'schema_only',
 *   keys?: Record<string, { value: string, source: string }>,
 *   checks?: object[],
 *   source?: string,
 *   fixTarget?: string,
 *   keysFix?: string,
 *   plugins?: string[]
 * }} [options] `plugins` limits the plugin checks to those paths.
 */
export async function runStatus(worker, options = {}) {
  const fixes = fixesFor(options.fixTarget, options.keysFix);
  const registry = pluginRegistryFor(worker);
  const snapshot = await createSchemaSnapshot(worker);
  const rows = snapshot.hasTable('plugin') ? await selectRows(worker, 'select * from plugin') : [];
  const checks = [...(options.checks || [])];
  checks.push(...(await coreChecks(worker, snapshot, rows, fixes)));
  checks.push(...(await keyChecks(worker, snapshot, options.keys, fixes)));

  const settingsByPlugin = new Map();
  if (snapshot.hasTable('setting')) {
    for (const s of await selectRows(worker, 'select plugin_id, name, value from setting')) {
      if (!settingsByPlugin.has(s.plugin_id)) settingsByPlugin.set(s.plugin_id, new Map());
      settingsByPlugin.get(s.plugin_id).set(s.name, s.value);
    }
  }
  const pathCounts = new Map();
  for (const r of rows) pathCounts.set(r.path, (pathCounts.get(r.path) || 0) + 1);
  const only = options.plugins?.length ? new Set(options.plugins) : null;
  if (snapshot.hasTable('plugin') && snapshot.hasTable('setting')) {
    checks.push(...(await upgradeChecks(worker, { registry, snapshot, rows, only }, options.upgrades || 'dry_run', fixes)));
  }
  if (only) {
    for (const p of only) {
      if (pathCounts.has(p)) continue;
      // A plugin that only carries upgrades needs no row; its upgrades were checked above.
      if (registry && (await registry.has(p)) && (await upgradeSources(worker, { rows, paths: [p] }).catch(() => [])).some((s) => s.upgrades.length)) continue;
      checks.push(check('plugins', 'plugin.installed', 'fail', `${p} is not installed`, { plugin: p, fix: fixes.plugin(p) }));
    }
  }
  const ctx = { registry, snapshot, settingsByPlugin, pathCounts, fixes, reportedDuplicates: new Set() };
  const sorted = [...rows].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  for (const row of sorted) {
    if (only && !only.has(row.path)) continue;
    checks.push(...(await onePluginChecks(worker, ctx, row)));
  }

  let schemasVersion = null;
  try {
    schemasVersion = (await registry?.packageVersion('@engine9/schemas')) || null;
  } catch {
    schemasVersion = null;
  }
  return {
    ...summarize(checks),
    generated_at: new Date().toISOString(),
    source: options.source || 'database',
    core_version: CORE_VERSION,
    schemas_version: schemasVersion,
    schema_read: snapshot.batched ? 'batched' : 'per_table',
    checks
  };
}
