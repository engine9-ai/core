# @engine9/core

`@engine9/core` gives a website a **people database** and the **HTTP API**
that reads and writes it. Install it, run one setup command, and you have:

- standard tables (`person`, `person_email`, `segment`, `timeline`, …) in the
  database you already use — SQLite, Cloudflare D1, or MySQL
- `/api/people` for signup forms, plus upserts and segment-gated reads
- API keys (hashed, scoped, rotatable)
- optional **login** through [delegate](https://delegate.engine9.ai), the
  default identity provider, with `@engine9/id` in the browser

It runs on **Cloudflare Workers** (D1) or on **any Node.js server** (SQLite or
MySQL). Same code, same tables, same API. This package is
[MIT licensed](./LICENSE).

engine9 is the standard those tables, fields, pipeline, and scopes follow.
Other libraries that speak it:

| Library | What it is |
| --- | --- |
| [`@engine9/interfaces`](https://github.com/engine9-io/interfaces) | Published schemas and inbound transforms. `installStandard` deploys them into your database |
| [`@engine9/id`](https://github.com/engine9-ai/id) | Browser library: login button, Identity Levels, content gates. Posts Identity Tokens to core's `/auth/login` |
| [`demo-festival`](https://github.com/engine9-ai/demo-festival) | Astro site using core and id together (SQLite locally, D1 in production) |
| [`demo-id`](https://github.com/engine9-ai/demo-id) | Browser-only demo of id, no core |

## Pick a platform

| Your production site will run on… | Database | Start here |
| --- | --- | --- |
| **Cloudflare** (Workers + D1) | D1 | [Install on Cloudflare](#install-on-cloudflare) |
| **Your own server** — a VPS, Docker, Render, Fly, Heroku, or a Node process behind nginx | SQLite file or MySQL | [Install on your own server](#install-on-your-own-server-nodejs) |

Either way the local setup runs on your development machine first. You need
Node.js 18 or newer. Setup writes tables, API keys, and a `.env` for you; you
do not create keys or copy ids into config files by hand.

If you only want a login button and Level-based content on a static page,
and no database, you do not need this package. Use
[`@engine9/id`](https://github.com/engine9-ai/id) alone.

## Install on Cloudflare

You need a Cloudflare account. Log in once:

```bash
npx wrangler login
```

In your project folder:

```bash
npm install @engine9/core
npx e9core setup
npx e9core serve
```

- `setup` writes `wrangler.jsonc` (Worker entry, D1 binding, database id),
  creates the tables in local D1, and writes `.env` with API keys,
  `SESSION_SECRET`, and a one-time setup token.
- `serve` starts a local site and prints a `/setup?token=…` URL. Open it. The
  wizard checks your Cloudflare login, starts a local preview, lets you try a
  signup, and can deploy production.

Deploy production from the wizard, or:

```bash
npx e9core setup --remote                          # production D1 + secrets + deploy
npx e9core setup --remote --domain www.example.com # also attach a hostname
```

`--remote` creates the production D1 database, copies `.env` values to
Cloudflare secrets (including `SESSION_SECRET`, which turns on login), and
runs `wrangler deploy`. The Worker it deploys is
[`cloudflare/worker.js`](cloudflare/worker.js): pages and `/api` on one
hostname, wizard not included.

Do not hand-edit `wrangler.jsonc` and do not add a `.dev.vars` file (Wrangler
prefers it and would ignore `.env`). Running `setup` again is safe; it keeps
the database and keys you already have.

Technical notes (bundler aliases, KV caches, R2 logs):
[cloudflare/README.md](cloudflare/README.md).

## Install on your own server (Node.js)

```bash
npm install @engine9/core
npx e9core setup --node
npx e9core serve
```

- `setup --node` creates `engine9.db` (SQLite) and `.env` with API keys and
  `SESSION_SECRET`. Nothing Cloudflare-related is touched.
- `serve` serves your HTML from `./public` (or safe files in the project
  folder) and the API at `/api` on one port (default 8787), and prints the
  `/setup?token=…` wizard URL.

MySQL instead of SQLite:

```bash
npx e9core setup --node --db mysql://user:pass@host/dbname
```

For production, run the same thing under your process manager
(`ENGINE9_DATABASE_CONNECTION` and the `.env` values as environment
variables), or mount the API inside the app you already have:

```js
import express from "express";
import { PersonWorker, SqlApiKeyStore, JsonlFileLogger, createApi } from "@engine9/core";

const worker = new PersonWorker({
  accountId: "my-site",
  auth: { database_connection: process.env.ENGINE9_DATABASE_CONNECTION }, // sqlite://… or mysql://…
});

const api = createApi({
  worker,
  keyStore: new SqlApiKeyStore({ worker }),
  logger: new JsonlFileLogger({ directory: "./logs" }),
  // Login with delegate. Leave out `delegate` to run the people API alone.
  delegate: { sessionSecret: process.env.SESSION_SECRET },
  config: {
    pluginId: process.env.E9_PLUGIN_ID,
    upsertTables: ["person_email", "person_phone", "person_address", "person_segment"],
    roles: {
      // "<segment-uuid>": { name: "Member", scopes: ["data:read"], requiredAuth: { minLevel: 1 } },
    },
    reads: {
      // content: { table: "member_content", segmentId: "<segment uuid>" },
    },
  },
});

const app = express();
app.use(express.static("public"));
app.use("/api", express.json(), api.expressHandler());
app.listen(8787);
```

`api.handleFetch(request)` is the same thing for any `fetch`-style runtime.
Keep `.env` out of git; `setup` adds it to `.gitignore`.

Already have a database? Install only the tables:

```bash
npx e9core installStandard --db mysql://user:pass@host/dbname
```

## Try it

With `serve` (or the Worker) running:

```bash
curl http://localhost:8787/api/ok

curl -X POST http://localhost:8787/api/people \
  -H "Authorization: Bearer PASTE_E9_PUBLIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"people":[{"given_name":"Alex","family_name":"Rivera","email":"alex@example.com","email_type":"Personal"}]}'
```

`E9_PUBLIC_API_KEY` (`e9publickey_…`) is in `.env`. It may appear in page
JavaScript; it only allows signups and login. `E9_ADMIN_API_KEY` (`e9key_…`)
never leaves the server.

A plain HTML form that posts to `/api/people` on the same origin is the
whole integration for signups. The setup page shows a copy-paste snippet.

## Add login

Login is optional. Saving people needs only the API key. When visitors
should log in, the browser talks to **delegate** and core verifies the
result. No OAuth client id, no callback route to write.

**Server:** already done if `SESSION_SECRET` is set. `e9core setup` writes it
to `.env`; `setup --remote` copies it to Cloudflare. The shipped Worker and
`e9core serve` turn on `/auth/*` when they see it. Your own `createApi` call
passes `delegate: { sessionSecret }` as above.

**Delegate:** ask the operator of your delegate to allow your **Domain**
(`www.example.com`, or `localhost:8787` while testing). `localhost:3000`–`3003`
are pre-allowed on the public delegate.

**Browser:** add [`@engine9/id`](https://github.com/engine9-ai/id) and point
it at your API with the public key.

```html
<script src="https://unpkg.com/@engine9/id@1/dist/id.iife.js"></script>
<script>
  const id = engine9Id.mount({
    core: { apiUrl: "/api", publicApiKey: "PASTE_E9_PUBLIC_API_KEY" },
  });
  // After a visitor logs in, exchange the Identity Token for a Core Session.
  id.onChange(async (identity) => {
    if (identity && identity.level >= 1) {
      const { session } = await id.core.login();
      console.log("person_id", session.personId, "roles", session.roles);
    }
  });
</script>

<button data-e9-login>Log in</button>
<p data-e9-min-level="1" hidden>Welcome, <span data-e9-profile="given_name">member</span></p>
```

What happens: delegate issues an Identity Token for your Domain; `id`
verifies it in the browser and shows or hides `data-e9-*` content by
**Identity Level** (soft, for layout); `id.core.login()` posts the token to
`/api/auth/login`; core verifies the signature against delegate's public
keys, maps the token's Domain UNID to a `person_id` in your database, reads
segment **roles**, and returns a Core Session. From then on `id.core.fetch()`
sends that session and core can refuse requests with a real 403.

Core takes the token's Domain (JWT `aud`) from the request itself: the page
`Origin`, else the API `Host`. That is right whenever pages and `/api` share a
hostname. If the API lives on another host, set `E9_DOMAIN=www.example.com`
(or `delegate.domain` in `createApi`).

Roles are segments. Add them in `config.roles` keyed by segment UUID, with
`scopes` and an optional `requiredAuth.minLevel`. Details:
[docs/identityProviders/delegate.md](docs/identityProviders/delegate.md) and
[auth/README.md](auth/README.md).

## The project database

The database this package deploys is the **primary database for the project**.
One SQLite file, one D1 database, or one MySQL database holds the engine9
tables and the rest of the project's tables. Application code (an Astro site,
a Next.js app, another schema) reads and writes that same database.

**Table names are the engine9 standard, and they are immutable.**
`installStandard` creates `person`, `person_email`, `person_phone`,
`person_address`, `segment`, `person_segment`, `timeline`, `transaction`, and
the other tables published by
[`@engine9/interfaces`](https://github.com/engine9-io/interfaces). Those names
are the contract. `person` stays `person`. `event` stays `event`. Columns on
those tables stay as published. Other engine9 libraries join on these names.

A local schema may live in the same database. Its table names must differ
from every published engine9 table (`person`, `event`, `message`,
`transaction`, `segment`, `plugin`, `timeline`, `input`, `api_key`, and the
rest of the catalog in `@engine9/interfaces`).

### Choosing a table

When a new build needs storage, decide in this order:

1. **Use a published interface.** Look through `@engine9/interfaces` for a
   schema that already describes the thing. An event is
   `@engine9/interfaces/event` (`event`, `person_event`). It is not part of
   the default stack, so install that schema when the project needs it
   (`e9core sqlite-ddl --schema @engine9/interfaces/event`, or add the package
   to the stack). Keep the published table names.
2. **Build an engine9 package when the feature is a primary extension of
   engine9.** If no interface matches, and other engine9 projects should share
   the same contract, publish it. A shared schema is an interface
   (`@engine9/interfaces/<name>`). A deployable integration (workers, inbound
   transforms, a vendor) is a plugin (`@engine9/plugins/<name>`). The table
   names you publish there join the standard and stay fixed.
3. **Prefix tables that belong only to this project.** A blog, a CMS, or
   another local feature gets tables named for that use case: `content_blog`,
   `cms_post`, `cms_page`. The prefix keeps them clear of the engine9 catalog
   in the same database.

## What is in `.env`

| Name | What it is |
| --- | --- |
| `E9_ADMIN_API_KEY` | Full access (`e9key_…`). Server and scripts only |
| `E9_PUBLIC_API_KEY` | Signup forms and login (`e9publickey_…`). Safe in the browser |
| `SESSION_SECRET` | HMAC key for Core Sessions. Present = login on |
| `E9_SETUP_TOKEN` | Opens the local `/setup` wizard until you finish. Not used in production |
| `E9_ALLOWED_ORIGINS` | Optional. Browser origins allowed to call the API from another host (CORS) |
| `E9_DOMAIN` | Optional. JWT `aud` when the API host differs from the page host |
| `DELEGATE_URL` | Optional. Your own delegate deployment. Default `https://delegate.engine9.ai` |

`npx e9core setup --rotate` replaces the keys and secret; run `setup --remote`
again afterwards on Cloudflare. `setup --remote` copies the two keys, the
secret, and the setup token. The optional values are plain configuration: on
Node they are environment variables; on Cloudflare put them under `vars` in
`wrangler.jsonc`.

## Reference

### The `e9core` CLI

`@engine9/core` publishes npm `bin.e9core` → [`bin/e9core.js`](bin/e9core.js).

| Command | What it does |
| --- | --- |
| `npx e9core setup` | Local Cloudflare project: `wrangler.jsonc`, local D1 tables, `.env` |
| `npx e9core setup --remote [--domain host]` | Production D1, secrets, deploy |
| `npx e9core setup --node [--db url]` | SQLite (or MySQL) tables and `.env`, no Wrangler |
| `npx e9core serve [--api-only] [--setup]` | Local site + `/api`; `--setup` reopens the wizard |
| `npx e9core installStandard --db <url>` | Tables and plugin rows into any SQLite, D1 file, or MySQL database |
| `npx e9core create-api-key --db <url> --name n --scopes a,b` | One key; plaintext printed once |
| `npx e9core setup-keys [--remote]` | Regenerate `.env` keys; `--remote` pushes them as Cloudflare secrets |
| `npx e9core sqlite-ddl --schema @engine9/interfaces/person` | Print one schema's SQL |
| `npx e9core build-plugins [--check]` | Write the site's plugin registry (see below) |

Commands take a database URL (`--db` or `ENGINE9_DATABASE_CONNECTION`).
`npx e9core setup --help` lists every flag. People with an existing
engine9-capable database and the private server use a different program,
`e9`.

### Authentication

Three layers. API keys are the generic auth for non-session callers (signup
and payment forms, inbound people, other HTTP APIs). Scopes decide access.

```
Request
  → 1. API key          (required on every route except GET /ok)
  → 2. Role             (role_id === segment_id UUID)
  → 3. Identity Level   (on the Core Session or Identity Token, when login is on)
  → handler
```

**Layer 1 — API key.** `Authorization: Bearer e9key_…` or `X-API-Key: e9key_…`.
Keys are SHA-256 hashed at rest (`SqlApiKeyStore` in the `api_key` table;
`KVApiKeyStore` is an optional Cloudflare store). Fields: `scopes` (required,
non-empty), `default_role_id`, `active`, `expires_at`. `store.rotate()`
creates a new key and revokes the old one.

| Scope | Surface | Allows |
| --- | --- | --- |
| `people:write` | `POST /people` | Inbound people pipeline |
| `tables:write` | `POST /upsert/:table` | Allowlisted table upserts |
| `data:read` | `GET /read/:name` | Configured reads |
| `tasks:read`, `tasks:schedule` | Private server Task API | Flows and task runs on an engine9-capable database |
| `admin` | Any | All scopes |
| `public` | Signup forms, `/auth/*` | Public ingest and login; keys use the `e9publickey_` prefix |

Empty scopes deny every check. Constants: `SCOPES` from `@engine9/core`.

**Layer 2 — Role (`role_id` = `segment_id`).** Roles are segments.

```js
roles: {
  '<segment-uuid>': {
    name: 'Admin',
    scopes: ['admin'],                        // or people:write, data:read, …
    requiredAuth: { minLevel: 2, twoFactor: false }
  }
}
```

Effective scopes are the intersection of the key and the active role; the
key is always the ceiling; `admin` on one side means that side does not
constrain. `POST /auth/role` (or `auth.changeRole`) switches roles. Legacy
`roleSegments: { admin: '<uuid>' }` is still accepted. Soft **declared
roles** with the same `requiredAuth` shape live in
[`@engine9/id`](https://github.com/engine9-ai/id/blob/main/docs/declared-roles.md)
for browser-only personalization.

**Layer 3 — Identity provider.** Optional. Production defaults to delegate:
[docs/identityProviders/delegate.md](docs/identityProviders/delegate.md).
After core verifies an Identity Token, the Core Session carries `level`,
`domainProfile`, and `auth`. `resolveAuthContext` (from `@engine9/core/auth`)
enforces `requiredAuth` when a role is active. Identity **Levels** (0–7) are
confidence, not permission: a Level 4 User may still have no role.

A **Core Session** is an HMAC token the host delivers (`Cookie` via
`createSessionCookieHeaders`, or `X-Engine9-Session`). It is a cache of the
verified identity plus `personId` and `roles`, so later requests skip the
provider. The browser can instead send the Identity Token as
`Authorization: Bearer` on each request together with `X-API-Key`. Full
account: [auth/README.md](auth/README.md).

### Endpoints

| Endpoint | Purpose | Needs |
| --- | --- | --- |
| `GET /ok` | Health check | nothing |
| `POST /people` | `{ people: [...] }` through the inbound person pipeline | `people:write` or `public` |
| `POST /upsert/:table` | `{ rows: [...] }` into an allowlisted person-related table | `tables:write` |
| `GET /read/:name` | Configured read, optionally gated by `person_segment` (`?person_id=`) | `data:read` |
| `POST /auth/login` | `{ delegate_token }` → `{ session, token }` | API key; 501 until `SESSION_SECRET` / `delegate` is set |
| `GET /auth/me` | `{ personId, roles, level, domainUnid, domainProfile, profile? }` | API key + session or Identity Token |
| `POST /auth/logout` | `{ loggedOut: true }` (the host clears its cookie) | API key |
| `POST /auth/role` | `{ role_id, person_id?, exclusive? }` | API key + session/token matching `person_id`, or `admin` |

Everything under `/api` in the shipped Worker and `serve`.

### Plugin paths

`@engine9/core/pluginPaths` treats plugin rows, stack `include` / `exclude`
lists, and `stacks[]` as **package identity only** (`@engine9/interfaces/person`).
The plugin registry maps that identity to a module compiled into the build.
Legacy `local$@engine9/...` strings are accepted and normalized.

### Plugins are compiled into the build

Core runs only plugins that were compiled into the build. It does not search
`node_modules`, read plugin files, or `import()` a path built at runtime. This
lets the same code run in pre-compiled runtimes such as Cloudflare workerd,
which have no filesystem. The cost: adding or changing a plugin means a
rebuild and a redeploy.

Which plugins run is still decided per account at run time. The inbound
weaver reads the `plugin` rows and picks the steps, then looks each plugin up
in the registry instead of loading it from disk.

`npx e9core build-plugins` writes `engine9.plugins.js` with a literal
`import()` of each plugin's `index.js`, `schema.js`, and `settings.js`, and
inlines `ui.console.json5`. Choose plugins in `package.json`:

```json
{
  "engine9": {
    "plugins": ["@engine9/interfaces/event", "@engine9/interfaces/stacks/standard"]
  }
}
```

`plugins` lists exact plugins (stack includes and the core person interfaces
are added). `pluginPackages` includes every plugin in the listed packages.
With neither setting, the build has every interface in `@engine9/interfaces`,
which is also `@engine9/core/plugins/interfaces` and the default for the CLI
and the example Worker.

```js
import plugins from './engine9.plugins.js';
import { setDefaultPluginRegistry } from '@engine9/core/pluginRegistry';

const worker = new PersonWorker({ d1: env.DB, plugins });
// or once at startup:
setDefaultPluginRegistry(plugins);
```

Installing or running a plugin that is not in the build fails with
`PLUGIN_NOT_IN_BUILD`. `install({ source })` is rejected. Loading plugin code
at run time is supported only by the private server's `runtime-plugins`
deployment on Node.

### Package layout

- `lib/utilities.js` — shared environment-agnostic utilities
- `lib/sql/shared.js` — canonical table upsert logic
- `lib/sql/dialects/` — MySQL and SQLite dialects (SQLite serves D1)
- `lib/sql/sqliteDDL.js` — native SQLite/D1 DDL generation (no knex needed)
- `lib/sql/standardizeSchema.js` — dialect-aware column standardization
- `lib/SQLWorker.js` — query, upsert, DDL over D1, better-sqlite3, or mysql2; API-key helpers
- `lib/SchemaWorker.js` — standardize / diff / deploy interface schemas
- `lib/PluginWorker.js` — plugin rows, stack install, `installStandard`, `bootstrapAccount`
- `lib/pluginPaths.js`, `lib/pluginRegistry.js`, `lib/stackMetadata.js` — plugin identity and the build-time registry
- `lib/plugins/interfaces.js` — generated registry of every `@engine9/interfaces` plugin (`npm run build:plugins`)
- `lib/PersonWorker.js`, `lib/peoplePipeline/` — inbound person pipeline. See [lib/peoplePipeline/README.md](lib/peoplePipeline/README.md)
- `lib/id/` — person identifier stores (compact SQLite, legacy MySQL, Durable Objects)
- `auth/` — API keys, policy, HMAC helpers. See [auth/README.md](auth/README.md)
- `auth/delegate.js` — default identity provider. See [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md)
- `api/` — framework-agnostic endpoint handlers (`handleFetch`, `expressHandler`)
- `logging/` — JSONL file logger and batch logger (R2 sink included)
- `cloudflare/` — Worker, wrangler example, input-tools shim. See [cloudflare/README.md](cloudflare/README.md)
- `bin/` — the `e9core` CLI, `serve`, and the setup wizard

### Tests

```bash
npm test
```

Runs the SQLite-backed suite: SQL round trips, the standard interface tables,
the person pipeline, the API surface (auth, scopes, segment gating, logs),
and a workerd-style bundle of the Worker entry.

## License

[MIT](./LICENSE). Use, copy, modify, and distribute this code as-is.
