/*
  Example Cloudflare Worker exposing the Engine9 client API.

  Bindings expected (see wrangler.toml.example):
    DB          -- D1 database (the engine9 database)
    API_KEYS    -- KV namespace for API keys (optional: use SqlApiKeyStore instead)
    LOG_BUCKET  -- R2 bucket for batch modification logs (optional)

  Vars:
    E9_ACCOUNT_ID  -- account identifier used in logs
    E9_PLUGIN_ID   -- plugin id (UUID) used for people writes; create it once
                      with `e9client install` + a plugin row, or set any
                      stable UUID from getPluginUUID()
*/
import PersonWorker from '@engine9/client/PersonWorker';
import { KVApiKeyStore, SqlApiKeyStore } from '@engine9/client/auth';
import { BatchLogger, NullLogger, r2Sink } from '@engine9/client/logging';
import { createApi } from '@engine9/client/api';
import { PersonIdentifierDO } from '@engine9/client/id';

export { PersonIdentifierDO };

export default {
  async fetch(request, env, ctx) {
    const worker = new PersonWorker({
      accountId: env.E9_ACCOUNT_ID || 'cloudflare',
      d1: env.DB,
      personIds: env.PERSON_IDS
    });
    const keyStore = env.API_KEYS ? new KVApiKeyStore({ kv: env.API_KEYS }) : new SqlApiKeyStore({ worker });
    const logger = env.LOG_BUCKET ? new BatchLogger({ sink: r2Sink(env.LOG_BUCKET) }) : new NullLogger();
    const api = createApi({
      worker,
      keyStore,
      logger,
      config: {
        pluginId: env.E9_PLUGIN_ID,
        defaultRemoteInputId: 'website',
        upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
        reads: {
          // add site-specific read definitions here, e.g.:
          // content: { table: 'member_content', segmentId: '<segment uuid>' }
        }
      }
    });
    return api.handleFetch(request, { basePath: '/api', ctx });
  }
};
