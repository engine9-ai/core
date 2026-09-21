/**
 * Project-local API key setup for a new Site.
 * Plaintext stays in .env only. Do not write .dev.vars: Wrangler prefers that
 * file and ignores the same names in .env.
 * Only SHA-256 hashes are sent to the database.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateApiKey, hashApiKey } from '../auth/index.js';

export const ENV_ADMIN_KEY = 'E9_ADMIN_API_KEY';
export const ENV_PUBLIC_KEY = 'E9_PUBLIC_API_KEY';
export const ENV_SESSION_SECRET = 'SESSION_SECRET';

const STATE_DIR = '.e9core';
const STATE_FILE = 'keys.json';

export function quoteEnv(value) {
  const s = String(value);
  if (/[\s#"'\\]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function readEnvValue(text, key) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

/** Replace or append KEY=value lines. Keeps comments and unrelated keys. */
export function upsertEnv(text, entries) {
  const lines = text ? String(text).split(/\r?\n/) : [];
  const pending = { ...entries };
  const out = [];
  for (const line of lines) {
    const eq = line.indexOf('=');
    const name = eq > 0 ? line.slice(0, eq).trim() : '';
    if (name && Object.prototype.hasOwnProperty.call(pending, name)) {
      out.push(`${name}=${quoteEnv(pending[name])}`);
      delete pending[name];
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [name, value] of Object.entries(pending)) {
    out.push(`${name}=${quoteEnv(value)}`);
  }
  out.push('');
  return out.join('\n');
}

export function ensureGitignore(text, entries) {
  let body = text ? String(text) : '';
  const missing = entries.filter((entry) => {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^${escaped}\\s*$`, 'm').test(body);
  });
  if (!missing.length) {
    if (!body || body.endsWith('\n')) return body;
    return `${body}\n`;
  }
  if (body && !body.endsWith('\n')) body += '\n';
  if (body && !body.endsWith('\n\n')) body += '\n';
  body += '# local secrets written by e9core setup-keys\n';
  body += `${missing.join('\n')}\n`;
  return body;
}

export function apiKeyInsertSql({ id, name, key, scopes, defaultRoleId = null }) {
  const esc = (s) => String(s).replaceAll("'", "''");
  const roleSql = defaultRoleId ? `'${esc(defaultRoleId)}'` : 'NULL';
  return `INSERT INTO api_key (id, name, key_hash, scopes, default_role_id, active) VALUES ('${id}', '${esc(name)}', '${hashApiKey(key)}', '${esc(JSON.stringify(scopes))}', ${roleSql}, 1);`;
}

function wranglerDotenvOverrides(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name === '.dev.vars' || name.startsWith('.dev.vars.'));
}

function readText(file) {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8');
}

function readState(dir) {
  const file = path.join(dir, STATE_DIR, STATE_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(dir, state) {
  const folder = path.join(dir, STATE_DIR);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function hasWranglerConfig(dir) {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((name) => existsSync(path.join(dir, name)));
}

function wrangler(args, cwd, input) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd,
    encoding: 'utf8',
    input: input ?? undefined
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `wrangler ${args.join(' ')} failed`);
  }
  return result.stdout || '';
}

function makeKey(name, scopes) {
  const key = generateApiKey({ scopes });
  return {
    id: randomUUID(),
    name,
    scopes,
    key,
    sql: apiKeyInsertSql({ id: randomUUID(), name, key, scopes })
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   d1?: string,
 *   remote?: boolean,
 *   rotate?: boolean,
 *   skipWrangler?: boolean
 * }} options
 */
export async function setupKeys(options = {}) {
  const cwd = options.cwd || process.cwd();
  const d1Name = options.d1 || 'engine9';
  const envPath = path.join(cwd, '.env');
  const gitignorePath = path.join(cwd, '.gitignore');
  const existingEnv = readText(envPath);
  const state = readState(cwd);

  const rotate = options.rotate === true;
  let adminKey = rotate ? '' : readEnvValue(existingEnv, ENV_ADMIN_KEY);
  let publicKey = rotate ? '' : readEnvValue(existingEnv, ENV_PUBLIC_KEY);
  let sessionSecret = rotate ? '' : readEnvValue(existingEnv, ENV_SESSION_SECRET);

  const created = { admin: false, public: false, session: false };
  const inserts = [];

  if (!adminKey) {
    const row = {
      id: randomUUID(),
      name: 'site-admin',
      scopes: ['admin'],
      key: generateApiKey({ scopes: ['admin'] })
    };
    row.sql = apiKeyInsertSql(row);
    adminKey = row.key;
    created.admin = true;
    inserts.push(row.sql);
    state.adminId = row.id;
    state.localApplied = false;
    state.remoteApplied = false;
  }
  if (!publicKey) {
    const row = {
      id: randomUUID(),
      name: 'site-public',
      scopes: ['public'],
      key: generateApiKey({ scopes: ['public'] })
    };
    row.sql = apiKeyInsertSql(row);
    publicKey = row.key;
    created.public = true;
    inserts.push(row.sql);
    state.publicId = row.id;
    state.localApplied = false;
    state.remoteApplied = false;
  }
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex');
    created.session = true;
  }

  const entries = {
    [ENV_ADMIN_KEY]: adminKey,
    [ENV_PUBLIC_KEY]: publicKey,
    [ENV_SESSION_SECRET]: sessionSecret
  };

  const envBody = upsertEnv(existingEnv, entries);
  writeFileSync(envPath, envBody);
  writeFileSync(
    gitignorePath,
    ensureGitignore(readText(gitignorePath), ['.env', '.env.*', '!.env.example', '.dev.vars', '.e9core'])
  );

  const examplePath = path.join(cwd, '.env.example');
  if (!existsSync(examplePath)) {
    writeFileSync(
      examplePath,
      [
        '# Filled locally by: npx e9core setup-keys',
        '# wrangler dev and Node both read this file.',
        '# Do NOT add .dev.vars — Wrangler prefers it and ignores these names in .env.',
        '# Production: npx e9core setup-keys --remote copies these to Cloudflare secrets.',
        `${ENV_ADMIN_KEY}=`,
        `${ENV_PUBLIC_KEY}=`,
        `${ENV_SESSION_SECRET}=`,
        ''
      ].join('\n')
    );
  }

  const notes = [];
  const overrides = wranglerDotenvOverrides(cwd);
  if (overrides.length) {
    notes.push(
      `Delete ${overrides.join(', ')}. Wrangler prefers those files over .env, so the keys in .env will not be used.`
    );
  }
  const wranglerReady = !options.skipWrangler && hasWranglerConfig(cwd);

  if (inserts.length && options.applySql) {
    try {
      for (const sql of inserts) {
        await options.applySql(sql);
      }
      state.localApplied = true;
      notes.push('Stored key hashes in the database from --db.');
    } catch (err) {
      state.localApplied = false;
      state.pendingSql = inserts;
      notes.push(`Saved keys in .env, but database insert failed: ${err.message}`);
    }
  } else if (inserts.length && wranglerReady) {
    try {
      for (const sql of inserts) {
        wrangler(['d1', 'execute', d1Name, '--local', '--command', sql], cwd);
      }
      state.localApplied = true;
      notes.push(`Stored key hashes in local D1 database "${d1Name}".`);
    } catch (err) {
      state.localApplied = false;
      state.pendingSql = inserts;
      notes.push(`Saved keys in .env, but local D1 insert failed: ${err.message}`);
    }
  } else if (inserts.length) {
    state.pendingSql = inserts;
    notes.push('No wrangler.jsonc/toml in this folder, so key hashes were not loaded into D1 yet.');
  } else if (state.pendingSql?.length && wranglerReady && !state.localApplied) {
    try {
      for (const sql of state.pendingSql) {
        wrangler(['d1', 'execute', d1Name, '--local', '--command', sql], cwd);
      }
      state.localApplied = true;
      state.pendingSql = [];
      notes.push(`Stored pending key hashes in local D1 database "${d1Name}".`);
    } catch (err) {
      notes.push(`Local D1 insert failed: ${err.message}`);
    }
  }

  if (options.remote) {
    if (!wranglerReady) {
      throw new Error('setup-keys --remote needs wrangler.jsonc or wrangler.toml in this folder.');
    }
    const sqlToApply = inserts.length ? inserts : (state.pendingSql || []);
    if (sqlToApply.length && !state.remoteApplied) {
      for (const sql of sqlToApply) {
        wrangler(['d1', 'execute', d1Name, '--remote', '--command', sql], cwd);
      }
      state.remoteApplied = true;
      notes.push(`Stored key hashes in remote D1 database "${d1Name}".`);
    }
    for (const [name, value] of Object.entries(entries)) {
      wrangler(['secret', 'put', name], cwd, value);
    }
    notes.push('Saved E9_ADMIN_API_KEY, E9_PUBLIC_API_KEY, and SESSION_SECRET as Cloudflare secrets.');
  }

  writeState(cwd, state);

  return {
    created,
    envPath,
    notes,
    reused: !created.admin && !created.public && !created.session
  };
}
