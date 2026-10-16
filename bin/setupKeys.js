/**
 * Project-local API key setup for a new deployment.
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
export const ENV_SETUP_TOKEN = 'E9_SETUP_TOKEN';
export const ENV_ALLOWED_ORIGINS = 'E9_ALLOWED_ORIGINS';

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

/** Drop named keys. Keeps comments and other lines. */
export function removeEnvKeys(text, keys) {
  const drop = new Set(keys);
  const lines = text ? String(text).split(/\r?\n/) : [];
  const out = lines.filter((line) => {
    const eq = line.indexOf('=');
    const name = eq > 0 ? line.slice(0, eq).trim() : '';
    return !name || !drop.has(name);
  });
  while (out.length && out[out.length - 1] === '') out.pop();
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

export function apiKeyInsertSql({ id, name, key, scopes, defaultRoleId = null, orIgnore = false }) {
  const esc = (s) => String(s).replaceAll("'", "''");
  const roleSql = defaultRoleId ? `'${esc(defaultRoleId)}'` : 'NULL';
  return `INSERT${orIgnore ? ' OR IGNORE' : ''} INTO api_key (id, name, key_hash, scopes, default_role_id, active) VALUES ('${id}', '${esc(name)}', '${hashApiKey(key)}', '${esc(JSON.stringify(scopes))}', ${roleSql}, 1);`;
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
  // Keys earlier releases copied to production, kept until production has its own.
  if (state.remoteApplied && !state.legacyRemote) {
    state.legacyRemote = { adminId: state.adminId, publicId: state.publicId };
  }
  const previousIds = { adminId: state.adminId, publicId: state.publicId };

  const rotate = options.rotate === true;
  let adminKey = rotate ? '' : readEnvValue(existingEnv, ENV_ADMIN_KEY);
  let publicKey = rotate ? '' : readEnvValue(existingEnv, ENV_PUBLIC_KEY);
  let sessionSecret = rotate ? '' : readEnvValue(existingEnv, ENV_SESSION_SECRET);
  let setupToken = rotate ? '' : readEnvValue(existingEnv, ENV_SETUP_TOKEN);
  const allowedOrigins = readEnvValue(existingEnv, ENV_ALLOWED_ORIGINS);

  const created = { admin: false, public: false, session: false, setupToken: false };
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
  }
  if (rotate) {
    const replaced = deactivateApiKeysSql([
      created.admin && previousIds.adminId !== state.adminId ? previousIds.adminId : null,
      created.public && previousIds.publicId !== state.publicId ? previousIds.publicId : null
    ]);
    if (replaced) inserts.push(replaced);
  }
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex');
    created.session = true;
  }
  if (!setupToken) {
    setupToken = randomBytes(24).toString('hex');
    created.setupToken = true;
  }

  const entries = {
    [ENV_ADMIN_KEY]: adminKey,
    [ENV_PUBLIC_KEY]: publicKey,
    [ENV_SESSION_SECRET]: sessionSecret,
    [ENV_SETUP_TOKEN]: setupToken
  };
  if (allowedOrigins) entries[ENV_ALLOWED_ORIGINS] = allowedOrigins;

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
        '# Filled locally by: npx e9core setup / setup-keys',
        '# wrangler dev and Node both read this file.',
        '# Do NOT add .dev.vars — Wrangler prefers it and ignores these names in .env.',
        '# Production: npx e9core setup --remote copies these to Cloudflare secrets.',
        `${ENV_ADMIN_KEY}=`,
        `${ENV_PUBLIC_KEY}=`,
        `${ENV_SESSION_SECRET}=`,
        `${ENV_SETUP_TOKEN}=`,
        `# ${ENV_ALLOWED_ORIGINS}=http://localhost:8768,https://www.example.com`,
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

  let remote = null;
  if (options.remote) {
    if (!wranglerReady) {
      throw new Error('setup-keys --remote needs wrangler.jsonc or wrangler.toml in this folder.');
    }
    remote = remoteKeys({ cwd, d1Name, env: options.env, rotate, state, publicKey, run: options.wrangler || wrangler });
    notes.push(...remote.notes);
  }

  writeState(cwd, state);

  return {
    created,
    envPath,
    setupToken,
    publicKey,
    notes,
    remote: remote ? { target: remote.target, envPath: remote.envPath, created: remote.created } : null,
    reused: !created.admin && !created.public && !created.session && !created.setupToken
  };
}

/** Wrangler environment name, or `production` for the top-level Worker. */
export function remoteTarget(env) {
  return env ? String(env) : 'production';
}

/** `.env.production`, or `.env.<env>`: that environment's admin key and session secret. */
export function remoteEnvPath(cwd, env) {
  return path.join(cwd, `.env.${remoteTarget(env)}`);
}

export function deactivateApiKeysSql(ids) {
  const list = ids.filter(Boolean).map((id) => `'${String(id).replaceAll("'", "''")}'`);
  return list.length ? `UPDATE api_key SET active = 0 WHERE id IN (${list.join(', ')});` : '';
}

/*
  A deployed environment gets its own admin key and SESSION_SECRET, never the
  local development values. The public key is shared: it is public, and the
  deployed engine9-config.js carries the one written from .env.
  E9_SETUP_TOKEN stays local; the production Worker does not mount /setup.
*/
function remoteKeys({ cwd, d1Name, env, rotate, state, publicKey, run }) {
  const target = remoteTarget(env);
  const envFlag = env ? ['--env', String(env)] : [];
  const filePath = remoteEnvPath(cwd, env);
  const existing = readText(filePath);
  state.remotes = state.remotes || {};
  const prior = state.remotes[target] || {};
  const next = { ...prior };
  const notes = [];
  const sql = [];
  const retire = [];

  // Earlier releases copied the local admin key and public key to production.
  const legacy = target === 'production' && !state.remotes[target] ? state.legacyRemote : null;
  if (legacy) {
    if (legacy.adminId) retire.push(legacy.adminId);
    if (legacy.publicId) next.publicId = legacy.publicId;
    notes.push(
      'Production used the local admin key and SESSION_SECRET. It now has its own; the old admin key is turned off there, and people signed in to production sign in again.'
    );
  }

  let adminKey = rotate ? '' : readEnvValue(existing, ENV_ADMIN_KEY);
  let sessionSecret = rotate ? '' : readEnvValue(existing, ENV_SESSION_SECRET);
  const created = { admin: false, session: false };
  if (!adminKey) {
    adminKey = generateApiKey({ scopes: ['admin'] });
    if (prior.adminId) retire.push(prior.adminId);
    next.adminId = randomUUID();
    created.admin = true;
  }
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex');
    created.session = true;
  }
  if (next.publicId && state.publicId && next.publicId !== state.publicId) retire.push(next.publicId);
  next.publicId = state.publicId;

  // Sent on every run (key_hash is unique), so a rebuilt database gets them back.
  sql.push(
    apiKeyInsertSql({ id: next.adminId || randomUUID(), name: 'site-admin', key: adminKey, scopes: ['admin'], orIgnore: true })
  );
  if (publicKey) {
    sql.push(
      apiKeyInsertSql({ id: next.publicId || randomUUID(), name: 'site-public', key: publicKey, scopes: ['public'], orIgnore: true })
    );
  }
  const retireSql = deactivateApiKeysSql(retire);
  if (retireSql) sql.push(retireSql);

  writeFileSync(
    filePath,
    upsertEnv(existing, {
      [ENV_ADMIN_KEY]: adminKey,
      [ENV_PUBLIC_KEY]: publicKey,
      [ENV_SESSION_SECRET]: sessionSecret
    })
  );

  run(['d1', 'execute', d1Name, '--remote', ...envFlag, '--command', sql.join(' ')], cwd);
  notes.push(`Stored key hashes in the ${target} D1 database "${d1Name}".`);
  const secrets = { [ENV_ADMIN_KEY]: adminKey, [ENV_PUBLIC_KEY]: publicKey, [ENV_SESSION_SECRET]: sessionSecret };
  for (const [name, value] of Object.entries(secrets)) {
    run(['secret', 'put', name, ...envFlag], cwd, value);
  }
  notes.push(
    `Saved ${Object.keys(secrets).join(', ')} as ${target} Cloudflare secrets. Its admin key is in ${path.basename(filePath)} (not committed).`
  );
  if (legacy) {
    notes.push(
      `E9_SETUP_TOKEN is no longer sent to Cloudflare. Remove an old copy with: npx wrangler secret delete E9_SETUP_TOKEN${env ? ` --env ${env}` : ''}`
    );
  }

  state.remotes[target] = next;
  if (legacy) {
    delete state.legacyRemote;
    delete state.remoteApplied;
  }
  return { target, envPath: filePath, created, notes };
}
