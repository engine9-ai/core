/*
  Example Cloudflare Worker exposing the engine9 client API.

  Bindings expected (see wrangler.toml.example):
    DB          -- D1 database (the engine9 database)
    API_KEYS    -- KV namespace for API keys (optional: use SqlApiKeyStore instead)
    LOG_BUCKET  -- R2 bucket for batch modification logs (optional)
    SESSION_REVOCATIONS -- KV namespace (optional); logout revokes the Core
                           Session instead of only clearing the cookie

  Vars / secrets:
    E9_ACCOUNT_ID      -- account identifier used in logs
    E9_PLUGIN_ID       -- plugin id (UUID) used for people writes
    E9_ALLOWED_ORIGINS -- optional comma-separated browser origins (independent hosts)
    E9_SUPERADMINS     -- optional comma-separated verified emails that act as this
                          site's admin role (Identity Level 3 or higher)
    SESSION_SECRET     -- secret; turns on login (/auth/*). `e9core setup --remote`
                          stores production's own (.env.production). Without it
                          /auth/* answers 501.
    DELEGATE_URL       -- optional; default https://delegate.network
    E9_DOMAIN          -- optional JWT aud (host[:port]). Default: the request's
                          own Origin/Host, which is right when pages and /api
                          share one hostname.
    E9_SIGN_IN         -- optional JSON for GET /api/auth/start (one-link sign-in):
                          {"brand":{"name":"My Site","color":"#7a1fa2"},"fields":["email"]}.
                          Default: Level 1, email, Google only. Delegate opens
                          a single provider by itself.
    The setup wizard is not mounted here. It runs only on `e9core serve`.

  Roles (segment UUIDs with scopes / requiredAuth) are site code: add them to
  `config.roles` below. See docs/identityProviders/delegate.md.

  Plugins: only those compiled into the bundle run. wrangler aliases
  `@engine9/core/plugins/site` to the site's engine9.plugins.js, which its
  build step writes from package.json "engine9.pluginPackages" (e9core setup
  configures both).
*/
import PersonWorker from '@engine9/core/PersonWorker';
import pluginEntries, { packageVersions } from '@engine9/core/plugins/site';
import { createPluginRegistry } from '@engine9/core/pluginRegistry';
import { KVApiKeyStore, SqlApiKeyStore } from '@engine9/core/auth';
import { BatchLogger, NullLogger, r2Sink } from '@engine9/core/logging';
import { createApi } from '@engine9/core/api';
import { superadminsFromText } from '@engine9/core/auth/superadmins';
import { PersonIdentifierDO } from '@engine9/core/id';

export { PersonIdentifierDO };

function parseSignIn(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error('E9_SIGN_IN must be a JSON object');
  }
}

const plugins = pluginEntries
  ? createPluginRegistry(pluginEntries, { packageVersions: packageVersions || {} })
  : null;

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
            domain: env.E9_DOMAIN,
            sessionRevocations: env.SESSION_REVOCATIONS || null
          }
        : null,
      kvEnv: env.PERSON_ID_DELEGATE_KV ? env : null,
      config: {
        pluginId: env.E9_PLUGIN_ID,
        defaultRemoteInputId: 'website',
        upsertTables: ['person_name', 'person_email', 'person_phone', 'person_address', 'person_segment'],
        allowedOrigins: env.E9_ALLOWED_ORIGINS || '',
        signIn: parseSignIn(env.E9_SIGN_IN),
        roles: {
          // '<segment-uuid>': { name: 'Admin', scopes: ['admin'], requiredAuth: { minLevel: 3 } }
        },
        // Verified emails (Level 3+) that act as this site's admin role. Set
        // E9_SUPERADMINS in the Worker vars; changes take effect at deploy.
        superadmins: superadminsFromText(env.E9_SUPERADMINS),
        reads: {
          // add site-specific read definitions here, e.g.:
          // content: { table: 'member_content', segmentId: '<segment uuid>' }
        }
      }
    });
    // A pre-launch gate for a page this Worker serves (see auth/gate.js):
    //   import { requireRole } from '@engine9/core/auth/gate';
    //   const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' });
    //   if (!gate.ok) return gate.response;
    return api.handleFetch(request, { basePath: '/api', ctx });
  }
};
