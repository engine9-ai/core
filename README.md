# @engine9/core

Slim Engine9 deployment for websites: a JavaScript library plus API endpoints
that run alongside an existing site, using the same core code as the full
Engine9 server (which depends on this package).

## Responsibilities

The client is the minimum needed for a functioning website:

- **Create/update the engine9 database from scratch** -- standardize, diff, and
  deploy the standard interface schemas (person, person_email, person_phone,
  person_address, segment, timeline, source_code, transaction, plugin) on
  SQLite, Cloudflare D1, or MySQL (`SchemaWorker`, `e9core install`).
- **Install plugins** -- plugin rows and their schemas (`SchemaWorker.install`).
- **Authenticate with API keys** -- pluggable key stores (SQL table or
  Cloudflare KV), SHA-256 hashed at rest, scoped, revocable
  (`@engine9/core/auth`, `e9core create-api-key`). The auth layer is
  isolated from the API handlers for easy upgrades.
- **Authenticate end users via delegate** -- the shared cross-organization
  auth service. `createDelegateAuth` exchanges delegate's one-time handoff
  codes server-to-server under `DELEGATE_SHARED_SECRET`, maps the delegate
  unid into a `person_id` through the normal identifier pipeline (id_type
  `delegate` → `person_id_delegate` on SQLite/D1), derives roles from
  `person_segment` membership, and signs local sessions carrying the reported
  credential level (`@engine9/core/auth/delegate`). See [Delegate
  authentication](#delegate-authentication) below.
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
  batch logging (R2/Queues) for Workers (`@engine9/core/logging`).

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
npm install @engine9/core better-sqlite3 knex

# create the database and an API key
npx e9core install --db sqlite://./engine9.db
npx e9core create-api-key --db sqlite://./engine9.db --name website
```

```js
import { PersonWorker, SqlApiKeyStore, JsonlFileLogger, createApi } from '@engine9/core';

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

## Delegate authentication

Delegate is Engine9's shared identity service. Sites built on `@engine9/core`
never talk to the identity provider directly — they use **core handoff**:

1. Browser goes to `{delegateUrl}/handoff/authorize?return_to=<your callback>`.
2. After login, delegate redirects to your callback with a one-time
   `?delegate_code=`.
3. Your server exchanges the code at `POST {delegateUrl}/handoff/exchange`
   with `Authorization: Bearer <DELEGATE_SHARED_SECRET>`.
4. Core maps the returned `unid` into a `person_id` (id_type `delegate`),
   snapshots roles from `person_segment`, and signs a local session cookie.

```js
import { createDelegateAuth } from '@engine9/core/auth/delegate';

const auth = createDelegateAuth({
  worker,                                    // PersonWorker for this site's DB
  delegateUrl: process.env.DELEGATE_URL,     // e.g. https://delegate.engine9.ai
  handoffSecret: process.env.DELEGATE_SHARED_SECRET,
  sessionSecret: process.env.SESSION_SECRET, // signs this site's cookie only
  pluginId: '<website plugin uuid>',
  remoteInputId: 'delegate-login',
  roleSegments: { admin: '<segment uuid>', vip: '<segment uuid>' }
});

// Start login
res.redirect(auth.loginUrl({ returnTo: 'https://yoursite.example/auth/delegate' }));

// Callback: exchange code → person + roles + signed token
const { session, token } = await auth.login(code);
```

`DELEGATE_SHARED_SECRET` must match the value configured on the delegate
deployment (comma-separated values allow rotation). `SESSION_SECRET` is local
to your site and never shared with delegate.

### When to use which mechanism

Delegate exposes **two** authorization mechanisms that share one secret
(`DELEGATE_SHARED_SECRET`) but serve different callers:

| Mechanism | Use when | What you get |
| --- | --- | --- |
| **Core handoff** (`/handoff/*`) | Your site runs `@engine9/core` and needs a local `person_id` session | One-time code → server exchange → identity (`unid`, email, credential level). You run the person pipeline yourself. |
| **Session bridge** (`/oauth/session-bridge`) | Your host is an Engine9 API server that already speaks Firebase sessions | Short-lived HMAC token carrying Firebase credentials so the API host can mint its own `engine9_session` cookie. |

Core sites always use handoff. Session bridge is for Engine9 API hosts (e.g.
`data.engine9.io`); see the delegate service README for that flow.

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
- `auth/delegate.js` -- delegate login via core handoff: code exchange, person
  resolution via id_type `delegate`, roles-as-segments, signed sessions
  (ships `delegate.d.ts` for TypeScript consumers)
- `logging/` -- JSONL file logger and batch logger (R2 sink included)
- `api/` -- framework-agnostic endpoint handlers (fetch + Express adapters)
- `cloudflare/` -- Worker example, wrangler config, input-tools shim, install guide
- `bin/e9core.js` -- `install`, `create-api-key`, `diff`, `sqlite-ddl`

## Tests

```bash
npm test
```

Runs the SQLite-backed test suite: DDL round trips, schema bootstrap
idempotency, the full person pipeline (dedupe/update/read-only), and the API
surface (auth, scopes, segment gating, modification logs).
