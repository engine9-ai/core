/**
 * One setup path for the HTML wizard and for `e9core setup --step`.
 * The wizard only collects answers and calls `runSetupStep`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupStep } from '../api/setupSteps.js';
import {
  markSetupFinished,
  parseOriginList,
  setStoredOrigins
} from '../api/setupPage.js';
import {
  ENV_ALLOWED_ORIGINS,
  ENV_PUBLIC_KEY,
  ENV_SETUP_TOKEN,
  readEnvValue,
  removeEnvKeys,
  upsertEnv
} from './setupKeys.js';
import { setup } from './setup.js';

const WIZARD_FILE = 'wizard.json';

export function readWizardState(cwd) {
  const file = path.join(cwd, '.e9core', WIZARD_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeWizardState(cwd, state) {
  mkdirSync(path.join(cwd, '.e9core'), { recursive: true });
  writeFileSync(path.join(cwd, '.e9core', WIZARD_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function readEnvFile(cwd) {
  const file = path.join(cwd, '.env');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8');
}

function writeEnvFile(cwd, text) {
  writeFileSync(path.join(cwd, '.env'), text.endsWith('\n') ? text : `${text}\n`);
}

function defaultRunCommand(args, cwd, { detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd,
      detached,
      stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe']
    });
    if (detached) {
      child.unref();
      resolve({ status: 0, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

export function accountFromWhoami(text) {
  const raw = String(text || '');
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) return email[0];
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !/^wrangler/i.test(s));
  return line || '';
}

export function configSource(publicKey) {
  return [
    "window.ENGINE9_API = '/api';",
    `window.ENGINE9_PUBLIC_KEY = ${JSON.stringify(publicKey || '')};`,
    "window.ENGINE9_SOURCE = 'website';",
    ''
  ].join('\n');
}

function normalizeHost(host) {
  return host === 'node' ? 'node' : 'cloudflare';
}

async function openWorker(ctx) {
  if (ctx.worker) {
    return { worker: ctx.worker, keyStore: ctx.keyStore, owned: false };
  }
  const { default: PluginWorker } = await import('../lib/PluginWorker.js');
  const { SqlApiKeyStore } = await import('../auth/index.js');
  const cwd = ctx.cwd || process.cwd();
  let db = ctx.db || 'sqlite://./engine9.db';
  if (db.startsWith('sqlite://') && !db.includes(':memory:')) {
    const file = db.slice('sqlite://'.length);
    if (!path.isAbsolute(file)) db = `sqlite://${path.join(cwd, file)}`;
  }
  const worker = new PluginWorker({
    accountId: 'local',
    auth: { database_connection: db }
  });
  return { worker, keyStore: new SqlApiKeyStore({ worker }), owned: true };
}

/**
 * @param {{
 *   action?: string,
 *   host?: string,
 *   domain?: string,
 *   origins?: string|string[],
 *   email?: string,
 *   givenName?: string,
 *   given_name?: string
 * }} answers
 * @param {{
 *   cwd?: string,
 *   worker?: object,
 *   keyStore?: object,
 *   api?: { handle: Function },
 *   runCommand?: Function,
 *   runSetup?: Function,
 *   previewPort?: number,
 *   db?: string
 * }} [ctx]
 */
export async function runSetupStep(answers = {}, ctx = {}) {
  const action = answers.action || answers.step;
  const step = setupStep(action);
  if (!step) throw new Error(`Unknown setup step: ${action || '(none)'}`);

  const cwd = ctx.cwd || process.cwd();
  const runCommand = ctx.runCommand || defaultRunCommand;
  const runSetup = ctx.runSetup || ((options) => setup({ cwd, ...options }));

  if (action === 'choose') {
    const host = normalizeHost(answers.host);
    const state = readWizardState(cwd);
    state.host = host;
    writeWizardState(cwd, state);
    return { host, step: action };
  }

  if (action === 'whoami') {
    const result = await runCommand(['wrangler', 'whoami'], cwd);
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0) return { account: '', step: action };
    return { account: accountFromWhoami(text), step: action };
  }

  if (action === 'login') {
    await runCommand(['wrangler', 'login'], cwd, { detached: true });
    return { started: true, step: action };
  }

  if (action === 'setup-cloudflare') {
    const result = await runSetup({ node: false, remote: false });
    return { notes: result.notes || [], step: action };
  }

  if (action === 'setup-node') {
    const result = await runSetup({ node: true });
    return { notes: result.notes || [], step: action };
  }

  if (action === 'preview') {
    const port = ctx.previewPort || 8788;
    const url = `http://127.0.0.1:${port}`;
    await runCommand(['wrangler', 'dev', '--port', String(port)], cwd, { detached: true });
    return { url, step: action };
  }

  if (action === 'deploy') {
    const domain = String(answers.domain || '').trim();
    const result = await runSetup({
      remote: true,
      domain: domain || undefined
    });
    return { notes: result.notes || [], step: action };
  }

  if (action === 'write-config') {
    const publicKey = readEnvValue(readEnvFile(cwd), ENV_PUBLIC_KEY);
    if (!publicKey) throw new Error('Create the local development database first so a public key exists.');
    const dir = path.join(cwd, 'public');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'engine9-config.js'), configSource(publicKey));
    return { file: 'public/engine9-config.js', step: action };
  }

  if (action === 'try-signup') {
    if (!ctx.api) throw new Error('API is not running. Start it with npx e9core serve, then retry this step.');
    const publicKey = readEnvValue(readEnvFile(cwd), ENV_PUBLIC_KEY);
    if (!publicKey) throw new Error('Create the local development database first so a public key exists.');
    const email = String(answers.email || '').trim();
    const givenName = String(answers.givenName || answers.given_name || '').trim();
    if (!email) throw new Error('Email is required.');
    const result = await ctx.api.handle({
      method: 'POST',
      path: '/people',
      headers: { authorization: `Bearer ${publicKey}` },
      body: { people: [{ email, given_name: givenName }] }
    });
    if (result.status !== 200) {
      throw new Error(result.body?.error || 'Signup failed.');
    }
    return { message: `${givenName || email} is in the database.`, step: action };
  }

  if (action === 'origins') {
    const origins = parseOriginList(answers.origins);
    const opened = await openWorker(ctx);
    try {
      await setStoredOrigins(opened.worker, origins);
    } finally {
      if (opened.owned) await opened.worker.destroy();
    }
    const env = upsertEnv(readEnvFile(cwd), { [ENV_ALLOWED_ORIGINS]: origins.join(',') });
    writeEnvFile(cwd, env);
    process.env.E9_ALLOWED_ORIGINS = origins.join(',');
    return { origins, step: action };
  }

  if (action === 'rotate-public') {
    const opened = await openWorker(ctx);
    try {
      const keyStore = opened.keyStore;
      if (!keyStore) throw new Error('API keys are not available yet.');
      const { data } = await opened.worker.query({
        sql: 'SELECT id FROM api_key WHERE name = ? AND active = 1',
        values: ['site-public']
      });
      const id = data?.[0]?.id;
      let key;
      if (id) {
        const rotated = await keyStore.rotate({ id, scopes: ['public'] });
        key = rotated.key;
      } else {
        const created = await keyStore.create({ name: 'site-public', scopes: ['public'] });
        key = created.key;
      }
      const env = upsertEnv(readEnvFile(cwd), { [ENV_PUBLIC_KEY]: key });
      writeEnvFile(cwd, env);
      const configPath = path.join(cwd, 'public', 'engine9-config.js');
      if (existsSync(configPath)) writeFileSync(configPath, configSource(key));
      return { replaced: true, step: action };
    } finally {
      if (opened.owned) await opened.worker.destroy();
    }
  }

  if (action === 'finish') {
    const opened = await openWorker(ctx);
    try {
      await markSetupFinished(opened.worker);
    } finally {
      if (opened.owned) await opened.worker.destroy();
    }
    const env = removeEnvKeys(readEnvFile(cwd), [ENV_SETUP_TOKEN]);
    writeEnvFile(cwd, env);
    delete process.env.E9_SETUP_TOKEN;
    return { finished: true, step: action };
  }

  throw new Error(`Unknown setup step: ${action}`);
}
