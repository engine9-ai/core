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
import { generateApiKey, generateSigningSecret, hashApiKey, signingSecretProblem } from '../auth/index.js';
import { workerSecretNames } from './wranglerProject.js';

export const ENV_ADMIN_KEY = 'E9_ADMIN_API_KEY';
export const ENV_PUBLIC_KEY = 'E9_PUBLIC_API_KEY';
export const ENV_SESSION_SECRET = 'SESSION_SECRET';
export const ENV_AGENT_CREDENTIALS_SECRET = 'AGENT_CREDENTIALS_SECRET';
export const ENV_SETUP_TOKEN = 'E9_SETUP_TOKEN';
export const ENV_ALLOWED_ORIGINS = 'E9_ALLOWED_ORIGINS';
export const ENV_ACCOUNT_ID = 'E9_ACCOUNT_ID';

/*
  A signing secret from the file, or a new one when it is missing or is not
  the shape setup-keys writes (a value someone typed). People never choose
  these. `notes` says which file had a value replaced.
*/
function signingSecretFrom(text, name, { rotate, notes, file }) {
  const existing = rotate ? '' : readEnvValue(text, name);
  if (existing && !signingSecretProblem(existing)) return { value: existing, created: false };
  if (existing) {
    notes.push(`${name} in ${file} ${signingSecretProblem(existing)}; replaced it with a random one. Tokens signed with the old value stop working.`);
  }
  return { value: generateSigningSecret(), created: true };
}

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

export function apiKeyInsertSql({ id, name, key, scopes, defaultRoleId = null, orIgnore = false, expiresAt = null }) {
  const esc = (s) => String(s).replaceAll("'", "''");
  const roleSql = defaultRoleId ? `'${esc(defaultRoleId)}'` : 'NULL';
  const cols = expiresAt ? ', expires_at' : '';
  const vals = expiresAt ? `, '${esc(expiresAt)}'` : '';
  return `INSERT${orIgnore ? ' OR IGNORE' : ''} INTO api_key (id, name, key_hash, scopes, default_role_id, active${cols}) VALUES ('${id}', '${esc(name)}', '${hashApiKey(key)}', '${esc(JSON.stringify(scopes))}', ${roleSql}, 1${vals});`;
}

/*
  The public key is one key for every environment: it is public, and the
  deployed page carries it (public/engine9-config.js, written from .env).
  A folder without it in .env (a fresh clone, a CI runner) takes it from the
  deployed environment's file or the committed page config before making a
  new one, so local development and production never drift apart.
*/
export function sharedPublicKey(cwd, env) {
  const fromFile = (file) => readEnvValue(readText(file), ENV_PUBLIC_KEY);
  const config = readText(path.join(cwd, 'public', 'engine9-config.js'));
  const fromConfig = config.match(/ENGINE9_PUBLIC_KEY\s*=\s*["'](e9publickey_[^"']+)["']/)?.[1] || '';
  return fromFile(path.join(cwd, '.env')) || fromFile(remoteEnvPath(cwd, env)) || fromConfig || '';
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

export function runWrangler(args, cwd, input) {
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


/**
 * @param {{
 *   cwd?: string,
 *   d1?: string,
 *   remote?: boolean,
 *   env?: string,
 *   local?: boolean,
 *   rotate?: boolean,
 *   skipWrangler?: boolean
 * }} options
 *
 * `local` (default: not `remote`) makes or reuses this folder's development
 * keys in .env and stores their hashes in the local database. A `remote` run
 * leaves .env and the local database alone: it is the same command on a
 * laptop, in CI, and in an agent session.
 */
export async function setupKeys(options = {}) {
  const cwd = options.cwd || process.cwd();
  const d1Name = options.d1 || 'engine9';
  const local = options.local ?? !options.remote;
  const rotate = options.rotate === true;
  const state = readState(cwd);
  // Keys earlier releases copied to production, kept until production has its own.
  if (state.remoteApplied && !state.legacyRemote) {
    state.legacyRemote = { adminId: state.adminId, publicId: state.publicId };
  }
  const notes = [];
  const wranglerReady = !options.skipWrangler && hasWranglerConfig(cwd);

  let localResult = null;
  if (local) {
    localResult = await localKeys({ cwd, d1Name, env: options.env, accountId: options.accountId, rotate, state, notes, wranglerReady, applySql: options.applySql });
  }
  const publicKey = localResult ? localResult.publicKey : rotate ? '' : sharedPublicKey(cwd, options.env);

  let remote = null;
  if (options.remote) {
    if (!wranglerReady) {
      throw new Error('setup-keys --remote needs wrangler.jsonc or wrangler.toml in this folder.');
    }
    remote = remoteKeys({
      cwd,
      d1Name,
      env: options.env,
      rotate,
      state,
      publicKey,
      publicCreated: Boolean(localResult?.created.public),
      run: options.wrangler || runWrangler
    });
    notes.push(...remote.notes);
  }

  writeState(cwd, state);

  const created = localResult?.created || {
    admin: Boolean(remote?.created.admin),
    public: Boolean(remote?.created.public),
    session: Boolean(remote?.created.session),
    agentCredentials: Boolean(remote?.created.agentCredentials),
    setupToken: false
  };
  return {
    created,
    envPath: localResult ? path.join(cwd, '.env') : remote?.envPath,
    setupToken: localResult?.setupToken || '',
    publicKey: publicKey || remote?.publicKey || '',
    notes,
    remote: remote ? { target: remote.target, envPath: remote.envPath, created: remote.created, kept: remote.kept } : null,
    reused: !Object.values(created).some(Boolean)
  };
}

/* This folder's development keys: .env, and their hashes in the local database. */
async function localKeys({ cwd, d1Name, env, accountId: projectAccountId, rotate, state, notes, wranglerReady, applySql }) {
  const envPath = path.join(cwd, '.env');
  const gitignorePath = path.join(cwd, '.gitignore');
  const existingEnv = readText(envPath);
  const previousIds = { adminId: state.adminId, publicId: state.publicId };

  let adminKey = rotate ? '' : readEnvValue(existingEnv, ENV_ADMIN_KEY);
  let publicKey = rotate ? '' : readEnvValue(existingEnv, ENV_PUBLIC_KEY);
  // A fresh clone: the public key the deployed site already uses.
  const adopted = !publicKey && !rotate ? sharedPublicKey(cwd, env) : '';
  const session = signingSecretFrom(existingEnv, ENV_SESSION_SECRET, { rotate, notes, file: '.env' });
  const agentCredentials = signingSecretFrom(existingEnv, ENV_AGENT_CREDENTIALS_SECRET, { rotate, notes, file: '.env' });
  let setupToken = rotate ? '' : readEnvValue(existingEnv, ENV_SETUP_TOKEN);
  const allowedOrigins = readEnvValue(existingEnv, ENV_ALLOWED_ORIGINS);
  // Keep whatever .env already has; never overwrite it with options.accountId.
  // A local serve() that read a different value than wrangler.jsonc has is
  // exactly the mismatch this is here to prevent, so once .env has a value,
  // setup leaves it alone.
  const accountId = readEnvValue(existingEnv, ENV_ACCOUNT_ID) || projectAccountId || '';

  const created = { admin: false, public: false, session: session.created, agentCredentials: agentCredentials.created, setupToken: false };
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
      key: adopted || generateApiKey({ scopes: ['public'] })
    };
    row.sql = apiKeyInsertSql({ ...row, orIgnore: Boolean(adopted) });
    publicKey = row.key;
    created.public = !adopted;
    inserts.push(row.sql);
    state.publicId = row.id;
    state.localApplied = false;
    if (adopted) notes.push('Took E9_PUBLIC_API_KEY from the deployed site (.env.production or public/engine9-config.js): the public key is the same everywhere.');
  }
  if (rotate) {
    const replaced = deactivateApiKeysSql([
      created.admin && previousIds.adminId !== state.adminId ? previousIds.adminId : null,
      created.public && previousIds.publicId !== state.publicId ? previousIds.publicId : null
    ]);
    if (replaced) inserts.push(replaced);
  }
  if (!setupToken) {
    setupToken = randomBytes(24).toString('hex');
    created.setupToken = true;
  }

  const entries = {
    [ENV_ADMIN_KEY]: adminKey,
    [ENV_PUBLIC_KEY]: publicKey,
    [ENV_SESSION_SECRET]: session.value,
    [ENV_AGENT_CREDENTIALS_SECRET]: agentCredentials.value,
    [ENV_SETUP_TOKEN]: setupToken
  };
  if (allowedOrigins) entries[ENV_ALLOWED_ORIGINS] = allowedOrigins;
  if (accountId) entries[ENV_ACCOUNT_ID] = accountId;

  writeFileSync(envPath, upsertEnv(existingEnv, entries));
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
        '# Production has its own: npx e9core setup --remote stores them as Cloudflare secrets.',
        `${ENV_ADMIN_KEY}=`,
        `${ENV_PUBLIC_KEY}=`,
        `${ENV_SESSION_SECRET}=`,
        `${ENV_AGENT_CREDENTIALS_SECRET}=`,
        `${ENV_SETUP_TOKEN}=`,
        `# ${ENV_ALLOWED_ORIGINS}=http://localhost:8768,https://www.example.com`,
        ''
      ].join('\n')
    );
  }

  const overrides = wranglerDotenvOverrides(cwd);
  if (overrides.length) {
    notes.push(
      `Delete ${overrides.join(', ')}. Wrangler prefers those files over .env, so the keys in .env will not be used.`
    );
  }

  if (inserts.length && applySql) {
    try {
      for (const sql of inserts) {
        await applySql(sql);
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
        runWrangler(['d1', 'execute', d1Name, '--local', '--command', sql], cwd);
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
        runWrangler(['d1', 'execute', d1Name, '--local', '--command', sql], cwd);
      }
      state.localApplied = true;
      state.pendingSql = [];
      notes.push(`Stored pending key hashes in local D1 database "${d1Name}".`);
    } catch (err) {
      notes.push(`Local D1 insert failed: ${err.message}`);
    }
  }
  return { created, publicKey, setupToken };
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

/* Turn off every other key of a site key's name (`site-admin`, `site-public`) once a new one replaces it. */
export function retireOtherKeysSql(name, key) {
  return `UPDATE api_key SET active = 0 WHERE name = '${String(name).replaceAll("'", "''")}' AND key_hash <> '${hashApiKey(key)}';`;
}

/*
  One deployed secret. The target decides: a value in .env.<target> is used;
  otherwise a secret the Worker already has is kept as it is (its value is
  never readable again, and replacing it would sign everyone out or break
  scripts that hold the key); only a missing one is made. --rotate replaces it.
*/
function deployedValue(name, fileText, { force, onWorker, notes, file, make, problemOf }) {
  const existing = force ? '' : readEnvValue(fileText, name);
  const problem = existing && problemOf ? problemOf(existing) : null;
  if (existing && !problem) return { value: existing, created: false, put: !onWorker.has(name) };
  if (existing) {
    notes.push(`${name} in ${file} ${problem}; replaced it with a random one. Tokens signed with the old value stop working.`);
    return { value: make(), created: true, put: true };
  }
  if (!force && onWorker.has(name)) return { value: '', created: false, put: false, kept: true };
  return { value: make(), created: true, put: true };
}

/*
  A deployed environment gets its own admin key, SESSION_SECRET, and
  AGENT_CREDENTIALS_SECRET, never the local development values. The public
  key is shared (sharedPublicKey). E9_SETUP_TOKEN stays local; the production
  Worker does not mount /setup.

  What exists is read from the target (`wrangler secret list`), not from
  files on this machine, so a second run on a fresh CI runner changes
  nothing. Values it makes are written to .env.<target> on this machine and
  stored as the Worker's secrets.
*/
function remoteKeys({ cwd, d1Name, env, rotate, state, publicKey, publicCreated, run }) {
  const target = remoteTarget(env);
  const envFlag = env ? ['--env', String(env)] : [];
  const filePath = remoteEnvPath(cwd, env);
  const file = path.basename(filePath);
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

  const onWorker = rotate ? new Set() : workerSecretNames((args) => run(args, cwd), envFlag);
  // The legacy copies on the Worker are the local values: replace them.
  const force = rotate || Boolean(legacy);
  const common = { force, onWorker, notes, file };
  const admin = deployedValue(ENV_ADMIN_KEY, existing, { ...common, make: () => generateApiKey({ scopes: ['admin'] }) });
  const session = deployedValue(ENV_SESSION_SECRET, existing, { ...common, make: generateSigningSecret, problemOf: signingSecretProblem });
  const agentCredentials = deployedValue(ENV_AGENT_CREDENTIALS_SECRET, existing, { ...common, make: generateSigningSecret, problemOf: signingSecretProblem });

  let publicValue = publicKey;
  let publicMade = publicCreated;
  if (!publicValue && (rotate || !onWorker.has(ENV_PUBLIC_KEY))) {
    publicValue = generateApiKey({ scopes: ['public'] });
    publicMade = true;
  }
  const pub = {
    value: publicValue,
    created: publicMade,
    put: Boolean(publicValue) && (publicMade || !onWorker.has(ENV_PUBLIC_KEY)),
    kept: !publicValue
  };

  const created = { admin: admin.created, public: pub.created, session: session.created, agentCredentials: agentCredentials.created };
  if (admin.created) next.adminId = randomUUID();
  if (publicKey && state.publicId) next.publicId = state.publicId;

  // Sent on every run (key_hash is unique), so a rebuilt database gets them back.
  if (admin.value) {
    sql.push(apiKeyInsertSql({ id: next.adminId || randomUUID(), name: 'site-admin', key: admin.value, scopes: ['admin'], orIgnore: true }));
    if (admin.created) sql.push(retireOtherKeysSql('site-admin', admin.value));
  }
  if (pub.value) {
    sql.push(apiKeyInsertSql({ id: next.publicId || randomUUID(), name: 'site-public', key: pub.value, scopes: ['public'], orIgnore: true }));
    if (pub.created) sql.push(retireOtherKeysSql('site-public', pub.value));
  }
  const retireSql = deactivateApiKeysSql(retire);
  if (retireSql) sql.push(retireSql);

  const values = {
    [ENV_ADMIN_KEY]: admin,
    [ENV_PUBLIC_KEY]: pub,
    [ENV_SESSION_SECRET]: session,
    [ENV_AGENT_CREDENTIALS_SECRET]: agentCredentials
  };
  const known = Object.fromEntries(Object.entries(values).filter(([, v]) => v.value).map(([name, v]) => [name, v.value]));
  if (Object.keys(known).length) writeFileSync(filePath, upsertEnv(existing, known));

  if (sql.length) {
    run(['d1', 'execute', d1Name, '--remote', ...envFlag, '--command', sql.join(' ')], cwd);
    notes.push(`Stored key hashes in the ${target} D1 database "${d1Name}".`);
  }
  const put = Object.entries(values).filter(([, v]) => v.put);
  for (const [name, v] of put) {
    run(['secret', 'put', name, ...envFlag], cwd, v.value);
  }
  if (put.length) {
    notes.push(
      `Saved ${put.map(([name]) => name).join(', ')} as ${target} Cloudflare secrets.${admin.value && admin.put ? ` Its admin key is in ${file} (not committed).` : ''}`
    );
  }
  const kept = Object.entries(values).filter(([, v]) => v.kept).map(([name]) => name);
  if (kept.length) {
    notes.push(
      `Kept ${kept.join(', ')}: already ${target} Worker secrets. Cloudflare does not show a secret again, so they are not in ${file}. Pass --rotate to replace them.`
    );
  }
  if (admin.kept) {
    notes.push(
      `The ${target} admin key is only a Worker secret. Commands that need it can use --remote instead (npx e9core upgrade --remote), which makes a temporary key.`
    );
  }
  if (pub.created && !publicKey) {
    notes.push(`Made E9_PUBLIC_API_KEY (in ${file}). Pages send it: npx e9core setup --step write-config puts it in public/engine9-config.js.`);
  }
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
  return { target, envPath: filePath, created, kept, publicKey: pub.value, notes };
}
