/*
  `--remote` on `e9core upgrade`, `status`, `segment`, and
  `installDefaultPlugins`: a short-lived admin key for one command against
  the deployed site, for a machine that holds no admin key (a CI runner, an
  agent session, a laptop whose .env.production is gone).

  Whoever can write the site's D1 database through wrangler can already
  change anything in it, so writing one more api_key row gives that machine
  nothing new. The row expires on its own (expires_at, checked on every
  request) and is deleted when the command ends. Only its hash is stored.
  The key is never printed or written to a file.
*/
import { randomUUID } from 'node:crypto';
import { generateApiKey } from '../auth/index.js';
import { apiKeyInsertSql, runWrangler } from './setupKeys.js';
import { wranglerProject } from './wranglerProject.js';

export const TEMPORARY_KEY_NAME = 'e9core-temporary';
export const TEMPORARY_KEY_MINUTES = 15;

const esc = (s) => String(s).replaceAll("'", "''");

/**
 * The deployed site's URL: --url, else the one custom-domain route in
 * wrangler.jsonc. Throws when neither names it.
 */
export function remoteSiteUrl({ url, cwd = process.cwd(), env } = {}) {
  if (url) return url;
  const project = wranglerProject(cwd, env);
  if (project?.url) return project.url;
  throw new Error(
    `--remote needs the site's address: pass --url https://www.example.com${project ? ` (${project.file} has no single custom-domain route to take it from)` : ''}`
  );
}

/**
 * Runs fn(key) with an admin key that exists only for this call.
 * `run(args, cwd)` runs `npx wrangler <args>` and throws on failure.
 */
export async function withTemporaryAdminKey(
  { cwd = process.cwd(), env, d1, minutes = TEMPORARY_KEY_MINUTES, run = runWrangler, now = () => new Date() } = {},
  fn
) {
  const project = wranglerProject(cwd, env);
  const databaseName = d1 || project?.databaseName;
  if (!databaseName) {
    throw new Error('--remote needs wrangler.jsonc with a DB binding in this folder (the site whose database gets the temporary key).');
  }
  const envFlag = env ? ['--env', String(env)] : [];
  const execute = (sql) => run(['d1', 'execute', databaseName, '--remote', ...envFlag, '--command', sql], cwd);
  const started = now();
  const expiresAt = new Date(started.getTime() + minutes * 60_000).toISOString();
  const id = randomUUID();
  const key = generateApiKey({ scopes: ['admin'] });
  // An earlier run that was killed before it could clean up leaves an expired row.
  execute(
    `DELETE FROM api_key WHERE name = '${TEMPORARY_KEY_NAME}' AND expires_at < '${esc(started.toISOString())}'; ${apiKeyInsertSql({
      id,
      name: TEMPORARY_KEY_NAME,
      key,
      scopes: ['admin'],
      expiresAt
    })}`
  );
  try {
    return await fn(key, { id, expiresAt });
  } finally {
    try {
      execute(`DELETE FROM api_key WHERE id = '${esc(id)}';`);
    } catch (e) {
      console.error(`Could not delete the temporary key ${id}; it expires at ${expiresAt}. ${String(e?.message || e)}`);
    }
  }
}
