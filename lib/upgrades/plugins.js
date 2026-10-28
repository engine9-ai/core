/*
  `e9core upgrade --plugin <path>` and `--failed`: run the named plugins
  only. A named plugin's own upgrades run first (./declared.js), then it is
  reinstalled. It is how a plugin outside @engine9/schemas gets its upgrades
  and schema changes (upgrade never touches those on its own), how to run a
  plugin that only carries upgrades for others (it needs no plugin row), and
  how to debug one install: each plugin reports its diff before and after,
  the step that failed, and the error. `--failed` reinstalls only.

  dry_run reports the diff and changes nothing. sql adds the statements the
  diff would run (SQLite and D1; MySQL builds them through knex at run time).
*/
import { bool, parseJSONValue } from '../utilities.js';
import { pluginRegistryFor, compileRegistryPlugin } from '../pluginRegistry.js';
import { STANDARD_PLUGIN_DEFAULTS } from '../standardPluginDefaults.js';
import { lastInstallOf } from '../installLedger.js';
import { auditUpgrade } from './audit.js';
import { applyUpgrades, unusedOptions, upgradeSources } from './declared.js';
import sqliteDialect from '../sql/dialects/SQLite.js';
import { buildAlterTable, buildCreateTable } from '../sql/sqliteDDL.js';

async function schemaFor(worker, row) {
  if (STANDARD_PLUGIN_DEFAULTS[row.path]) return parseJSONValue(row.schema);
  const registry = pluginRegistryFor(worker);
  if (registry && (await registry.has(row.path))) {
    const compiled = await compileRegistryPlugin(registry, row.path);
    if (compiled?.schema && typeof compiled.schema === 'object') return compiled.schema;
  }
  return parseJSONValue(row.schema);
}

async function diffFor(worker, row) {
  const schema = await schemaFor(worker, row);
  if (!schema) return { tables: [] };
  return worker.diff({ schema, prefix: row.table_prefix ?? '' });
}

/** The statements deploy() would run for a diff, as SQL text with comments for what it cannot show. */
export function sqlForDiff(worker, tables, prefix = '') {
  if (worker.dialect !== sqliteDialect) return null;
  const out = [];
  for (const t of tables) {
    const table = `${t.prefix === false ? '' : prefix}${t.name}`;
    const diffs = Array.isArray(t.differences) ? t.differences : [t.differences];
    if (diffs.includes('missing')) {
      if (t.type === 'view') out.push(`-- create view ${table}`);
      else out.push(...buildCreateTable({ table, columns: t.columns, indexes: t.indexes }).statements);
      continue;
    }
    const plan = buildAlterTable({
      table,
      columns: diffs.includes('columns') ? t.columns || [] : [],
      indexes: diffs.includes('indexes') ? t.indexes || [] : []
    });
    if (plan.rebuild) {
      out.push(
        `-- rebuild ${table}: create a copy with ${plan.rebuildColumns.map((c) => c.name).join(', ')}, copy the rows, drop ${table}, rename the copy (D1 cannot ADD COLUMN with a non-constant default)`
      );
    }
    out.push(...plan.statements);
    for (const s of plan.skipped) out.push(`-- not applied on SQLite: ${table}.${s.column} (${Object.keys(s.differences || {}).join(', ')})`);
  }
  return out;
}

// A plugin table without the last_install columns has no record of failures yet.
async function failedPaths(worker) {
  const { columns } = await worker.describe({ table: 'plugin' });
  if (!columns.some((c) => c.name === 'last_install_status')) return [];
  const { data } = await worker.query({ sql: "select path from plugin where last_install_status='failed'" });
  return (data || []).map((row) => row.path);
}

async function lastInstall(worker, pluginId) {
  const { data } = await worker.query({ sql: 'select * from plugin where id=?', values: [pluginId] });
  return lastInstallOf(data?.[0]);
}

/**
 * options: plugins (paths), failed (every plugin whose last install failed),
 * dry_run, sql, actor (for the audit record), and the options the named
 * plugins' upgrades declare.
 */
export async function runPluginUpgrades(worker, options = {}) {
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const withSql = bool(options.sql, false);
  const named = [].concat(options.plugins || []).flatMap((p) => String(p).split(',')).map((p) => p.trim()).filter(Boolean);
  const paths = [...new Set([...named, ...(bool(options.failed, false) ? await failedPaths(worker) : [])])];
  const rows = await worker.list({ fields: '*' });
  const sources = named.length ? await upgradeSources(worker, { rows, paths: named }) : [];
  const { upgrades, outsideWindow } = sources.length
    ? await applyUpgrades(worker, sources, { options, dryRun })
    : { upgrades: [], outsideWindow: new Set() };
  const plugins = [];
  for (const path of paths) {
    const matches = rows.filter((row) => row.path === path);
    if (!matches.length) {
      // A plugin that only carries upgrades runs without a row.
      if (sources.some((s) => s.path === path && s.upgrades.length)) continue;
      plugins.push({ path, status: 'not_installed', error: `${path} has no plugin row. Install it first.` });
      continue;
    }
    if (outsideWindow.has(path)) {
      const window = upgrades.find((u) => u.plugin === path && u.window)?.window;
      plugins.push({ path, status: 'blocked', error: window?.reason || `${path} is outside its upgrade window` });
      continue;
    }
    for (const row of matches) {
      const entry = { path, id: row.id };
      try {
        const before = await diffFor(worker, row);
        entry.before = before.tables;
        if (withSql) {
          entry.sql = sqlForDiff(worker, before.tables, row.table_prefix ?? '');
          if (entry.sql === null) entry.sql_note = 'SQL text is shown on SQLite and D1 only.';
        }
        if (dryRun) {
          entry.status = before.tables.length ? 'pending' : 'current';
          plugins.push(entry);
          continue;
        }
      } catch (e) {
        entry.status = 'failed';
        entry.step = 'diff';
        entry.error = String(e?.message || e);
        plugins.push(entry);
        continue;
      }
      try {
        const result = await worker.install({ id: row.id, path, trigger: 'upgrade_plugin' });
        entry.status = 'ok';
        if (result?.included?.length) entry.included = result.included;
        if (result?.messages?.length) entry.messages = result.messages;
      } catch (e) {
        entry.status = 'failed';
        entry.error = String(e?.message || e);
        if (e?.code) entry.code = e.code;
        entry.step = (await lastInstall(worker, row.id).catch(() => null))?.step || 'install';
      }
      try {
        entry.after = (await diffFor(worker, row)).tables;
      } catch (e) {
        entry.after_error = String(e?.message || e);
      }
      plugins.push(entry);
    }
  }
  const ok =
    plugins.every((p) => p.status === 'ok' || p.status === 'current' || p.status === 'pending') &&
    !upgrades.some((u) => u.status === 'blocked');
  if (!dryRun) {
    await auditUpgrade(
      worker,
      'upgrade.plugins',
      {
        ...(named.length ? { upgrades: upgrades.filter((u) => u.status === 'applied').map((u) => ({ plugin: u.plugin, id: u.id })) } : {}),
        plugins: plugins.map((p) => ({ path: p.path, status: p.status, ...(p.error ? { error: p.error } : {}) }))
      },
      options.actor
    );
  }
  const unused = named.length ? unusedOptions(sources, options) : [];
  return {
    ok,
    dry_run: dryRun,
    mode: 'plugins',
    ...(named.length ? { upgrades } : {}),
    plugins,
    ...(unused.length ? { unused_options: unused } : {})
  };
}
