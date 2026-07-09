# @engine9/client

Slim Engine9 deployment for websites: a JavaScript library plus API endpoints
that run alongside an existing site, using the same core code as the full
Engine9 server (which depends on this package).

## Responsibilities

The client is the minimum needed for a functioning website:

- **Create/update the engine9 database from scratch** -- standardize, diff, and
  deploy the standard interface schemas (person, person_email, person_phone,
  person_address, segment, timeline, source_code, transaction, plugin) on
  SQLite, Cloudflare D1, or MySQL (`SchemaWorker`, `e9client install`).
- **Install plugins** -- plugin rows and their schemas (`SchemaWorker.install`).
- **Authenticate with API keys** -- pluggable key stores (SQL table or
  Cloudflare KV), SHA-256 hashed at rest, scoped, revocable
  (`@engine9/client/auth`, `e9client create-api-key`). The auth layer is
  isolated from the API handlers for easy upgrades.
- **Create/update single people in real time** -- the exact `loadPeople`
  inbound pipeline (normalize, extract identifiers, resolve input, assign
  person ids with deduplication, resolve source codes, upsert person/email/
  phone tables), restructured for in-memory request batches
  (`PersonWorker.processPeople`, `POST /people`).
- **Upsert person-related data** -- event attendance, segment membership,
  etc., using the same table upsert logic as the server
  (`SQLWorker.upsertArray`, `POST /upsert/:table` with an allowlist).
- **Read content for the website gated by segments** -- configured reads
  optionally gated by `person_segment` membership; the `person_id` is provided
  by the caller (e.g. via delegate), never looked up (`GET /read/:name`).
- **Log every modification** -- database write first, then a record to the
  modification log: JSONL files for generic deployments, Cloudflare-style
  batch logging (R2/Queues) for Workers (`@engine9/client/logging`).

Everything else -- person exports, file processing (FileWorker), messaging,
reports, EQL search, scheduled jobs, remote plugin execution -- stays in the
server (`@engine9/server`), which imports its shared SQL/utility code from
this package.

## Deployment targets

- **Cloudflare Workers + D1 (tier 1)** -- see [cloudflare/README.md](cloudflare/README.md)
- **Generic Node** -- Express or any HTTP framework, with SQLite
  (better-sqlite3) or MySQL via optional knex peer dependencies

## Quick start (Node + SQLite)

```bash
npm install @engine9/client better-sqlite3 knex

# create the database and an API key
npx e9client install --db sqlite://./engine9.db
npx e9client create-api-key --db sqlite://./engine9.db --name website
```

```js
import { PersonWorker, SqlApiKeyStore, JsonlFileLogger, createApi } from '@engine9/client';

const worker = new PersonWorker({
  accountId: 'my-account',
  auth: { database_connection: 'sqlite://./engine9.db' }
});
const api = createApi({
  worker,
  keyStore: new SqlApiKeyStore({ worker }),
  logger: new JsonlFileLogger({ directory: './logs' }),
  config: {
    pluginId: '<uuid of the website plugin row>',
    upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
    reads: { content: { table: 'member_content', segmentId: '<segment uuid>' } }
  }
});

// Express
app.use('/api', express.json(), api.expressHandler());
```

## Endpoints

| Endpoint | Purpose | Scope |
| --- | --- | --- |
| `GET /ok` | health check (no auth) | -- |
| `POST /people` | run `{ people: [...] }` through the inbound person pipeline and upsert | `people:write` |
| `POST /upsert/:table` | upsert `{ rows: [...] }` into an allowlisted person-related table | `tables:write` |
| `GET /read/:name` | read a configured table, optionally gated by `person_segment` (`?person_id=`) | `data:read` |

Keys are passed as `Authorization: Bearer e9k_...` or `X-API-Key: e9k_...`.
Keys with no scopes recorded have full access.

## Package layout

- `lib/utilities.js` -- shared environment-agnostic utilities (canonical copy; the server re-exports these)
- `lib/ids.js` -- portable UUID/timeline id helpers (same algorithms as `@engine9/input-tools`)
- `lib/sql/shared.js` -- the canonical table upsert logic shared with the server
- `lib/sql/dialects/` -- MySQL and SQLite dialects (SQLite serves D1)
- `lib/sql/sqliteDDL.js` -- native SQLite/D1 DDL generation (no knex needed)
- `lib/SQLWorker.js` -- query/upsert/DDL over D1, better-sqlite3, or mysql2
- `lib/SchemaWorker.js` -- standardize/diff/deploy schemas, install plugins
- `lib/PersonWorker.js` -- the inbound person pipeline (`processPeople`)
- `auth/` -- API key creation/verification, SQL + KV stores
- `logging/` -- JSONL file logger and batch logger (R2 sink included)
- `api/` -- framework-agnostic endpoint handlers (fetch + Express adapters)
- `cloudflare/` -- Worker example, wrangler config, input-tools shim, install guide
- `bin/e9client.js` -- `install`, `create-api-key`, `diff`, `sqlite-ddl`

## Tests

```bash
npm test
```

Runs the SQLite-backed test suite: DDL round trips, schema bootstrap
idempotency, the full person pipeline (dedupe/update/read-only), and the API
surface (auth, scopes, segment gating, modification logs).
