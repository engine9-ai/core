/*
  `e9core upgrade --url <site>`: run PluginWorker.upgrade inside a deployed
  site, where its own database binding is (D1 has no connection string a
  Node process can open). Posts to <site>/api/admin/upgrade with the admin key.
  `e9core upgrade --db <connection>` runs the same method locally instead.

  `callSite` is the same request for the other `--url` commands
  (`e9core segment … --url`).
*/
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_ADMIN_KEY, readEnvValue, remoteEnvPath } from './setupKeys.js';

/** https://www.example.com + /admin/upgrade -> https://www.example.com/api/admin/upgrade (an /api base is kept). */
export function siteEndpoint(url, route) {
  const u = new URL(url);
  const base = u.pathname.replace(/\/+$/, '');
  u.pathname = `${base.endsWith('/api') ? base : `${base}/api`}${route}`;
  u.search = '';
  return u.toString();
}

export function upgradeEndpoint(url) {
  return siteEndpoint(url, '/admin/upgrade');
}

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * --key, then E9_ADMIN_API_KEY in the environment, then the deployed
 * environment's file (.env.<target>; .env.production for a non-local URL),
 * then ./.env. Deployed environments have their own admin key.
 */
export function adminKey({ key, target, url, cwd = process.cwd(), env = process.env } = {}) {
  if (key) return key;
  if (env[ENV_ADMIN_KEY]) return env[ENV_ADMIN_KEY];
  const files = [];
  if (target) files.push(remoteEnvPath(cwd, target));
  else if (url && !isLocalUrl(url)) files.push(remoteEnvPath(cwd));
  if (!target) files.push(path.join(cwd, '.env'));
  for (const file of files) {
    const value = existsSync(file) ? readEnvValue(readFileSync(file, 'utf8'), ENV_ADMIN_KEY) : '';
    if (value) return value;
  }
  return '';
}

/** One request to a deployed site's API with the admin key. Throws on a non-2xx answer. */
export async function callSite({ url, key, method = 'POST', route, body, fetchImpl = fetch }) {
  if (!key) throw new Error(`No admin API key: pass --key or set ${ENV_ADMIN_KEY} (e9core setup writes it to .env)`);
  const endpoint = siteEndpoint(url, route);
  const response = await fetchImpl(endpoint, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text };
  }
  if (!response.ok) {
    throw new Error(`${endpoint} answered ${response.status}: ${parsed.error || text}`);
  }
  return parsed;
}

export async function upgradeSite({ url, key, options = {}, fetchImpl = fetch }) {
  return callSite({ url, key, route: '/admin/upgrade', body: options, fetchImpl });
}

export async function installDefaultPluginsSite({ url, key, path, fetchImpl = fetch }) {
  return callSite({
    url,
    key,
    route: '/admin/install-default-plugins',
    body: path ? { path } : {},
    fetchImpl
  });
}
