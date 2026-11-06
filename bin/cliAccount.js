/*
  The account id and handle a CLI command works under, read the same way by
  every command: --account / --handle, then the environment, then .env in the
  working folder. `fallback` is the command's historical default; it only
  applies when nothing is configured, so a database built under it keeps the
  ids it already has.
*/
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readEnvValue } from './setupKeys.js';

function flag(value) {
  return value && value !== true ? String(value).trim() : '';
}

/**
 * @param {Record<string, any>} [args] parsed CLI flags
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, fallback?: string }} [options]
 * @returns {{ accountId: string, accountHandle: string, configured: boolean }}
 *   configured is false when the ids come from `fallback` alone.
 */
export function cliAccount(args = {}, { cwd = process.cwd(), env = process.env, fallback = 'local' } = {}) {
  const envPath = path.join(cwd, '.env');
  const dotenv = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const read = (key) => (env[key] || '').trim() || readEnvValue(dotenv, key);
  const accountId = flag(args.account) || read('E9_ACCOUNT_ID');
  const accountHandle = flag(args.handle) || read('E9_ACCOUNT_HANDLE');
  return {
    accountId: accountId || fallback,
    accountHandle: accountHandle || accountId || fallback,
    configured: Boolean(accountId || accountHandle)
  };
}
