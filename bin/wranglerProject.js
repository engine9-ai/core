/*
  The site's own wrangler config, and what the deployed target says about
  itself. `e9core setup --remote`, `status`, and the `--remote` key in
  `upgrade`, `segment`, and `installDefaultPlugins` read the Worker name,
  the D1 database, and the account from here, never from defaults, so a run
  in CI or an agent session works on the same site a laptop would.
*/
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';

export const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json'];

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

/**
 * The wrangler.jsonc (or wrangler.json) in `cwd`, scoped to `env` when given:
 * { cfg, file, workerName, vars, databaseName, databaseId, url } or null.
 * `url` is https://<pattern> of the one custom-domain route, when there is one.
 */
export function wranglerProject(cwd, env) {
  for (const name of WRANGLER_FILES) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;
    const cfg = JSON5.parse(readFileSync(file, 'utf8'));
    const scope = env ? cfg.env?.[env] : cfg;
    const db = scope?.d1_databases?.find((d) => d.binding === 'DB');
    const routes = (scope?.routes || []).filter((r) => r && typeof r === 'object' && r.custom_domain && r.pattern);
    return {
      cfg,
      file: name,
      workerName: scope?.name || (env && cfg.name ? `${cfg.name}-${env}` : cfg.name) || null,
      vars: scope?.vars || {},
      databaseName: db?.database_name || null,
      databaseId: db?.database_id || null,
      url: routes.length === 1 ? `https://${String(routes[0].pattern).replace(/\/.*$/, '')}` : null
    };
  }
  return null;
}

function failureText(err) {
  return String(err?.message || err || '');
}

/* Wrangler's answer when the Worker has never been deployed. */
const NO_WORKER = /does not exist|not found|\[code: 10007\]|could not find|no worker/i;

/**
 * Names of the Worker's secrets (`wrangler secret list`). A Worker that does
 * not exist yet has none. Any other failure throws: setup must not guess
 * that a secret is missing, or it would replace one that is there.
 *
 * `run(args)` runs `npx wrangler <args>` and returns stdout, throwing on a
 * non-zero exit (setupKeys' `wrangler`).
 */
export function workerSecretNames(run, envFlag = []) {
  let text;
  try {
    text = run(['secret', 'list', ...envFlag]);
  } catch (err) {
    if (NO_WORKER.test(failureText(err))) return new Set();
    throw new Error(`Could not list the Worker's secrets, so setup cannot tell which exist: ${failureText(err)}`);
  }
  if (!String(text || '').trim()) return new Set();
  const parsed = parseWranglerJson(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Could not read wrangler secret list output: ${String(text).slice(0, 200)}`);
  }
  return new Set(parsed.map((s) => s?.name).filter(Boolean));
}

/** Rows of one `wrangler d1 execute --json --command` answer. */
export function d1Rows(text) {
  const parsed = parseWranglerJson(text);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return Array.isArray(first?.results) ? first.results : [];
}
