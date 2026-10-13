/*
  `e9core upgrade --url <site>`: run PluginWorker.upgrade inside a deployed
  site, where its own database binding is (D1 has no connection string a
  Node process can open). Posts to <site>/api/admin/upgrade with the admin key.
  `e9core upgrade --db <connection>` runs the same method locally instead.
*/
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_ADMIN_KEY, readEnvValue } from './setupKeys.js';

/** https://www.example.com -> https://www.example.com/api/admin/upgrade (an /api base is kept). */
export function upgradeEndpoint(url) {
  const u = new URL(url);
  const base = u.pathname.replace(/\/+$/, '');
  u.pathname = `${base.endsWith('/api') ? base : `${base}/api`}/admin/upgrade`;
  u.search = '';
  return u.toString();
}

/** --key, then E9_ADMIN_API_KEY in the environment, then in ./.env */
export function adminKey({ key, cwd = process.cwd(), env = process.env } = {}) {
  if (key) return key;
  if (env[ENV_ADMIN_KEY]) return env[ENV_ADMIN_KEY];
  const envPath = path.join(cwd, '.env');
  return existsSync(envPath) ? readEnvValue(readFileSync(envPath, 'utf8'), ENV_ADMIN_KEY) : '';
}

export async function upgradeSite({ url, key, options = {}, fetchImpl = fetch }) {
  if (!key) throw new Error(`No admin API key: pass --key or set ${ENV_ADMIN_KEY} (e9core setup writes it to .env)`);
  const endpoint = upgradeEndpoint(url);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(options)
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    throw new Error(`${endpoint} answered ${response.status}: ${body.error || text}`);
  }
  return body;
}
