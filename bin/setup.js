/**
 * One-command engine9 database and Worker setup (`npx e9core setup`).
 *
 * Recommended (same platform — content + API together):
 *
 *   Cloudflare:
 *     npx wrangler login
 *     npm install @engine9/core
 *     npx e9core setup
 *     npx wrangler dev
 *
 *   Node.js:
 *     npx e9core setup --node
 *     npx e9core serve
 *
 *   Then open the /setup URL that `npx e9core serve` prints.
 *
 * Production Cloudflare: npx e9core setup --remote
 *
 * The command writes wrangler.jsonc (including the D1 database id), .env,
 * .gitignore, migrations/0001_engine9.sql, and engine9.db. Do not paste ids
 * into those files. Do not add .dev.vars.
 *
 * Flags are listed in SETUP_HELP (`npx e9core setup --help`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSON5 from 'json5';
import { getPluginUUID } from '../lib/utilities.js';
import { ensureGitignore, setupKeys } from './setupKeys.js';

const WORKER_MAIN = 'node_modules/@engine9/core/cloudflare/worker.js';
const PLUGINS_MODULE = 'engine9.plugins.js';
/* Same table as cloudflare/README.md "Bundler aliases". */
const WORKER_ALIASES = {
  '@engine9/input-tools': '@engine9/core/cloudflare/input-tools-shim',
  knex: '@engine9/core/cloudflare/unavailable-module',
  mysql2: '@engine9/core/cloudflare/unavailable-module',
  'mysql2/promise': '@engine9/core/cloudflare/unavailable-module',
  'better-sqlite3': '@engine9/core/cloudflare/unavailable-module',
  'i18n-iso-countries': 'i18n-iso-countries/index.js'
};

export const SETUP_HELP = `Write the engine9 database, config, and .env for a new project.

Recommended: content (HTML/CSS) and engine9 on the same platform.
The first wizard question is where the production site will run.
The wizard and these local commands run on the development machine.
Production Cloudflare deploy is --remote, or the deploy step.

  Cloudflare (production on Cloudflare; develop locally):
    npx wrangler login
    npm install @engine9/core
    npx e9core setup
    npx wrangler dev
    Open the wizard: npx e9core serve  (prints /setup?token=…).

  Your own servers (production on Node.js you run; develop locally):
    npm install @engine9/core
    npx e9core setup --node
    npx e9core serve
    Open the setup URL serve prints. Node serves your pages and /api together.

Production Cloudflare:
  npx e9core setup --remote

Advanced: HTML on one host and the API on another — see docs/deploy.md
(independent hosts). You will need ENGINE9_API on the page and allowed origins.

Options most people use:

  --name <worker>     Worker name. Default: my-site
  --remote            Production database, Cloudflare secrets, and deploy
  --domain <host>     Custom domain. Use together with --remote
  --node              SQLite file and .env only. No Cloudflare (use with serve)

Other flags:

  --d1 <database>     D1 name. Default: engine9
  --no-deploy         With --remote, update the database and secrets but do not deploy
  --refresh-schema    Load tables again. Only safe on an empty database
  --rotate            Replace the API keys and setup token in .env
  --db <url>          sqlite:// file used before the data is copied to D1
                      With --node, mysql://user:pass@host/dbname also works

setup writes wrangler.jsonc (Cloudflare path), .env (including API keys and
E9_SETUP_TOKEN), and the database. It keeps a database id that is already
filled in. It installs knex and better-sqlite3 if they are missing.
Do not add .dev.vars (Wrangler prefers that file over .env).

The HTML wizard and an agent use the same steps. Ask with:
  npx e9core setup --help
Each answer is: npx e9core setup --step <id>
`;

export function parseDatabaseId(text) {
  const match = String(text || '').match(
    /database_id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return match ? match[1] : '';
}

export function findDatabaseId(listText, name) {
  let rows;
  try {
    rows = JSON.parse(listText);
  } catch {
    return parseDatabaseId(listText);
  }
  const list = Array.isArray(rows) ? rows : rows?.result || rows?.d1 || [];
  const hit = list.find((row) => row.name === name || row.database_name === name);
  return hit?.uuid || hit?.database_id || '';
}

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

export function sqlLiteral(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Schema + rows, without PRAGMA/BEGIN lines D1 rejects. */
export function dumpSqliteFile(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const objects = db.prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
    ).all();
    const lines = ['-- generated by e9core setup'];
    for (const obj of objects) {
      if (obj.type === 'table') {
        lines.push(`${obj.sql};`);
        const info = db.prepare(`PRAGMA table_info(${quoteIdent(obj.name)})`).all();
        const colNames = info.map((col) => col.name);
        const rows = db.prepare(`SELECT * FROM ${quoteIdent(obj.name)}`).all();
        for (const row of rows) {
          const cols = colNames.map(quoteIdent).join(', ');
          const vals = colNames.map((name) => sqlLiteral(row[name])).join(', ');
          lines.push(`INSERT INTO ${quoteIdent(obj.name)} (${cols}) VALUES (${vals});`);
        }
      } else if (obj.sql) {
        lines.push(`${obj.sql};`);
      }
    }
    lines.push('');
    return lines.join('\n');
  } finally {
    db.close();
  }
}

export function mergeWranglerConfig(existing, patch) {
  const cfg = existing && typeof existing === 'object' ? { ...existing } : {};
  cfg.name = cfg.name || patch.name;
  cfg.main = cfg.main || WORKER_MAIN;
  cfg.compatibility_date = cfg.compatibility_date || '2026-07-01';
  const flags = new Set(cfg.compatibility_flags || []);
  flags.add('nodejs_compat');
  cfg.compatibility_flags = [...flags];
  cfg.alias = {
    ...(cfg.alias || {}),
    ...WORKER_ALIASES,
    ...(patch.pluginsModule ? { '@engine9/core/plugins/site': patch.pluginsModule } : {})
  };
  const databases = Array.isArray(cfg.d1_databases) ? [...cfg.d1_databases] : [];
  const index = databases.findIndex((db) => db.binding === 'DB' || db.database_name === patch.databaseName);
  const entry = {
    ...(index >= 0 ? databases[index] : {}),
    binding: 'DB',
    database_name: patch.databaseName,
    database_id: patch.databaseId || (index >= 0 ? databases[index].database_id : '')
  };
  if (index >= 0) databases[index] = entry;
  else databases.push(entry);
  cfg.d1_databases = databases;
  cfg.vars = {
    ...(cfg.vars || {}),
    E9_ACCOUNT_ID: patch.accountId,
    E9_PLUGIN_ID: patch.pluginId
  };
  if (patch.domain) {
    const routes = Array.isArray(cfg.routes) ? [...cfg.routes] : [];
    if (!routes.some((route) => route.pattern === patch.domain)) {
      routes.push({ pattern: patch.domain, custom_domain: true });
    }
    cfg.routes = routes;
  }
  return cfg;
}

function readJsonc(file) {
  if (!existsSync(file)) return null;
  return JSON5.parse(readFileSync(file, 'utf8'));
}

function defaultExec(args, cwd) {
  return spawnSync('npx', args, { cwd, encoding: 'utf8' });
}

/** knex and the SQL driver are optional peers. Install them into the site if missing. */
export async function ensureDatabaseDrivers(cwd, dbUrl) {
  const mysql = /^mysql/i.test(String(dbUrl || ''));
  const names = mysql ? ['knex', 'mysql2'] : ['knex', 'better-sqlite3'];
  const missing = [];
  for (const name of names) {
    try {
      await import(name);
    } catch {
      missing.push(name);
    }
  }
  if (!missing.length) return missing;
  const result = spawnSync('npm', ['install', '--save', ...missing], {
    cwd,
    encoding: 'utf8'
  });
  if (!result || result.status !== 0) {
    const detail = (result?.stderr || result?.stdout || '').trim();
    throw new Error(`Could not install ${missing.join(' ')}. ${detail}`.trim());
  }
  return missing;
}

function execOk(result, what) {
  if (!result || result.status !== 0) {
    const detail = (result?.stderr || result?.stdout || '').trim();
    throw new Error(detail || `${what} failed`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

/**
 * @param {{
 *   cwd?: string,
 *   name?: string,
 *   d1?: string,
 *   remote?: boolean,
 *   deploy?: boolean,
 *   domain?: string,
 *   node?: boolean,
 *   db?: string,
 *   rotate?: boolean,
 *   refreshSchema?: boolean,
 *   skipInstall?: boolean,
 *   skipKeys?: boolean,
 *   exec?: (args: string[], cwd: string) => { status: number|null, stdout?: string, stderr?: string }
 * }} options
 */
export async function setup(options = {}) {
  const cwd = options.cwd || process.cwd();
  const exec = options.exec || defaultExec;
  const name = options.name || 'my-site';
  const databaseName = options.d1 || 'engine9';
  const accountId = name;
  const pluginId = getPluginUUID(accountId, 'website');
  const notes = [];
  const wranglerPath = path.join(cwd, 'wrangler.jsonc');
  const statePath = path.join(cwd, '.e9core', 'setup.json');
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {};

  mkdirSync(path.join(cwd, '.e9core'), { recursive: true });
  const gitignorePath = path.join(cwd, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  writeFileSync(
    gitignorePath,
    ensureGitignore(gitignore, ['.env', '.env.*', '!.env.example', '.dev.vars', '.e9core', 'engine9.db', '.wrangler'])
  );

  if (options.node) {
    const db = options.db || 'sqlite://./engine9.db';
    notes.push('Same-platform Node path: database file and .env. Next: npx e9core serve');
    if (!options.skipInstall) {
      const installed = await ensureDatabaseDrivers(cwd, db);
      if (installed.length) notes.push(`Installed ${installed.join(' ')}.`);
      await installLocalDatabase({ cwd, db, pluginId, name });
      notes.push('Created tables in the database.');
    }
    if (!options.skipKeys) {
      await withDatabase(cwd, db, name, async (worker) => {
        const keys = await setupKeys({
          cwd,
          rotate: options.rotate === true,
          skipWrangler: true,
          applySql: async (sql) => {
            await worker.query({ sql });
          }
        });
        notes.push(...keys.notes);
      });
    }
    return { notes, pluginId, databaseId: '' };
  }

  if (options.db && /^mysql/i.test(options.db)) {
    throw new Error('MySQL is the Node path: npx e9core setup --node --db mysql://user:pass@host/dbname');
  }

  let cfg = readJsonc(wranglerPath) || {};
  let databaseId = cfg.d1_databases?.find((db) => db.binding === 'DB')?.database_id || '';
  if (!databaseId || databaseId.includes('PASTE')) databaseId = '';

  if (!databaseId) {
    let createdText = '';
    const created = exec(['wrangler', 'd1', 'create', databaseName], cwd);
    createdText = `${created.stdout || ''}\n${created.stderr || ''}`;
    databaseId = parseDatabaseId(createdText);
    if (!databaseId) {
      const listed = exec(['wrangler', 'd1', 'list', '--json'], cwd);
      const listText = `${listed.stdout || ''}\n${listed.stderr || ''}`;
      databaseId = findDatabaseId(listText, databaseName);
    }
    if (!databaseId) {
      throw new Error(
        `Could not create the D1 database. Log in once with: npx wrangler login\n${createdText.trim()}`
      );
    }
    notes.push(`D1 database "${databaseName}" is ${databaseId}. Saved in wrangler.jsonc.`);
  } else {
    notes.push(`Using the D1 database already in wrangler.jsonc (${databaseId}).`);
  }

  cfg = mergeWranglerConfig(cfg, {
    name,
    databaseName,
    databaseId,
    accountId,
    pluginId,
    domain: options.domain || '',
    pluginsModule: existsSync(path.join(cwd, PLUGINS_MODULE)) ? `./${PLUGINS_MODULE}` : ''
  });
  writeFileSync(wranglerPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const sqlPath = path.join(cwd, 'migrations', '0001_engine9.sql');
  const needLocal = !options.skipInstall && (options.refreshSchema || !state.schemaLocal);
  const needRemote = Boolean(options.remote) && !options.skipInstall
    && (options.refreshSchema || !state.schemaRemote);
  if (needLocal || (needRemote && !existsSync(sqlPath))) {
    const dbUrl = options.db || 'sqlite://./engine9.db';
    const installed = await ensureDatabaseDrivers(cwd, dbUrl);
    if (installed.length) notes.push(`Installed ${installed.join(' ')}.`);
    await installLocalDatabase({ cwd, db: dbUrl, pluginId, name });
    const file = dbUrl.replace(/^sqlite:\/\//, '');
    const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
    mkdirSync(path.dirname(sqlPath), { recursive: true });
    writeFileSync(sqlPath, dumpSqliteFile(abs));
    notes.push('Built migrations/0001_engine9.sql from the local database file.');
  }
  if (needLocal) {
    execOk(
      exec(['wrangler', 'd1', 'execute', databaseName, '--local', '--file', sqlPath], cwd),
      'load local D1'
    );
    state.schemaLocal = true;
    notes.push('Loaded tables into local D1.');
  }
  if (needRemote) {
    execOk(
      exec(['wrangler', 'd1', 'execute', databaseName, '--remote', '--file', sqlPath], cwd),
      'load production D1'
    );
    state.schemaRemote = true;
    notes.push('Loaded tables into production D1.');
  }

  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  if (!options.skipKeys) {
    const keys = await setupKeys({
      cwd,
      d1: databaseName,
      remote: options.remote === true,
      rotate: options.rotate === true
    });
    notes.push(...keys.notes);
  }

  if (options.remote && options.deploy !== false) {
    execOk(exec(['wrangler', 'deploy'], cwd), 'wrangler deploy');
    notes.push('Deployed the Worker.');
  }

  return { notes, pluginId, databaseId };
}

async function withDatabase(cwd, db, name, fn) {
  await ensureDatabaseDrivers(cwd, db);
  const { default: PluginWorker } = await import('../lib/PluginWorker.js');
  const { default: plugins } = await import('../lib/plugins/interfaces.js');
  const worker = new PluginWorker({
    accountId: name,
    auth: { database_connection: db },
    plugins
  });
  try {
    return await fn(worker);
  } finally {
    await worker.destroy();
  }
}

async function installLocalDatabase({ cwd, db, pluginId, name }) {
  await withDatabase(cwd, db, name, async (worker) => {
    await worker.installStandard();
    const { SqlApiKeyStore } = await import('../auth/index.js');
    await new SqlApiKeyStore({ worker }).deploy();
    await worker.query({
      sql: 'INSERT OR IGNORE INTO plugin (id, path, name) VALUES (?, ?, ?)',
      values: [pluginId, 'website', name]
    });
  });
}
