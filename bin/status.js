/*
  `e9core status`: does the database match the code that is deployed, and if
  not, what failed and what fixes it. Read-only. Checks are in lib/status;
  docs/status.md lists every check id.

  It uses every source it can reach:

    --db <connection>   the database directly (Node, MySQL, local SQLite)
    --url <site>        GET /api/admin/status inside the deployed site, which
                        compares the database with the deployed bundle; plus
                        a request with the public key, and the key the live
                        page sends
    wrangler            in a Cloudflare project (wrangler.jsonc): the
                        Cloudflare account, the Worker's secrets, and the
                        keys in .env files. When --url is not given or the
                        site refuses the admin key, it also copies the D1
                        schema (d1 export --no-data) plus the rows status
                        reads into a temporary SQLite file and checks that
                        copy against this folder's node_modules. This is the
                        path that works when the API's keys are broken.
*/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSON5 from 'json5';
import PluginWorker from '../lib/PluginWorker.js';
import { summarize } from '../lib/status/index.js';
import { ensureNodePluginRegistry } from './nodePluginRegistry.js';
import { adminKey, callSite, siteEndpoint } from './upgrade.js';
import { readEnvValue, remoteEnvPath } from './setupKeys.js';
import { LEGACY_SCHEMA_FILE } from './setup.js';

const ENV_PUBLIC_KEY = 'E9_PUBLIC_API_KEY';
const ENV_ADMIN_KEY = 'E9_ADMIN_API_KEY';
const REQUIRED_SECRETS = [ENV_ADMIN_KEY, ENV_PUBLIC_KEY, 'SESSION_SECRET'];

function check(area, id, status, title, extra = {}) {
  return { id, area, status, title, ...extra };
}

function defaultExec(args, cwd) {
  return spawnSync('npx', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function output(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** JSON wrangler printed, after any banner lines. */
export function parseWranglerJson(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(s.slice(start));
  } catch {
    return null;
  }
}

/** Cloudflare account ids (32 hex) in `wrangler whoami` output. */
export function accountIdsFromWhoami(text) {
  return [...new Set(String(text || '').match(/\b[0-9a-f]{32}\b/g) || [])];
}

function wranglerProject(cwd, env) {
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;
    const cfg = JSON5.parse(readFileSync(file, 'utf8'));
    const scope = env ? cfg.env?.[env] : cfg;
    const db = scope?.d1_databases?.find((d) => d.binding === 'DB');
    return { cfg, file: name, databaseName: db?.database_name || 'engine9', databaseId: db?.database_id || null };
  }
  return null;
}

/* ---------------------------------------------------------- wrangler */

function accountChecks({ exec, cwd, project, envFlag }) {
  const checks = [];
  const who = exec(['wrangler', 'whoami'], cwd);
  if (!who || who.status !== 0 || /not authenticated|You are not logged in/i.test(output(who))) {
    checks.push(check('account', 'account.logged_in', 'fail', 'Wrangler is not logged in to Cloudflare', { fix: 'npx wrangler login' }));
    return { checks, ok: false };
  }
  const ids = accountIdsFromWhoami(output(who));
  const pinned = project.cfg.account_id || null;
  checks.push(check('account', 'account.logged_in', 'pass', `Wrangler is logged in (${ids.length} account${ids.length === 1 ? '' : 's'})`, { data: { accounts: ids } }));
  if (pinned && ids.length && !ids.includes(pinned)) {
    checks.push(
      check('account', 'account.pinned', 'fail', `account_id ${pinned} in ${project.file} is not an account this login can use`, {
        fix: 'npx wrangler login with a user on that account'
      })
    );
  } else if (!pinned && ids.length > 1) {
    checks.push(
      check('account', 'account.pinned', 'warn', `${ids.length} Cloudflare accounts are reachable and ${project.file} has no account_id`, {
        detail: 'Wrangler may run a command against the wrong account.',
        fix: `Add "account_id": "<the account that owns the database>" to ${project.file}`,
        data: { accounts: ids }
      })
    );
  } else {
    checks.push(check('account', 'account.pinned', 'pass', pinned ? `account_id is pinned (${pinned})` : 'One Cloudflare account is reachable'));
  }
  const info = exec(['wrangler', 'd1', 'info', project.databaseName, ...envFlag], cwd);
  if (!info || info.status !== 0) {
    checks.push(
      check('account', 'account.owns_database', 'fail', `The logged-in account cannot see D1 database "${project.databaseName}"${project.databaseId ? ` (${project.databaseId})` : ''}`, {
        detail: output(info).split('\n').slice(-3).join(' '),
        fix: `Log in to the account that owns it (npx wrangler login), and pin it with account_id in ${project.file}`
      })
    );
    return { checks, ok: false };
  }
  checks.push(check('account', 'account.owns_database', 'pass', `The logged-in account owns D1 database "${project.databaseName}"`));
  return { checks, ok: true };
}

function secretChecks({ exec, cwd, envFlag }) {
  const listed = exec(['wrangler', 'secret', 'list', ...envFlag], cwd);
  const parsed = listed?.status === 0 ? parseWranglerJson(listed.stdout) : null;
  if (!Array.isArray(parsed)) {
    return [check('secrets', 'secrets.list', 'skip', 'Could not list the Worker secrets', { detail: output(listed).split('\n').slice(-2).join(' ') })];
  }
  const names = new Set(parsed.map((s) => s?.name).filter(Boolean));
  const checks = REQUIRED_SECRETS.map((name) =>
    names.has(name)
      ? check('secrets', `secrets.${name}`, 'pass', `${name} is a Worker secret`)
      : check('secrets', `secrets.${name}`, 'warn', `${name} is not a Worker secret`, { fix: 'npx e9core setup-keys --remote' })
  );
  if (names.has('E9_SETUP_TOKEN')) {
    checks.push(
      check('secrets', 'secrets.E9_SETUP_TOKEN', 'warn', 'E9_SETUP_TOKEN is a Worker secret; production does not use it', {
        fix: `npx wrangler secret delete E9_SETUP_TOKEN${envFlag.length ? ` ${envFlag.join(' ')}` : ''}`
      })
    );
  }
  return checks;
}

function legacyFileCheck(cwd) {
  return existsSync(path.join(cwd, LEGACY_SCHEMA_FILE))
    ? check('project', 'schema_file.legacy', 'warn', `${LEGACY_SCHEMA_FILE} is in wrangler's migrations folder`, {
        detail: 'wrangler d1 migrations list shows it as pending forever, and migrations apply re-runs it (table api_key already exists).',
        fix: 'Delete it, or run npx e9core setup, which deletes it'
      })
    : check('project', 'schema_file.legacy', 'pass', `No engine9 schema file in migrations/`);
}

/* Rows status reads. Setting values other than these stay behind: they can be plugin credentials. */
const COPY_QUERIES = [
  ['plugin', 'select * from plugin'],
  [
    'setting',
    "select id, plugin_id, name, case when name in ('default_stack', 'exclude_pii', 'identifier_store_kind') then value else null end as value from setting"
  ],
  ['api_key', 'select id, name, key_hash, scopes, default_role_id, active, expires_at from api_key']
];

function loadCopy(file, schemaSql, tables) {
  const db = new DatabaseSync(file);
  try {
    db.exec(schemaSql);
    for (const [table, rows] of Object.entries(tables)) {
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        db.prepare(`insert or replace into "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`).run(
          ...cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]))
        );
      }
    }
  } finally {
    db.close();
  }
}

async function wranglerCopyStatus({ exec, cwd, project, envFlag, keys, plugins, fixTarget }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'e9-status-'));
  try {
    const exportFile = path.join(dir, 'schema.sql');
    const exported = exec(['wrangler', 'd1', 'export', project.databaseName, '--remote', '--no-data', '--output', exportFile, ...envFlag], cwd);
    if (!exported || exported.status !== 0 || !existsSync(exportFile)) {
      return { checks: [check('database', 'database.copy', 'fail', 'Could not export the D1 schema', { detail: output(exported).split('\n').slice(-3).join(' ') })] };
    }
    const schemaSql = readFileSync(exportFile, 'utf8');
    const present = new Set([...schemaSql.matchAll(/create table (?:if not exists )?[`"[]?([A-Za-z0-9_]+)/gi)].map((m) => m[1]));
    const queries = COPY_QUERIES.filter(([table]) => present.has(table));
    const tables = {};
    if (queries.length) {
      const ran = exec(['wrangler', 'd1', 'execute', project.databaseName, '--remote', '--json', ...envFlag, '--command', queries.map(([, sql]) => sql).join('; ')], cwd);
      const results = ran?.status === 0 ? parseWranglerJson(ran.stdout) : null;
      if (!Array.isArray(results)) {
        return { checks: [check('database', 'database.copy', 'fail', 'Could not read plugin, setting, and api_key rows from D1', { detail: output(ran).split('\n').slice(-3).join(' ') })] };
      }
      queries.forEach(([table], i) => {
        tables[table] = results[i]?.results || [];
      });
    }
    const dbFile = path.join(dir, 'copy.db');
    loadCopy(dbFile, schemaSql, tables);
    ensureNodePluginRegistry({ cwd });
    const worker = new PluginWorker({ accountId: 'status', auth: { database_connection: `sqlite://${dbFile}` } });
    try {
      const report = await worker.status({
        upgrades: 'schema_only',
        keys,
        plugins,
        source: 'wrangler copy',
        fixTarget,
        checks: [check('database', 'database.copy', 'pass', `Checked a copy of D1 "${project.databaseName}" (schema, plugin, setting, api_key) against this folder's node_modules`)]
      });
      return { checks: report.checks, report };
    } finally {
      await worker.destroy();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- url */

async function liveKeyChecks({ url, publicKey, fetchImpl }) {
  const checks = [];
  if (!publicKey) return checks;
  try {
    const res = await fetchImpl(siteEndpoint(url, '/auth/me'), { headers: { authorization: `Bearer ${publicKey}` } });
    const body = await res.json().catch(() => ({}));
    checks.push(
      res.status === 401 && body?.kind === 'api_key'
        ? check('keys', 'keys.live_public', 'fail', `The site refuses the public key from .env (${body.reason})`, { detail: body.hint, fix: 'npx e9core setup-keys --remote' })
        : res.status === 401 && /^unauthorized: \w+_key$/.test(String(body?.error || ''))
          ? check('keys', 'keys.live_public', 'fail', `The site refuses the public key from .env (${body.error})`, { fix: 'npx e9core setup-keys --remote' })
          : check('keys', 'keys.live_public', 'pass', 'The site accepts the public key from .env')
    );
  } catch (e) {
    checks.push(check('keys', 'keys.live_public', 'fail', `Could not reach ${url}`, { detail: String(e.message || e) }));
    return checks;
  }
  try {
    const page = await fetchImpl(url);
    const html = await page.text();
    const sent = [...new Set(html.match(/e9publickey_[A-Za-z0-9_-]+/g) || [])];
    if (sent.length) {
      checks.push(
        sent.includes(publicKey)
          ? check('keys', 'keys.page_matches', 'pass', 'The live page sends the public key in .env')
          : check('keys', 'keys.page_matches', 'warn', 'The live page sends a different public key than .env', {
              detail: 'Checks against .env do not describe what visitors send. Run status where .env has the deployed key, or redeploy.'
            })
      );
    }
  } catch {
    // The page itself is optional; the API probe above already answered.
  }
  return checks;
}

/* ------------------------------------------------------------ render */

const MARK = { pass: '✔', warn: '⚠', fail: '✖', skip: '·' };
const AREAS = ['account', 'project', 'secrets', 'audit', 'database', 'core', 'keys', 'upgrades', 'plugins'];

export function renderStatus(report) {
  const lines = [`engine9 status: ${report.sources.join(' + ')}`];
  if (report.core_version || report.schemas_version) {
    lines.push(`@engine9/core ${report.core_version || '?'}, @engine9/schemas ${report.schemas_version || '?'}`);
  }
  const byArea = new Map();
  for (const c of report.checks) {
    if (!byArea.has(c.area)) byArea.set(c.area, []);
    byArea.get(c.area).push(c);
  }
  const order = [...AREAS.filter((a) => byArea.has(a)), ...[...byArea.keys()].filter((a) => !AREAS.includes(a))];
  for (const area of order) {
    const checks = byArea.get(area);
    lines.push('', area[0].toUpperCase() + area.slice(1));
    const shown = area === 'plugins' ? checks.filter((c) => c.status !== 'pass') : checks;
    for (const c of shown) {
      lines.push(`  ${MARK[c.status] || '?'} ${c.title}`);
      if (c.status !== 'pass' && c.detail) lines.push(`      ${c.detail}`);
      if (c.status !== 'pass' && c.fix) lines.push(`      fix: ${c.fix}`);
    }
    if (area === 'plugins') {
      const plugins = new Set(checks.map((c) => c.plugin));
      const bad = new Set(checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.plugin));
      lines.push(`  ${MARK.pass} ${plugins.size - bad.size} of ${plugins.size} plugins match the code`);
    }
  }
  const { summary } = report;
  lines.push('', `${summary.fail} failed, ${summary.warn} warnings, ${summary.pass} passed${summary.skip ? `, ${summary.skip} skipped` : ''}`);
  return lines.join('\n');
}

/* ----------------------------------------------------------- command */

/**
 * @returns {Promise<object>} the combined report: { ok, summary, sources, checks, ... }
 */
export async function runStatusCommand(args, { cwd = process.cwd(), exec = defaultExec, fetchImpl = fetch } = {}) {
  const env = args.env && args.env !== true ? String(args.env) : undefined;
  const envFlag = env ? ['--env', env] : [];
  const plugins = args.plugin && args.plugin !== true ? String(args.plugin).split(',').map((p) => p.trim()).filter(Boolean) : undefined;
  const url = args.url && args.url !== true ? String(args.url) : undefined;
  const db = args.db && args.db !== true ? String(args.db) : process.env.ENGINE9_DATABASE_CONNECTION;
  const localEnv = readText(path.join(cwd, '.env'));
  const publicKey = readEnvValue(localEnv, ENV_PUBLIC_KEY) || '';
  const sources = [];
  const checks = [];
  let report = null;

  if (db && !url) {
    ensureNodePluginRegistry({ cwd });
    const worker = new PluginWorker({ accountId: args.account || 'client', auth: { database_connection: db } });
    try {
      const keys = {};
      if (publicKey) keys.public = { value: publicKey, source: '.env' };
      const admin = readEnvValue(localEnv, ENV_ADMIN_KEY);
      if (admin) keys.admin = { value: admin, source: '.env' };
      report = await worker.status({ keys, plugins, source: 'database', fixTarget: `--db ${db}`, keysFix: `npx e9core setup-keys --db ${db}` });
      sources.push(`database ${db}`);
      checks.push(...report.checks);
    } finally {
      await worker.destroy();
    }
    return { ...summarize(checks), sources, core_version: report.core_version, schemas_version: report.schemas_version, checks };
  }

  let siteAnswered = false;
  if (url) {
    sources.push(`site ${url}`);
    const key = adminKey({ key: args.key && args.key !== true ? String(args.key) : undefined, target: env, url, cwd });
    try {
      report = await callSite({ url, key, method: 'GET', route: '/admin/status', query: { plugin: plugins?.join(',') }, fetchImpl });
      siteAnswered = true;
      checks.push(...report.checks);
    } catch (e) {
      const refused = e?.body?.kind === 'api_key';
      checks.push(
        check('keys', 'keys.admin_live', 'fail', refused ? `The site refuses the admin key (${e.body.reason})` : `GET /api/admin/status failed`, {
          detail: refused ? e.body.hint : String(e.message || e),
          fix: refused ? 'npx e9core setup-keys --remote' : undefined
        })
      );
    }
    checks.push(...(await liveKeyChecks({ url, publicKey, fetchImpl })));
  }

  const project = args.wrangler === false || args['no-wrangler'] === true ? null : wranglerProject(cwd, env);
  if (project) {
    sources.push(`wrangler (D1 "${project.databaseName}"${env ? `, --env ${env}` : ''})`);
    checks.push(legacyFileCheck(cwd));
    const account = accountChecks({ exec, cwd, project, envFlag });
    checks.push(...account.checks);
    if (account.ok) {
      checks.push(...secretChecks({ exec, cwd, envFlag }));
      if (!siteAnswered) {
        const keys = {};
        if (publicKey) keys.public = { value: publicKey, source: '.env' };
        const admin = readEnvValue(readText(remoteEnvPath(cwd, env)), ENV_ADMIN_KEY);
        if (admin) keys.admin = { value: admin, source: path.basename(remoteEnvPath(cwd, env)) };
        const copied = await wranglerCopyStatus({ exec, cwd, project, envFlag, keys, plugins, fixTarget: url ? `--url ${url}` : '--url <site>' });
        checks.push(...copied.checks);
        report = report || copied.report;
      }
    }
  }

  if (!sources.length) {
    throw new Error('Nothing to check: pass --url <site> or --db <connection>, or run in a folder with wrangler.jsonc');
  }
  return {
    ...summarize(checks),
    sources,
    core_version: report?.core_version || null,
    schemas_version: report?.schemas_version || null,
    checks
  };
}
