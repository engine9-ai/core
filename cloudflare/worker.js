/*
  Example Cloudflare Worker exposing the engine9 client API.

  Bindings expected (see wrangler.toml.example):
    DB          -- D1 database (the engine9 database)
    API_KEYS    -- KV namespace for API keys (optional: use SqlApiKeyStore instead)
    LOG_BUCKET  -- R2 bucket for batch modification logs (optional)

  Vars / secrets:
    E9_ACCOUNT_ID      -- account identifier used in logs
    E9_PLUGIN_ID       -- plugin id (UUID) used for people writes
    E9_ALLOWED_ORIGINS -- optional comma-separated browser origins (independent hosts)
    SESSION_SECRET     -- secret; turns on login (/auth/*). `e9core setup --remote`
                          copies it from .env. Without it /auth/* answers 501.
    DELEGATE_URL       -- optional; default https://delegate.engine9.ai
    E9_DOMAIN          -- optional JWT aud (host[:port]). Default: the request's
                          own Origin/Host, which is right when pages and /api
                          share one hostname.
    The setup wizard is not mounted here. It runs only on `e9core serve`.

  Roles (segment UUIDs with scopes / requiredAuth) are site code: add them to
  `config.roles` below. See docs/identityProviders/delegate.md.

  Plugins: only those compiled into the bundle run. `@engine9/core/plugins/site`
  is every interface unless wrangler aliases it to the site's
  engine9.plugins.js (`npx e9core build-plugins`).
*/
import PersonWorker from '@engine9/core/PersonWorker';
import plugins from '@engine9/core/plugins/site';
import { KVApiKeyStore, SqlApiKeyStore } from '@engine9/core/auth';
import { BatchLogger, NullLogger, r2Sink } from '@engine9/core/logging';
import { createApi } from '@engine9/core/api';
import { PersonIdentifierDO } from '@engine9/core/id';

export { PersonIdentifierDO };

export default {
  async fetch(request, env, ctx) {
    const worker = new PersonWorker({
      accountId: env.E9_ACCOUNT_ID || 'cloudflare',
      d1: env.DB,
      personIds: env.PERSON_IDS,
      plugins
    });
    // Prefer SQL api_key table; API_KEYS KV is optional (not required for auth).
    const keyStore = env.API_KEYS ? new KVApiKeyStore({ kv: env.API_KEYS }) : new SqlApiKeyStore({ worker });
    const logger = env.LOG_BUCKET ? new BatchLogger({ sink: r2Sink(env.LOG_BUCKET) }) : new NullLogger();
    const api = createApi({
      worker,
      keyStore,
      logger,
      // Login with the default identity provider (delegate) when the secret is set.
      delegate: env.SESSION_SECRET
        ? {
            sessionSecret: env.SESSION_SECRET,
            delegateUrl: env.DELEGATE_URL,
            domain: env.E9_DOMAIN
          }
        : null,
      kvEnv: env.PERSON_ID_DELEGATE_KV ? env : null,
      config: {
        pluginId: env.E9_PLUGIN_ID,
        defaultRemoteInputId: 'website',
        upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
        allowedOrigins: env.E9_ALLOWED_ORIGINS || '',
        roles: {
          // '<segment-uuid>': { name: 'Admin', scopes: ['admin'], requiredAuth: { minLevel: 3 } }
        },
        reads: {
          // add site-specific read definitions here, e.g.:
          // content: { table: 'member_content', segmentId: '<segment uuid>' }
        }
      }
    });
    return api.handleFetch(request, { basePath: '/api', ctx });
  }
};
