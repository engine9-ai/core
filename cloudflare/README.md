# `@engine9/core` on Cloudflare

First-time setup (plain language, including D1): [docs/deploy.md](../docs/deploy.md).
This file is the shorter technical reference.

`@engine9/core` is a standalone library. On Cloudflare it creates an
engine9-standard database in D1 and serves the standard endpoints from a
Worker. D1 can be the site’s primary database, or the engine9 database beside
one you already run. The schemas it installs come from the public
[`@engine9/interfaces`](https://github.com/engine9-io/interfaces) package.

Call `PersonWorker.installStandard()` (or `e9core installStandard` from
[`bin/e9core.js`](../bin/e9core.js)) to deploy plugin rows and tables, or
generate SQL for one interface with `e9core sqlite-ddl --schema …` and apply
it as a wrangler migration. Then serve the people, upsert, and read API from
a Worker.

> These `e9core …` commands are this package’s CLI. The private server’s
> WorkerRunner is `e9`, for databases that are already engine9-capable.
> See [The e9core CLI](../README.md#the-e9core-cli).

## What runs where

| Piece | Cloudflare service |
| --- | --- |
| engine9 database | D1 (SQLite dialect) |
| API endpoints | Worker (`api.handleFetch`) |
| API keys | KV (`KVApiKeyStore`) or the `api_key` D1 table (`SqlApiKeyStore`) |
| Identity-provider id cache | KV `PERSON_ID_DELEGATE_KV` — used by the default provider. See [docs/identityProviders/delegate.md](../docs/identityProviders/delegate.md) |
| Segment membership cache | KV `PERSON_SEGMENT_VK` — edge cache of `person_segment` (`@engine9/core/cloudflare/kv`) |
| Modification logs | R2 batch objects (`BatchLogger` + `r2Sink`), flushed via `ctx.waitUntil` |

> **Cloudflare-only KV caches.** `PERSON_ID_DELEGATE_KV` and `PERSON_SEGMENT_VK`
> exist only on Cloudflare-style deployments, and only matter after you turn
> on an identity provider. Generic Node / MySQL sites read the same rows from
> SQL. D1 remains the source of truth. The binding name matches the default
> provider; see [docs/identityProviders/delegate.md](../docs/identityProviders/delegate.md).

## Install

The usual path writes `wrangler.jsonc` for you, including the D1 database id:

```bash
npx wrangler login
npm install @engine9/core
npx e9core setup
npx e9core setup --remote
```

See [docs/deploy.md](../docs/deploy.md). The steps below are the same work,
one piece at a time.

1. **Install the library**

   ```bash
   npm install @engine9/core
   ```

2. **Create the D1 database**

   ```bash
   wrangler d1 create engine9
   ```

3. **Generate the schema migration**

   Live plugin install deploys plugin rows and tables:

   ```bash
   npx e9core installStandard --db sqlite://./engine9.db
   ```

   Or print SQLite DDL for one interface and apply it as a wrangler migration:

   ```bash
   npx e9core sqlite-ddl --schema @engine9/interfaces/plugin > migrations/0001_plugin.sql
   wrangler d1 migrations apply engine9 --remote
   ```

   > The people pipeline is woven from the `plugin` rows. DDL-only migrations
   > create tables but no rows, so `installStandard` (which writes the rows and
   > their `transforms.inbound` snapshot) is required before people writes.
   > Re-run it after upgrading `@engine9/interfaces` to refresh the snapshots;
   > the Worker cannot import interface packages at runtime to fill them in.

4. **Create the plugin row and an API key**

   Every people write is attributed to a plugin (your website). Insert a site
   plugin row after `installStandard` (or after applying plugin-table DDL),
   then create an API key:

   ```bash
   # keys stored in D1 (or use KVApiKeyStore in a setup script for KV)
   npx e9core create-api-key --db sqlite://./local-copy.db --name website --scopes people:write,tables:write,data:read
   ```

   The plaintext key (`e9key_...`) is printed once; only its SHA-256 hash is
   stored.

5. **Configure wrangler**

   `npx e9core setup` writes `wrangler.jsonc` (Worker entry, `nodejs_compat`,
   the D1 binding, and `E9_PLUGIN_ID`). Copy from `wrangler.toml.example` only
   when you want the optional KV or R2 bindings. The important parts:

   - `compatibility_flags = ["nodejs_compat"]` (the library uses `node:crypto`
     and `node:buffer`)
   - the `[alias]` mapping `@engine9/input-tools` to
     `@engine9/core/cloudflare/input-tools-shim`, which keeps Node-only
     dependencies (AWS SDK, archiver, googleapis) out of the Worker bundle

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

# create/update a person (the standard inbound people pipeline)
curl -X POST https://your-worker.example.workers.dev/api/people \
  -H "Authorization: Bearer e9key_..." -H "Content-Type: application/json" \
  -d '{"people":[{"email":"alice@example.com","given_name":"Alice","source_code":"WEB_SIGNUP"}]}'

# person-related upsert (event attendance, segment membership, ...)
curl -X POST https://your-worker.example.workers.dev/api/upsert/person_segment \
  -H "Authorization: Bearer e9key_..." -H "Content-Type: application/json" \
  -d '{"rows":[{"segment_id":"<uuid>","person_id":123}]}'

# segment-gated read; person_id supplied by the caller (for example after login)
curl "https://your-worker.example.workers.dev/api/read/content?person_id=123" \
  -H "Authorization: Bearer e9key_..."
```

## KV caches (Cloudflare only)

Optional. Skip these until login works. `PERSON_SEGMENT_VK` caches segment
membership. `PERSON_ID_DELEGATE_KV` is the default identity provider’s
person-id cache; key layout is in
[docs/identityProviders/delegate.md](../docs/identityProviders/delegate.md).
D1 stays the source of truth.

### `PERSON_SEGMENT_VK` — cache of `person_segment`

| Key | Value |
| --- | --- |
| `seg:<segment_id>:<person_id>` | ISO timestamp (existence = member) |

## Modification logs

Every successful write is committed to D1 first, then appended to the
modification log. With the R2 sink, each request's batch is written as a
timestamped `.jsonl` object under `modifications/` for long-term storage and
downstream processing by any library that reads the engine9 standard,
including the private server when this D1 database is engine9-capable.
