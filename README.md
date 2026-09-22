# @engine9/core

engine9 is a set of standards for a people database and the HTTP endpoints
that read and write it, and a set of libraries that implement those standards.
The same table names, field names, person pipeline, and API-key scopes show up
in every library that speaks engine9.

`@engine9/core` is the standalone library that creates that database and those
endpoints. Use the engine9 database as the primary database for a site, or run
it with another database you already have: point the library at an existing
SQLite or MySQL connection, or keep a separate engine9 database beside your
application database. Either way you get the standard tables and the same API.

Other public libraries use the same standard:

| Library                                                           | What it is                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@engine9/interfaces`](https://github.com/engine9-io/interfaces) | Published schemas and inbound transforms (`person`, `person_email`, segments, and the rest). `installStandard` deploys these into your database. |
| [`@engine9/id`](https://github.com/engine9-ai/id)                 | Browser client. Verifies Identity Tokens and, when a site has core, posts them to these endpoints.                                               |
| [`demo-festival`](https://github.com/engine9-ai/demo-festival)                      | A festival site (Astro, SQLite, optional Cloudflare D1) that uses core and id together.                                                          |

Many other libraries and plugins follow the same schemas and pipeline slots, including that that add in MCP servers, messagings, reports, search, etc, etc.

New website: **[docs/deploy.md](docs/deploy.md)**.

## What the library creates

- **A standard database** — `PersonWorker.installStandard()` or
  `e9core installStandard --db …` loads stack include/exclude metadata
  (local `@engine9/interfaces` or GitHub `stack.json`) and deploys plugin rows
  and tables on D1, SQLite, or MySQL. Pass `{ path }` for a different stack.
- **HTTP endpoints** — people writes, allowlisted upserts, segment-gated reads,
  and optional login. See [Endpoints](#endpoints).
- **API keys** — SHA-256 hashed at rest, scoped, revocable, rotatable
  (`@engine9/core/auth`, `SQLWorker.createApiKey`, `e9core create-api-key`).
  `SqlApiKeyStore` uses the `api_key` table. `KVApiKeyStore` is an optional
  Cloudflare store.
- **The inbound people pipeline** — the same normalize → identify → assign →
  upsert chain used anywhere an engine9-capable database accepts people
  (`PersonWorker.processPeople`, `POST /people`).
- **Optional login** — storing people uses an API key. Production login
  defaults to delegate
  ([docs/identityProviders/delegate.md](docs/identityProviders/delegate.md)).
  The Site verifies an Identity Token, maps that provider’s user id to a
  `person_id`, reads roles from `person_segment`, and may mint a Core Session.

A database is engine9-capable when it has these standard tables and plugin
rows. Core creates that database. Any other library that understands the
standard can use it afterward, including the private server.

## Quick start (Node + SQLite)

```bash
npm install @engine9/core
npx e9core setup --node
```

That writes tables and API keys into `engine9.db` and `.env`. The same pieces,
one at a time:

```bash
npx e9core installStandard --db sqlite://./engine9.db
npx e9core create-api-key --db sqlite://./engine9.db --name website --scopes admin
npx e9core create-api-key --db sqlite://./engine9.db --name public --scopes public
```

`installStandard` creates tables and plugin rows.
`e9core sqlite-ddl --schema @engine9/interfaces/person` prints one schema’s
SQL if you prefer to apply it yourself.

```js
import {
  PersonWorker,
  SqlApiKeyStore,
  JsonlFileLogger,
  createApi,
} from "@engine9/core";

const worker = new PersonWorker({
  accountId: "my-account",
  auth: { database_connection: "sqlite://./engine9.db" }, // mysql://… also works
});
const api = createApi({
  worker,
  keyStore: new SqlApiKeyStore({ worker }),
  logger: new JsonlFileLogger({ directory: "./logs" }),
  config: {
    pluginId: "<uuid of the website plugin row>",
    upsertTables: [
      "person_email",
      "person_phone",
      "person_address",
      "person_segment",
    ],
    reads: {
      content: { table: "member_content", segmentId: "<segment uuid>" },
    },
  },
});

// Express
app.use("/api", express.json(), api.expressHandler());

// Rotate: const { key } = await new SqlApiKeyStore({ worker }).rotate({ id });
```

Cloudflare (D1 as the engine9 database): `npx e9core setup`, then
`npx e9core setup --remote`. Details in [docs/deploy.md](docs/deploy.md) and
[cloudflare/README.md](cloudflare/README.md).

To install the standard tables into a database you already run:

```bash
npx e9core installStandard --db mysql://user:pass@host/dbname
```

## The `e9core` CLI

`@engine9/core` publishes npm `bin.e9core` → [`bin/e9core.js`](bin/e9core.js).
Commands run against a DB URL (`--db` or `ENGINE9_DATABASE_CONNECTION`):
`setup`, `installStandard`, `create-api-key`, `sqlite-ddl`. There is no
account directory.

People who already have an engine9-capable database and a checkout of the
private server use a different program, `e9`, for account-scoped workers
(`e9 personworker installStandard -a <account_id>`).

```bash
# This library — SQLite file, D1 local file, or MySQL
npx e9core installStandard --db sqlite://./engine9.db
npx e9core create-api-key --db sqlite://./engine9.db --name website --scopes admin

# Private server, on a database that is already engine9-capable
e9 personworker installStandard -a <account_id>
e9 sqlworker createApiKey -a <account_id> --name website --scopes admin
```

## Authentication

Three layers. API keys are the generic auth for non-session callers (signup
and payment forms, inbound people, and other HTTP APIs). Scopes decide access.
The private server’s Task API uses the same keys. These routes authenticate
with an API key; that server’s MCP login is a different credential.

```
Request
  → 1. API key          (required on core APIs except GET /ok)
  → 2. Role             (role_id === segment_id UUID)
  → 3. Identity Level   (credential level on the signed session, when login is on)
  → handler
```

### Layer 1 — API key

- Every core API request except `GET /ok` needs a valid key:
  `Authorization: Bearer e9key_…` or `X-API-Key: e9key_…`.
- Keys are SHA-256 hashed at rest (`SqlApiKeyStore` / `KVApiKeyStore`).
- Fields: `scopes` (required, non-empty), `default_role_id` (segment UUID used
  when no role is specified), `active`, `expires_at`.
- **Store:** `SqlApiKeyStore` in the engine9 database. `KVApiKeyStore` is
  optional and Cloudflare-only.
- **Cycle:** `store.rotate({ id })` (SQL) or `store.rotate({ keyHash })` (KV)
  creates a new key and revokes the old one.
- **Rate / volume:** not built in — hook on `apiKey.id` after `verify()`.

### Scopes

| Scope            | Surface                 | Allows                                            |
| ---------------- | ----------------------- | ------------------------------------------------- |
| `people:write`   | `POST /people`          | Inbound people pipeline                           |
| `tables:write`   | `POST /upsert/:table`   | Allowlisted table upserts                         |
| `data:read`      | `GET /read/:name`       | Configured reads                                  |
| `tasks:read`     | Private server Task API | List/read flows; check run status                 |
| `tasks:schedule` | Private server Task API | Schedule work on an engine9-capable database      |
| `admin`          | Any                     | All scopes                                        |
| `public`         | Inbound / forms         | Public ingest; keys use the `e9publickey_` prefix |

Keys must list scopes at creation. Empty scopes deny every check. Prefix
follows scope: `public` → `e9publickey_…`, otherwise `e9key_…`. Constants:
`SCOPES` from `@engine9/core` (`PEOPLE_WRITE`, `TABLES_WRITE`, `DATA_READ`,
`TASKS_READ`, `TASKS_SCHEDULE`, `ADMIN`, `PUBLIC`).

`SQLWorker.createApiKey` deploys the `api_key` table if needed, then creates
the hashed key. The plaintext value is returned once.

```bash
npx e9core create-api-key --db sqlite://./engine9.db \
  --name partner-tasks --scopes tasks:read,tasks:schedule

npx e9core create-api-key --db sqlite://./engine9.db \
  --name site-admin --scopes admin
```

On a database that also runs the private server, key management goes through
that repo’s `apiKey` tools so plaintext is not stored in task output.

### Layer 2 — Role (`role_id` = `segment_id`)

Roles are segments. Session and APIs use the segment UUID as `role_id`.

```js
roles: {
  '<segment-uuid>': {
    name: 'Admin',          // public display name
    scopes: ['admin'],      // or a concrete list: people:write, data:read, …
    requiredAuth: {         // optional identity-provider gate
      twoFactor: false,
      minLevel: 2
    }
  }
}
```

Soft **declared roles** (same `requiredAuth` shape, no `person_id`) live in
[`@engine9/id`](https://github.com/engine9-ai/id/blob/main/docs/declared-roles.md)
for browser personalization. See also
[`demo-id`](https://github.com/engine9-ai/demo-id) and the festival
[`demo-festival`](https://github.com/engine9-ai/demo-festival).

Legacy `roleSegments: { admin: '<uuid>' }` is still accepted and normalized
into the UUID-keyed registry.

**Scope resolution** (the key is always the ceiling):

- No key scopes → deny
- No role, or a role with empty scopes → key scopes only
- Both set → intersection; `admin` on one side means that side does not constrain

`auth.changeRole({ personId, roleId, exclusive?, session? })` and
`POST /auth/role` change the role. Role change expects an identity provider.
The default provider is delegate.

### Layer 3 — Identity provider

Optional. People APIs work with an API key alone. Production defaults to
delegate: [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md).

After the Site verifies an Identity Token, the Core Session carries `level`,
`profileId`, and `auth` from that provider. Roles may declare `requiredAuth`
(`minLevel`, `twoFactor`). `resolveAuthContext` enforces it on API routes when
a role is active. Provider-specific ids and token fields are documented only
in that provider’s file.

Policy helper: `resolveAuthContext` from `@engine9/core/auth` (or
`@engine9/core/auth/policy`). See [auth/README.md](auth/README.md).

## Endpoints

| Endpoint              | Purpose                                                                                                                     | Scope                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /ok`             | health check (no auth)                                                                                                      | —                                   |
| `POST /people`        | run `{ people: [...] }` through the inbound person pipeline and upsert                                                      | `people:write`                      |
| `POST /upsert/:table` | upsert `{ rows: [...] }` into an allowlisted person-related table                                                           | `tables:write`                      |
| `GET /read/:name`     | read a configured table, optionally gated by `person_segment` (`?person_id=`)                                               | `data:read`                         |
| `POST /auth/login`    | exchange an identity-provider token for a Core Session                                                                      | API key                             |
| `GET /auth/me`        | current User (`personId`, `roles`, `level`, profile)                                                                        | API key + session or Identity Token |
| `POST /auth/logout`   | `{ loggedOut: true }` (cookie clear is the host's job)                                                                      | API key                             |
| `POST /auth/role`     | change role (`{ role_id, person_id?, exclusive?, session_token? }`); session or token must match `person_id` unless `admin` | API key                             |

Keys are passed as `Authorization: Bearer e9key_...` or `X-API-Key: e9key_...`.
Effective scopes are the intersection of the active role and the API key.
Empty key scopes deny every check. `admin` grants every scope. Roles with
empty scopes do not constrain the key.

A Core Session is an HMAC token the **host** delivers (`Cookie` via
`createSessionCookieHeaders`, or `X-Engine9-Session`). An Identity Token JWT
may be sent as `Authorization: Bearer` (three segments, not `e9key_` /
`e9publickey_`) together with `X-API-Key`.

The same keys authorize the private server’s Task API (`tasks:read`,
`tasks:schedule`) when that database is engine9-capable and the server is in use.

## Identity provider

Storing people (`POST /people`) needs an API key. An identity provider is
optional, including for local development.

Production defaults to **delegate**. Provider-specific setup (token fields,
UNID) lives in
[docs/identityProviders/delegate.md](docs/identityProviders/delegate.md).
The browser library is [`@engine9/id`](https://github.com/engine9-ai/id).

### Authentication and authorization

- **Authentication** answers who is present: an API key for the caller and,
  when login is on, an Identity Token or Core Session for the User.
- **Authorization** answers what they may do: key scopes ∩ role scopes, plus
  `requiredAuth` (`minLevel`, `twoFactor`).
- Identity **Levels** (0–7) are confidence. A Level 4 User may still lack a
  segment role.
- **Roles** are Site authorization (`role_id === segment_id`).

### When a session helps

A Core Session is an optional HMAC cache of `personId`, `roles`, `level`, and
`auth` after the Site has verified an Identity Token. The host signs it with
`SESSION_SECRET` and delivers it (HttpOnly cookie or `X-Engine9-Session`).
Later requests check that signature locally. They do not call the identity
provider again. The browser can instead send the Identity Token as
`Authorization: Bearer` on each request. Mint a session when you want fewer
provider lookups.

`openssl rand -hex 32` creates the secret. `e9core setup-keys` writes the
same kind of value. How the token is built, and which calls still hit Delegate:
[auth/README.md](auth/README.md#local-session-session_secret).

### Roles `minLevel`

`requiredAuth.minLevel` is a number. `meetsRequiredAuth` requires
`credentialLevel.level >= minLevel` (session `level`, else `auth.level`) and
still enforces `twoFactor` when that flag is true.

### `/auth/*` endpoints

Every route except `GET /ok` requires an API key. Request body field names for
the default provider are in
[docs/identityProviders/delegate.md](docs/identityProviders/delegate.md).

| Endpoint            | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `POST /auth/login`  | Exchange an identity-provider token for `{ session, token }`         |
| `GET /auth/me`      | Current User, or 401                                                 |
| `POST /auth/logout` | `{ loggedOut: true }` — the host clears its cookie                   |
| `POST /auth/role`   | `{ role_id, person_id? }` plus a session or token, or an `admin` key |

`POST /auth/role` rejects a bare `person_id` unless the session `personId`
matches or the key or role has the `admin` scope.

## Plugin paths

`@engine9/core/pluginPaths` treats plugin rows, stack `include` / `exclude`
lists, and `stacks[]` as **package identity only** — paths like
`@engine9/interfaces/person`. The loader (this process, or the private server
on an engine9-capable database) resolves that identity to a module. The load
location is never part of `plugin.path`.

Legacy `local$@engine9/...` strings are accepted as an input alias and
normalized by stripping `local$`.

## Package layout

- `lib/utilities.js` — shared environment-agnostic utilities
- `lib/sql/shared.js` — canonical table upsert logic
- `lib/sql/dialects/` — MySQL and SQLite dialects (SQLite serves D1)
- `lib/sql/sqliteDDL.js` — native SQLite/D1 DDL generation (no knex needed)
- `lib/sql/standardizeSchema.js` — dialect-aware column standardization used by SchemaWorker and `e9core sqlite-ddl`
- `lib/SQLWorker.js` — query, upsert, and DDL over D1, better-sqlite3, or mysql2; API-key helpers wrap `SqlApiKeyStore`
- `lib/SchemaWorker.js` — standardize / diff / deploy interface schemas
- `lib/PluginWorker.js` — plugin rows, stack install, `installStandard`, `bootstrapAccount`
- `lib/pluginPaths.js` — plugin-path matcher (package identity; legacy `local$` alias)
- `lib/stackMetadata.js` — `loadStackMetadata`: stack include/exclude (local package or GitHub)
- `lib/PersonWorker.js` — inbound person pipeline (`processPeople`) plus `installStandard`
- `lib/peoplePipeline/` — shared inbound transform chain. See [lib/peoplePipeline/README.md](lib/peoplePipeline/README.md)
- `lib/id/` — person identifier stores (compact SQLite, legacy MySQL, Durable Objects)
- `auth/` — API key creation and verification, SQL and KV stores, policy and HMAC helpers. See [auth/README.md](auth/README.md)
- `auth/delegate.js` — default identity provider. See [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md)
- `logging/` — JSONL file logger and batch logger (R2 sink included)
- `api/` — framework-agnostic endpoint handlers (fetch and Express adapters)
- `cloudflare/` — Worker example, wrangler config, input-tools shim. See [cloudflare/README.md](cloudflare/README.md)
- `bin/e9core.js` — `setup`, `create-api-key`, `sqlite-ddl`, `installStandard`

## Tests

```bash
npm test
```

Runs the SQLite-backed suite: SQL round trips, applying the standard interface
tables, the person pipeline (dedupe, update, read-only), and the API surface
(auth, scopes, segment gating, modification logs).
