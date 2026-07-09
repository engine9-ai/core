# Engine9 Client on Cloudflare

Cloudflare Workers + D1 is a tier-1 deployment target for `@engine9/client`.
The D1 database *is* the engine9 database: the client creates the schema,
installs the standard interfaces, and serves the people/upsert/read API from a
Worker.

## What runs where

| Piece | Cloudflare service |
| --- | --- |
| Engine9 database | D1 (SQLite dialect) |
| API endpoints | Worker (`api.handleFetch`) |
| API keys | KV (`KVApiKeyStore`) or the `api_key` D1 table (`SqlApiKeyStore`) |
| Modification logs | R2 batch objects (`BatchLogger` + `r2Sink`), flushed via `ctx.waitUntil` |

## Install

1. **Add the client to your site**

   ```bash
   npm install @engine9/client
   ```

2. **Create the D1 database**

   ```bash
   wrangler d1 create engine9
   ```

3. **Generate the schema migration**

   The client generates native SQLite DDL from the standard Engine9 interface
   schemas (person, person_email, person_phone, person_address, segment,
   timeline, source_code, transaction, plugin):

   ```bash
   npx e9client sqlite-ddl > migrations/0001_engine9.sql
   wrangler d1 migrations apply engine9 --remote
   ```

   Alternatively, deploy directly from a Worker or script with a D1 binding:

   ```js
   import SchemaWorker from '@engine9/client/SchemaWorker';
   const schema = new SchemaWorker({ accountId: 'my-account', d1: env.DB });
   await schema.installStandard();
   ```

4. **Create the plugin row and an API key**

   Every people write is attributed to a plugin (your website). Insert a
   plugin row once (`installStandard` already created interface plugin rows;
   add one for the site) and create an API key:

   ```bash
   # keys stored in D1 (or use KVApiKeyStore in a setup script for KV)
   npx e9client create-api-key --db sqlite://./local-copy.db --name website --scopes people:write,tables:write,data:read
   ```

   The plaintext key (`e9k_...`) is printed once; only its SHA-256 hash is
   stored.

5. **Configure wrangler**

   Copy `wrangler.toml.example` into your project's `wrangler.toml`. The
   important parts:

   - `compatibility_flags = ["nodejs_compat"]` (the client uses `node:crypto`
     and `node:buffer`)
   - the `[alias]` mapping `@engine9/input-tools` to
     `@engine9/client/cloudflare/input-tools-shim`, which keeps server-only
     dependencies (AWS SDK, archiver, googleapis) out of the bundle

6. **Deploy**

   `worker.js` in this directory is a complete example fetch handler. Either
   point `main` at it or wrap `createApi(...)` in your own Worker:

   ```bash
   wrangler deploy
   ```

## Using the API

```bash
# health
curl https://your-worker.example.workers.dev/api/ok

# create/update a person (same pipeline as the server's loadPeople)
curl -X POST https://your-worker.example.workers.dev/api/people \
  -H "Authorization: Bearer e9k_..." -H "Content-Type: application/json" \
  -d '{"people":[{"email":"alice@example.com","given_name":"Alice","source_code":"WEB_SIGNUP"}]}'

# person-related upsert (event attendance, segment membership, ...)
curl -X POST https://your-worker.example.workers.dev/api/upsert/person_segment \
  -H "Authorization: Bearer e9k_..." -H "Content-Type: application/json" \
  -d '{"rows":[{"segment_id":"<uuid>","person_id":123}]}'

# segment-gated read; person_id supplied by the caller (e.g. via delegate)
curl "https://your-worker.example.workers.dev/api/read/content?person_id=123" \
  -H "Authorization: Bearer e9k_..."
```

## Modification logs

Every successful write is committed to D1 first, then appended to the
modification log. With the R2 sink, each request's batch is written as a
timestamped `.jsonl` object under `modifications/` for long-term storage and
downstream processing (e.g. periodic sync into the full Engine9 server).
