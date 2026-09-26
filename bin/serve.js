/**
 * Local website + engine9 API on one Node process (same platform).
 *
 *   npx e9core setup --node
 *   npx e9core serve
 *
 * Serves static files (./public if present, else safe files from .) and /api.
 */
import http from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { JsonlFileLogger, NullLogger } from '../logging/index.js';
import { createApi } from '../api/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { renderWizardHtml, timingSafeEqualString, isSetupFinished, setMeta } from '../api/setupPage.js';
import { createWizard, mintSetupToken } from './wizard.js';
import { ensureNodePluginRegistry } from './nodePluginRegistry.js';
import {
  ENV_SETUP_TOKEN,
  upsertEnv
} from './setupKeys.js';

const DEFAULT_PORT = 8787;

const BLOCKED_NAMES = new Set([
  '.env',
  '.env.example',
  '.gitignore',
  '.dev.vars',
  'engine9.db',
  'wrangler.jsonc',
  'wrangler.json',
  'wrangler.toml',
  'package.json',
  'package-lock.json'
]);

const BLOCKED_DIRS = new Set([
  'node_modules',
  '.git',
  '.e9core',
  '.wrangler',
  'migrations',
  'bin',
  'test'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function resolveDatabase(cwd, db) {
  const value = String(db || 'sqlite://./engine9.db');
  if (!value.startsWith('sqlite://') || value.includes(':memory:')) return value;
  const file = value.slice('sqlite://'.length);
  if (path.isAbsolute(file)) return value;
  return `sqlite://${path.join(cwd, file)}`;
}

export function loadDotEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return out;
}

function resolveStaticRoot(cwd) {
  const publicDir = path.join(cwd, 'public');
  if (existsSync(publicDir) && statSync(publicDir).isDirectory()) return publicDir;
  return cwd;
}

function isBlockedRelative(rel) {
  const parts = rel.split(/[/\\]/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => p === '..' || BLOCKED_DIRS.has(p))) return true;
  if (parts.some((p) => p.startsWith('.') && p !== '.')) return true;
  const base = parts[parts.length - 1];
  if (BLOCKED_NAMES.has(base)) return true;
  if (base.startsWith('.env')) return true;
  if (base.endsWith('.db') || base.endsWith('.sqlite')) return true;
  return false;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function send(res, status, body, headers = {}) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-length': payload ? payload.length : 0,
    ...headers
  });
  res.end(payload);
}

/**
 * @param {{
 *   cwd?: string,
 *   port?: number,
 *   db?: string,
 *   staticRoot?: string,
 *   apiOnly?: boolean,
 *   listen?: boolean
 * }} [options]
 */
export async function serve(options = {}) {
  const cwd = options.cwd || process.cwd();
  loadDotEnv(cwd);
  const port = Number(options.port || process.env.PORT || DEFAULT_PORT);
  const db = resolveDatabase(cwd, options.db || process.env.ENGINE9_DATABASE_CONNECTION || 'sqlite://./engine9.db');
  const accountId = process.env.E9_ACCOUNT_ID || 'local';
  const pluginId = process.env.E9_PLUGIN_ID || getPluginUUID(accountId, 'website');
  const staticRoot = options.apiOnly
    ? null
    : (options.staticRoot ? path.resolve(cwd, options.staticRoot) : resolveStaticRoot(cwd));

  ensureNodePluginRegistry({ cwd });
  const worker = new PersonWorker({
    accountId,
    auth: { database_connection: db }
  });
  const keyStore = new SqlApiKeyStore({ worker });
  const logsDir = path.join(cwd, 'logs');
  const logger = existsSync(logsDir)
    ? new JsonlFileLogger({ directory: logsDir })
    : new NullLogger();

  const api = createApi({
    worker,
    keyStore,
    logger,
    // `e9core setup` writes SESSION_SECRET to .env; that turns on /auth/* with
    // the default identity provider. The JWT aud defaults to the request Host.
    delegate: process.env.SESSION_SECRET
      ? {
          sessionSecret: process.env.SESSION_SECRET,
          delegateUrl: process.env.DELEGATE_URL,
          domain: process.env.E9_DOMAIN
        }
      : null,
    config: {
      pluginId,
      defaultRemoteInputId: 'website',
      upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
      allowedOrigins: process.env.E9_ALLOWED_ORIGINS || ''
    }
  });

  const envPath = path.join(cwd, '.env');
  let finished = false;
  try {
    finished = await isSetupFinished(worker);
  } catch {
    finished = false;
  }
  if (options.reopenSetup) {
    try {
      await setMeta(worker, 'setup_finished', '');
    } catch {
      /* meta table appears on the next setup call */
    }
    finished = false;
    const token = mintSetupToken();
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    writeFileSync(envPath, upsertEnv(existing, { [ENV_SETUP_TOKEN]: token }));
    process.env.E9_SETUP_TOKEN = token;
  }
  if (!finished && !process.env.E9_SETUP_TOKEN) {
    const token = mintSetupToken();
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    writeFileSync(envPath, upsertEnv(existing, { [ENV_SETUP_TOKEN]: token }));
    process.env.E9_SETUP_TOKEN = token;
  }
  const gate = {
    enabled: !finished && Boolean(process.env.E9_SETUP_TOKEN),
    token: finished ? '' : (process.env.E9_SETUP_TOKEN || '')
  };

  const wizard = createWizard({
    cwd,
    worker,
    keyStore,
    api,
    runCommand: options.runCommand,
    runSetup: options.runSetup,
    previewPort: options.previewPort
  });

  const host = options.host || '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host || `${host}:${port}`;
      const url = new URL(req.url || '/', `http://${hostHeader}`);
      if (url.pathname === '/setup') {
        if (!gate.enabled || !timingSafeEqualString(url.searchParams.get('token') || '', gate.token)) {
          send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
          return;
        }
        if (req.method === 'GET') {
          send(res, 200, renderWizardHtml({ token: gate.token }), {
            'content-type': 'text/html; charset=utf-8'
          });
          return;
        }
        if (req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let body = {};
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              send(res, 400, JSON.stringify({ error: 'invalid JSON body' }), {
                'content-type': 'application/json'
              });
              return;
            }
          }
          try {
            const result = await wizard.handleAction(body);
            if (result?.finished) {
              gate.enabled = false;
              gate.token = '';
            }
            send(res, 200, JSON.stringify(result), { 'content-type': 'application/json' });
          } catch (err) {
            send(res, 400, JSON.stringify({ error: err.message || 'setup failed' }), {
              'content-type': 'application/json'
            });
          }
          return;
        }
        send(res, 405, 'Method not allowed', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }

      if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) {
        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              send(res, 400, JSON.stringify({ error: 'invalid JSON body' }), {
                'content-type': 'application/json'
              });
              return;
            }
          }
        }
        const apiPath = url.pathname.slice('/api'.length) || '/';
        const result = await api.handle({
          method: req.method,
          path: apiPath,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          headers: req.headers,
          original: req,
          apiBase: `${url.origin}/api`
        });
        await logger.flush();
        const headers = {
          'content-type': result.contentType || 'application/json',
          ...(result.headers || {})
        };
        if (result.status === 204) {
          res.writeHead(204, headers);
          res.end();
          return;
        }
        const payload =
          result.contentType && String(result.contentType).indexOf('text/html') === 0
            ? result.body
            : JSON.stringify(result.body);
        send(res, result.status, payload, headers);
        return;
      }

      if (!staticRoot) {
        send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }

      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      rel = rel.replace(/^\/+/, '');
      if (isBlockedRelative(rel)) {
        send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }
      const filePath = path.resolve(staticRoot, rel);
      if (!filePath.startsWith(path.resolve(staticRoot))) {
        send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return;
      }
      send(res, 200, readFileSync(filePath), { 'content-type': contentTypeFor(filePath) });
    } catch (e) {
      send(res, 500, JSON.stringify({ error: 'internal error' }), {
        'content-type': 'application/json'
      });
    }
  });

  const listen = options.listen !== false;

  if (listen) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  const base = `http://${host}:${port}`;
  const notes = [
    `engine9 listening on ${base}`,
    staticRoot
      ? `Serving site files from ${path.relative(cwd, staticRoot) || '.'} and API at ${base}/api`
      : `API only at ${base}/api`
  ];
  if (gate.enabled && gate.token) {
    notes.push(`Open setup: ${base}/setup?token=${gate.token}`);
  } else {
    notes.push('Setup wizard is closed. Reopen with: npx e9core serve --setup');
  }

  return {
    server,
    port,
    base,
    notes,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await worker.destroy();
    }
  };
}

export function parseServeArgs(argv = []) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.indexOf('--') === 0) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(a);
  }
  return args;
}

// Allow direct `node bin/serve.js` for debugging.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  serve().then((result) => {
    for (const note of result.notes) console.log(note);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
