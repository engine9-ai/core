/**
 * Local setup wizard. Collects answers and calls `runSetupStep`.
 * The production Worker does not import this module.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_PUBLIC_KEY, readEnvValue } from './setupKeys.js';
import { getStoredOrigins, parseOriginList } from '../api/setupPage.js';
import { readWizardState, runSetupStep } from './setupFlow.js';

function readEnvFile(cwd) {
  const file = path.join(cwd, '.env');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8');
}

/**
 * @param {{
 *   cwd: string,
 *   worker?: object,
 *   keyStore?: object,
 *   api?: { handle: Function },
 *   runCommand?: Function,
 *   runSetup?: Function,
 *   previewPort?: number
 * }} ctx
 */
export function createWizard(ctx) {
  const cwd = ctx.cwd;
  let previewUrl = '';

  async function status() {
    const env = readEnvFile(cwd);
    const state = readWizardState(cwd);
    const publicKey = readEnvValue(env, ENV_PUBLIC_KEY);
    let apiOk = false;
    if (ctx.api) {
      try {
        const ok = await ctx.api.handle({ method: 'GET', path: '/ok' });
        apiOk = ok.status === 200 && ok.body?.ok === true;
      } catch {
        apiOk = false;
      }
    }
    let origins = parseOriginList(readEnvValue(env, 'E9_ALLOWED_ORIGINS'));
    if (ctx.worker) {
      try {
        origins = [...new Set([...origins, ...(await getStoredOrigins(ctx.worker))])];
      } catch {
        /* database may not exist yet */
      }
    }
    const dbFile = existsSync(path.join(cwd, 'engine9.db'));
    const wrangler = existsSync(path.join(cwd, 'wrangler.jsonc'));
    return {
      host: state.host || '',
      publicKey,
      apiOk,
      origins,
      database: dbFile ? 'engine9.db' : '',
      workerName: wrangler ? 'wrangler.jsonc' : '',
      previewUrl,
      statusLine: [
        dbFile ? 'Database: engine9.db' : '',
        wrangler ? 'Cloudflare project file: wrangler.jsonc' : '',
        'Wizard is open on this development machine only.'
      ].filter(Boolean).join(' · ')
    };
  }

  async function handleAction(body = {}) {
    if (body.action === 'status') return status();
    const result = await runSetupStep(body, ctx);
    if (result.url) previewUrl = result.url;
    return result;
  }

  return { handleAction, status };
}

export function mintSetupToken() {
  return randomBytes(24).toString('hex');
}
