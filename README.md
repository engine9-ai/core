# @engine9/core

Slim engine9 deployment for websites: a JavaScript library plus API endpoints
that run alongside an existing site, using the same core code as the full
engine9 server (which depends on this package).

## engine9 auth map (three layers)

Validation for client/site APIs and the server **Task API** lives in
`@engine9/core` (layer 1 API keys). Keys are the generic auth for **non-session**
callers (signup/payment forms, inbound, tasks, and other HTTP APIs); **scopes**
decide access. MCP on `@engine9/server` uses Firebase / session / `localdev`
instead — do not mix those credentials with key-authenticated routes.

```
Request
  → 1. API key          (required on core APIs except GET /ok; required on Task API)
  → 2. Role             (role_id === segment_id UUID; core site APIs)
  → 3. Delegate level   (credential level on the signed session; core site APIs)
  → handler
```

### Layer 1 — API key

- Every core API request (except `GET /ok`) and every Task API request needs a
  valid key: `Authorization: Bearer e9key_…` or `X-API-Key: e9key_…`.
- Keys are SHA-256 hashed at rest (`SqlApiKeyStore` / `KVApiKeyStore`).
- Fields: `scopes` (required, non-empty), `default_role_id` (segment UUID used
  when no role is specified), `active`, `expires_at`.
- **Store:** prefer `SqlApiKeyStore` (account DB). `KVApiKeyStore` is optional
  Cloudflare-only; **not required** for Node/SQLite/MySQL or self-hosted sites.
- **Cycle:** `store.rotate({ id })` (SQL) or `store.rotate({ keyHash })` (KV)
  creates a new key and revokes the old one.
- **Rate / volume:** not built in — hook on `apiKey.id` after `verify()`
  (extension point for callers).
- **Task API:** key is verified in the account DB selected by
  `X-ENGINE9-ACCOUNT-ID` (see server Task admin auth docs / skills
  `e9-tasks-api/authentication.md`).

### Authentication and scopes

| Scope | Surface | Allows |
| --- | --- | --- |
| `people:write` | Core `POST /people` | Inbound people pipeline |
| `tables:write` | Core `POST /upsert/:table` | Allowlisted table upserts |
| `data:read` | Core `GET /read/:name` | Configured reads |
| `tasks:read` | Server Task API | List/read flows; check run status |
| `tasks:schedule` | Server Task API | Schedule via `scheduleTasks` |
| `admin` | Any | All scopes (replaces the old `*` wildcard) |
| `public` | Inbound / forms | Public ingest; keys use `e9publickey_` prefix |

Keys **must** list scopes at creation. Empty scopes deny every check. Prefix
follows scope: `public` → `e9publickey_…`, otherwise `e9key_…`. Constants:
`SCOPES` from `@engine9/core` (`PEOPLE_WRITE`, `TABLES_WRITE`, `DATA_READ`,
`TASKS_READ`, `TASKS_SCHEDULE`, `ADMIN`, `PUBLIC`).

`SQLWorker.createApiKey` deploys the `api_key` table if needed
(`SqlApiKeyStore.deploy`) then creates the hashed key. The plaintext value is
returned once. On an engine9 server, prefer MCP `apiKey` (`catalog` / `list` /
`get` / `create` / `update` / `revoke` / `rotate`) — it wraps this store so a
management UI can issue and edit keys without putting plaintext in task output.
See skills `e9-api-key`.

On an engine9 server account (`e9` + `accounts.d`):

```bash
e9 sqlworker createApiKey -a <account_id> \
  --name partner-tasks --scopes tasks:read,tasks:schedule
```

On a core-only site (no `e9` / accounts.d):

```bash
npx e9 create-api-key --db sqlite://./engine9.db \
  --name partner-tasks --scopes tasks:read,tasks:schedule
```

Full-access key (site admin / bootstrap):

```bash
npx e9 create-api-key --db sqlite://./engine9.db \
  --name site-admin --scopes admin
```

Do not schedule `createApiKey` via MCP `task` — the plaintext key must not be
stored in task run output. Use MCP `apiKey` instead.

### Layer 2 — Role (`role_id` = `segment_id`)

- Roles are segments. Session and APIs use the **segment UUID** as `role_id`.
- Site config (preferred):

```js
roles: {
  '<segment-uuid>': {
    name: 'Admin',          // public display name
    scopes: ['admin'],      // or a concrete list: people:write, data:read, …
    requiredAuth: {         // optional Delegate gate (enforced)
      twoFactor: false,
      minLevel: 2
    }
  }
}
```

- Legacy `roleSegments: { admin: '<uuid>' }` is still accepted and normalized
  into the UUID-keyed registry (deprecated).
- **Scope resolution** (key is always the ceiling):
  - No key scopes → deny
  - No role (or role with empty scopes) → key scopes only
  - Both set → intersection; `admin` on one side means that side does not constrain
- **Change role:** `auth.changeRole({ personId, roleId, exclusive?, session? })`
  and HTTP `POST /auth/role` on `createApi` (requires `delegateAuth`).
- Task API routes enforce **key scopes only** today (no role intersection).

### Layer 3 — Delegate Identity Level

- After verifying an Identity Token (or legacy handoff), the Core Session
  carries `level`, `profileId`, and `auth: { signInProvider, twoFactor,
  signInSecondFactor, authTime }` from Delegate.
- Roles may declare `requiredAuth` (`minLevel`, `twoFactor`);
  `resolveAuthContext` exposes `authSatisfied` and **enforces** it on API
  routes when a role is active (`meetsRequiredAuth`).
- **Two Delegate mechanisms** (do not mix):

| Mechanism | Caller | Result |
| --- | --- | --- |
| **Identity Token (JWT)** | Sites on `@engine9/core` | ES256 JWT → `unid` / `person_id` (no shared secret) |
| **Legacy handoff** (`/handoff/*`) | Existing Sites | Code/bridge + `DELEGATE_SHARED_SECRET` → same person + session |
| **Session bridge** (`/oauth/session-bridge`) | engine9 API hosts (`@engine9/server`) | Firebase credentials → `engine9_session` |

Shared HMAC helpers: `@engine9/core/auth/hmac` (`parseSharedSecrets`,
`signPayload`, `verifySignedPayload`). Server session-bridge keeps its own
copy of the same `encoded.sig` pattern; do not unify identity models.

Policy helper: `resolveAuthContext` from `@engine9/core/auth` (or
`@engine9/core/auth/policy`). See [auth/README.md](auth/README.md).

## The `e9` CLI (two binaries)

Both `@engine9/core` and `@engine9/server` publish npm `bin.e9`, but they are
**different programs** that happen to share the command name:

| Package | `bin.e9` file | Role |
| --- | --- | --- |
| `@engine9/core` | [`bin/e9.js`](bin/e9.js) | Core helpers against a DB URL (`--db` / `ENGINE9_DATABASE_CONNECTION`). No `accounts.d`. Commands: `installStandard`, `create-api-key`, `sqlite-ddl`. |
| `@engine9/server` | [`bin/e9`](../server/bin/e9) | WorkerRunner for account-scoped workers: `e9 personworker installStandard -a <account_id>`. Needs a server checkout. |

Which one runs when you type `e9` / `npx e9`:

- **Core-only site** (depends on `@engine9/core`, not the server package) → core `bin/e9.js`.
- **Server checkout** (`@engine9/server` is the package root, or `$ENGINE9_SERVER_DIR/bin` is on `PATH`) → server `bin/e9` (WorkerRunner). That shadows core's binary when both are present.

Examples:

```bash
# Core / self-hosted / D1 local file — core bin/e9.js
npx e9 installStandard --db sqlite://./engine9.db
npx e9 create-api-key --db sqlite://./engine9.db --name website --scopes admin

# Server account — server bin/e9 (WorkerRunner)
e9 personworker installStandard -a <account_id>
e9 sqlworker createApiKey -a <account_id> --name website --scopes admin
```

## Responsibilities

Core **deploys** plugins and schemas against D1/SQLite (and MySQL via knex). Live
`standardize` / `diff` / `deploy` / `install` / `installStandard` live on
`SchemaWorker` and `PluginWorker` in this package. `@engine9/server` adds
MySQL account config, FileWorker streams, EQL, ClickHouse, and native plugin
compile via hooks (`registerCorePluginHooks`). Plugin shorthand (`e9email`,
`transaction/profile`) needs a host-provided catalog — server supplies one from
the filesystem; Cloudflare/D1 installs always pass full `@engine9/...` paths.

The client is the minimum needed for a functioning website:

- **Install standard packages** -- `PersonWorker.installStandard()` or
  `e9 installStandard --db …` looks up stack include/exclude remotely
  (local `@engine9/interfaces` package or GitHub `stack.json`) and deploys
  plugin rows + tables. Pass `{ path }` for a different stack.
- **Use plugins at runtime** -- `PersonWorker` runs the inbound people pipeline,
  resolving interface transforms from a static registry (bundler friendly).
  `installStandard()` creates plugin rows and tables.
- **Authenticate with API keys** -- pluggable key stores (SQL table or
  Cloudflare KV), SHA-256 hashed at rest, scoped, revocable, rotatable
  (`@engine9/core/auth`, `SQLWorker.createApiKey` / `e9 create-api-key`).
  `SqlApiKeyStore.deploy()` will create the `api_key` table via
  `SQLWorker.createTable` if it is missing.
  Interface tables come from `installStandard()` (or `e9 sqlite-ddl`
  migrations).
- **Authenticate Users via delegate** -- the shared cross-organization
  identity service. `createDelegateAuth` verifies delegate-signed Identity
  Tokens (JWT, ES256, JWKS; no shared secret), maps `unid` into a
  `person_id` (id_type `delegate` → `person_id_delegate` on SQLite/D1),
  derives roles from `person_segment` (role_id = segment UUID), and may mint
  a local HMAC Core Session. Legacy handoff codes/bridges still work when
  `handoffSecret` is set. See [Delegate authentication](#delegate-authentication).
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

### `pluginPaths` (`@engine9/core/pluginPaths`)

Plugin rows, stack `include`/`exclude` lists, and account `stacks[]` store
**package identity only** — paths like `@engine9/interfaces/person`. The server
resolver loads modules from node_modules, a monorepo sibling checkout, or an
explicit `source`; that load tip is never part of `plugin.path`.

Legacy `local$@engine9/...` strings are still accepted as an input alias and
normalized by stripping `local$`. This module matches those forms for reads
and migrations (include/exclude membership, dependency checks).

It lives in core because it has no filesystem, compile, or database dependency.
`PluginWorker.install` needs the same rules.

Everything else -- person exports, file processing (FileWorker), messaging,
reports, EQL search, scheduled jobs, remote plugin execution, ClickHouse --
stays in the server (`@engine9/server`).

## Deployment targets

- **Cloudflare Workers + D1 (tier 1)** -- see [cloudflare/README.md](cloudflare/README.md)
- **Generic Node** -- Express or any HTTP framework, with SQLite
  (better-sqlite3) or MySQL via optional knex peer dependencies

## Quick start (Node + SQLite — no Cloudflare)

Self-hosted / `host=self` sites store and verify keys in the account database.
Cloudflare KV/D1 is not required for API key auth.

```bash
npm install @engine9/core better-sqlite3 knex

npx e9 installStandard --db sqlite://./engine9.db
npx e9 create-api-key --db sqlite://./engine9.db --name website --scopes admin
npx e9 create-api-key --db sqlite://./engine9.db --name public --scopes public
```

(`installStandard` creates tables and plugin rows in the database.
`e9 sqlite-ddl --schema @engine9/interfaces/person` prints one schema's
SQL if you prefer wrangler migrations.)

```js
import { PersonWorker, SqlApiKeyStore, JsonlFileLogger, createApi } from '@engine9/core';

const worker = new PersonWorker({
  accountId: 'my-account',
  auth: { database_connection: 'sqlite://./engine9.db' } // mysql://… also works
});
// SqlApiKeyStore.verify() → SELECT by key_hash on api_key — no Cloudflare
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

// Rotate: const { key } = await new SqlApiKeyStore({ worker }).rotate({ id });
```

## Endpoints

| Endpoint | Purpose | Scope |
| --- | --- | --- |
| `GET /ok` | health check (no auth) | -- |
| `POST /people` | run `{ people: [...] }` through the inbound person pipeline and upsert | `people:write` |
| `POST /upsert/:table` | upsert `{ rows: [...] }` into an allowlisted person-related table | `tables:write` |
| `GET /read/:name` | read a configured table, optionally gated by `person_segment` (`?person_id=`) | `data:read` |
| `POST /auth/login` | exchange `{ delegate_token \| delegate_code \| delegate_bridge, return_to? }` → `{ session, token }` | API key |
| `GET /auth/me` | current User (`personId`, `roles`, `level`, `unid`, `profileId`, `profile?`, `auth`) | API key + session or JWT |
| `POST /auth/logout` | `{ loggedOut: true }` (cookie clear is the host's job) | API key |
| `POST /auth/role` | change role (`{ role_id, person_id?, exclusive?, session_token? }`); session/JWT must match `person_id` unless `admin` | API key |

Server Task API (same keys; see `@engine9/server` Task docs): `tasks:read`,
`tasks:schedule`.

Keys are passed as `Authorization: Bearer e9key_...` or `X-API-Key: e9key_...`.
Effective scopes come from the active role and API key (see auth map above).
Empty key scopes **deny** every check (keys must be created with an explicit
list). `admin` grants every scope. Roles with empty scopes do not constrain
the key.

A Core Session is an HMAC token the **host** delivers (`Cookie` via
`createSessionCookieHeaders`, or `X-Engine9-Session`). An Identity Token JWT
may be sent as `Authorization: Bearer` (three segments, not `e9key_` /
`e9publickey_`) together with `X-API-Key`.

## Delegate authentication

Delegate is engine9's shared identity service. A **User** (the person on
delegate) presents a **Profile** to a **Site** (this deployment's origin).
Sites on `@engine9/core` verify a delegate-signed **Identity Token** (JWT).
They never talk to the identity provider directly. This is not OIDC.

Vocabulary: **User** (not Account), **Site** (not Audience). The JWT claim
name remains `aud` (RFC 7519) and must equal the Site origin.

```js
import { createDelegateAuth, createSessionCookieHeaders } from '@engine9/core/auth/delegate';

const auth = createDelegateAuth({
  worker,
  delegateUrl: process.env.DELEGATE_URL,     // e.g. https://delegate.engine9.ai
  site: 'https://yoursite.example',          // JWT aud
  sessionSecret: process.env.SESSION_SECRET, // signs this Site's cookie only
  // handoffSecret is optional — only needed for legacy code/bridge
  pluginId: '<website plugin uuid>',
  remoteInputId: 'delegate-login',
  roles: {
    '<admin-segment-uuid>': { name: 'Admin', scopes: ['admin'], requiredAuth: { minLevel: 2 } },
    '<vip-segment-uuid>': { name: 'VIP', scopes: ['data:read'], requiredAuth: { minLevel: 1 } }
  }
});

const { session, token } = await auth.login(delegateToken, {
  returnTo: 'https://yoursite.example/auth/delegate'
});
res.setHeader('Set-Cookie', createSessionCookieHeaders(token, { secure: true }));
```

### Authentication vs authorization

- **Authentication** answers who is present: API key (the caller) plus an
  Identity Token or Core Session (the User).
- **Authorization** answers what they may do: key scopes ∩ role scopes, plus
  `requiredAuth` (`minLevel`, `twoFactor`).
- Identity **Levels** (0–7) are confidence, not permission. A Level 4 User
  may still lack the VIP role.
- **Roles** are Site authorization (`role_id === segment_id`). They are not
  an identity concept.

### When do you need a session?

You do not. A Core Session is an optional HMAC cache of `personId`, `roles`,
`unid`, `level`, and `auth` after the Site has verified an Identity Token.
The host delivers it (HttpOnly cookie or `X-Engine9-Session`). The browser
can instead send the JWT as `Authorization: Bearer` on each request. Mint a
session when you want fewer JWKS/person lookups; skip it for token-only APIs.

### Verifying delegate identity (JWT)

`verifyDelegateIdentityToken` (and `auth.verifyIdentityToken` /
`auth.login` when the token starts with `eyJ` and has two dots):

1. Fetch `{delegateUrl}/.well-known/jwks.json` (cached in memory by URL).
2. Verify ES256, `iss` (default: delegateUrl origin), `aud === site`, `exp`.
3. Map claims to a DelegateUser: `unid`, optional `firebaseUid`, `email`
   from `profile` when `email_verified`, `level`, `profileId` (`sub` unless
   `unid:…`), `profile`, `auth`.

`firebaseUid` is not required. Person resolution uses `unid` only.

### Roles minLevel

`requiredAuth.minLevel` is a number. `meetsRequiredAuth` requires
`credentialLevel.level >= minLevel` (session `level`, else `auth.level`)
and still enforces `twoFactor` when that flag is true.

Email is copied onto the person record only when `emailVerified === true`
or `level >= 2`, so unverified Level 0/1 addresses do not merge people.

### `/auth/*` endpoints

All except `GET /ok` still require an API key.

| Endpoint | Body / headers | Response |
| --- | --- | --- |
| `POST /auth/login` | `{ delegate_token \| delegate_code \| delegate_bridge, return_to? }` | `{ session, token }` |
| `GET /auth/me` | `X-Engine9-Session` or Bearer JWT | `{ personId, roles, level, unid, profileId, profile?, auth }` or 401 |
| `POST /auth/logout` | API key | `{ loggedOut: true }` — host must clear its cookie |
| `POST /auth/role` | `{ role_id, person_id? }` + session/JWT, or `admin` key | `{ roles, token, session }` |

`POST /auth/role` rejects a bare `person_id` unless the session/JWT
`personId` matches or the key/role has the `admin` scope.

### Legacy handoff

Existing Sites may still use `delegate_code` / `delegate_bridge` and
`DELEGATE_SHARED_SECRET`. `login()` treats 64-hex (and short test) strings
as codes, `encoded.sig` (contains `.` but is not a JWT) as a bridge, and
`eyJ` + two dots as a JWT. JWT login does not need `handoffSecret`.

`loginUrl()` still points at `/handoff/authorize`. New Sites should use
`auth.identityUrl({ returnTo, minLevel, responseMode })` (or
`delegateIdentityUrl`) which builds `/identity/authorize`. See
`id/docs/protocol.md`.

Session bridge (`/oauth/session-bridge`) remains for engine9 API hosts
(Firebase → `engine9_session`). It is not this protocol.

## Package layout

- `lib/utilities.js` -- shared environment-agnostic utilities (canonical copy; the server re-exports these)
- `lib/sql/shared.js` -- the canonical table upsert logic shared with the server
- `lib/sql/dialects/` -- MySQL and SQLite dialects (SQLite serves D1)
- `lib/sql/sqliteDDL.js` -- native SQLite/D1 DDL generation (no knex needed)
- `lib/sql/standardizeSchema.js` -- dialect-aware column standardization used by SchemaWorker and `e9 sqlite-ddl`
- `lib/SQLWorker.js` -- query/upsert/DDL primitives over D1, better-sqlite3, or mysql2; `createApiKey` / `listApiKeys` / `updateApiKey` / `revokeApiKey` / `rotateApiKey` wrap `SqlApiKeyStore`
- `lib/SchemaWorker.js` -- standardize / diff / deploy interface schemas
- `lib/PluginWorker.js` -- plugin rows, stack install, installStandard, bootstrapAccount
- `lib/pluginPaths.js` -- shared plugin-path matcher (package identity; legacy `local$` alias)
- `lib/stackMetadata.js` -- `loadStackMetadata`: stack include/exclude (local package or GitHub)
- `lib/PersonWorker.js` -- inbound person pipeline (`processPeople`) plus installStandard
- `lib/peoplePipeline/` -- shared inbound transform chain used by processPeople and server loadPeople
- `lib/id/` -- person identifier stores (compact SQLite, legacy MySQL, Durable Objects)
- `auth/` -- API key creation/verification, SQL + KV stores, policy + HMAC helpers
- `auth/delegate.js` -- Identity Token (JWT) verification, optional legacy
  handoff, person resolution via id_type `delegate`, roles-as-segment-UUIDs,
  HMAC Core Sessions (ships `delegate.d.ts` for TypeScript consumers)
- `logging/` -- JSONL file logger and batch logger (R2 sink included)
- `api/` -- framework-agnostic endpoint handlers (fetch + Express adapters)
- `cloudflare/` -- Worker example, wrangler config, input-tools shim, install guide
- `bin/e9.js` -- core `bin.e9`: `create-api-key`, `sqlite-ddl`, `installStandard` (not the server WorkerRunner; see [The e9 CLI](#the-e9-cli-two-binaries))

## Tests

```bash
npm test
```

Runs the SQLite-backed test suite: SQL round trips, applying the standard
interface tables, the full person pipeline (dedupe/update/read-only), and the API
surface (auth, scopes, segment gating, modification logs).
