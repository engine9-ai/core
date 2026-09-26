# Agent Guide

## License

`@engine9/core` is MIT licensed. See [LICENSE](LICENSE). Use, copy, modify, and
distribute this code as-is. No further permission is required.

`@engine9/interfaces`, `@engine9/id`, `demo-festival`, and `demo-id` are also
MIT. The private repositories `delegate` and `server` are not open source.
Do not copy code from those repositories under this license.

## Deploy docs

First-time deployment setup (id vs core, Cloudflare + D1): [docs/deploy.md](docs/deploy.md).
Browser-only identity: [`id/docs/deploy.md`](../id/docs/deploy.md).

## Setup wizard

People should use the HTML wizard (`npx e9core serve`, then the printed
`/setup?token=…` URL). When you walk someone through setup yourself, ask the
**same questions in the same order** and pass each answer to the **same
function** the wizard calls: `runSetupStep` in [bin/setupFlow.js](bin/setupFlow.js).

The prompts live in [api/setupSteps.js](api/setupSteps.js) (`SETUP_STEPS`). The
wizard page renders those strings. Do not invent a second questionnaire, and
do not call Wrangler or write `.env` by hand for these steps.

The wizard only collects answers. It does not contain a separate setup
implementation.

Ask, then run:

| Step | Ask | Command |
| --- | --- | --- |
| `choose` | Where will the production site run? **Cloudflare** or **Your own servers** | `npx e9core setup --step choose --host cloudflare` or `--host node` |
| `whoami` | Which Cloudflare account is logged in on this development machine? | `npx e9core setup --step whoami` |
| `login` | Log in to Cloudflare on this development machine? | `npx e9core setup --step login` |
| `setup-cloudflare` | Create the local Cloudflare project? This does not deploy production. | `npx e9core setup --step setup-cloudflare` |
| `setup-node` | Create the local development database? This does not deploy production. | `npx e9core setup --step setup-node` |
| `preview` | Start a local Cloudflare preview on this development machine? | `npx e9core setup --step preview` |
| `deploy` | Deploy the production site to Cloudflare? Optional hostname. | `npx e9core setup --step deploy --domain www.example.com` |
| `write-config` | Write engine9-config.js for local development? | `npx e9core setup --step write-config` |
| `try-signup` | Save a test person on the local development site? Need an email and a name. | `npx e9core setup --step try-signup --email alex@example.com --given-name Alex` |
| `origins` | Independent hosts only: which origins may call the API? Include the local preview and the production site. | `npx e9core setup --step origins --origins https://www.example.com` |
| `rotate-public` | Replace the public key? | `npx e9core setup --step rotate-public` |
| `finish` | Finish setup and close the wizard on this development machine? | `npx e9core setup --step finish` |

`choose` is where the **production** site will run. The wizard itself always runs on this development machine. `setup-cloudflare` and `setup-node` create the local project only. `deploy` is the production Cloudflare deploy. `whoami`, `login`, `setup-cloudflare`, `preview`, and `deploy` follow a Cloudflare answer. `setup-node` follows your own servers. `try-signup` needs `npx e9core serve` already running.

`--host cloudflare` or `--host node` without `--step` records that choice and
then runs the matching create step (`setup` or `setup --node`).

The production Worker does not mount `/setup`. Do not add the wizard to the
Worker. Finish removes `E9_SETUP_TOKEN`. Reopen only with
`npx e9core serve --setup`.

Do not start HTTP servers unless the person asked to open the wizard or try
the site.

## Project

`@engine9/core` is a standalone library that creates an engine9-standard
database and HTTP endpoints. The database it deploys is the project's primary
database. Astro, Next.js, and other schemas use that same database when their
table names do not collide with engine9 tables. engine9 is the standard
(tables, fields, pipeline, scopes) as well as the code. Public libraries that
share it include [`@engine9/interfaces`](../interfaces) and
[`@engine9/id`](../id); the festival [`demo-festival`](../demo-festival) is a
site built on both. The private `server` repo is for people who already have
an engine9-capable database.

Table names are immutable. The published names are the standard. Keep
`person`, `event`, and the rest as published in `@engine9/interfaces`.

When a new build needs a table, decide in this order:

1. Use a matching `@engine9/interfaces` schema (an event is
   `@engine9/interfaces/event`: `event`, `person_event`).
2. If none matches and the feature is a primary extension of engine9, build
   an interface (`@engine9/interfaces/<name>`) for a shared schema or a plugin
   (`@engine9/plugins/<name>`) for a deployable integration. Those table names
   join the standard and stay fixed.
3. Otherwise prefix project-local tables with the use case (`content_blog`,
   `cms_post`, `cms_page`) in the same database.

Human-facing writeup: [docs/deploy.md](docs/deploy.md#the-project-database)
and [README.md](README.md#the-project-database).

## Applying schema SQL to D1

Database triggers are an anti-pattern here. They are hard to see, hard to
change, and they do not belong in business logic. Do not add one.

The only trigger is a SQLite stand-in for a column default. MySQL keeps
`modified_at` current with `ON UPDATE CURRENT_TIMESTAMP` on the column.
SQLite has no such clause, so `getPostCreateStatements` in
[lib/sql/dialects/SQLite.js](lib/sql/dialects/SQLite.js) emits one
`AFTER UPDATE` trigger per `modified_at` column. Its body is the only
`begin`/`end` block this package writes. `BEGIN` elsewhere is a transaction
(`BEGIN` / `BEGIN TRANSACTION`), which `dumpSqliteFile` strips because D1
rejects those lines. Upserts already omit `modified_at`; the database fills
it. Do not put other rules in that trigger or copy it for a new behavior.

`dumpSqliteFile` ([bin/setup.js](bin/setup.js)) and `e9core sqlite-ddl` both
emit that trigger when the schema has `modified_at`. `npx e9core setup`
writes `migrations/0001_engine9.sql` and loads it with
`wrangler d1 execute <database> --file` (`--local` or `--remote`). That
command uses D1's import API. Use it for any SQL this package generates.

`wrangler d1 migrations apply` is a different request. It does not concatenate
migration files. For each file it appends
`INSERT INTO "d1_migrations" (name) values ('…')` and posts that one string to
D1 `/query`. `/query` treats the `;` inside `CREATE TRIGGER … begin … end` as
the end of the statement, so the ledger insert arrives as a fragment and the
call fails with `incomplete input: SQLITE_ERROR [code: 7500]`. The same bytes
through `execute --file` succeed. A migration with no trigger can still use
`migrations apply`. To record a ledger row for an engine9 schema file, import
the file, then insert the name in a separate statement.

Do not explain that 7500 as wrangler bundling several migrations into one
request, and do not rewrite the trigger so `migrations apply` might accept it.
The open reports are
[workers-sdk#15314](https://github.com/cloudflare/workers-sdk/issues/15314)
and
[workers-sdk#15690](https://github.com/cloudflare/workers-sdk/issues/15690).

## Interfaces

`@engine9/interfaces` is a peer of this package. A site installs both, as
siblings. The copy the site installed is the one core reads.

When you deploy or set up a site, install both:

```
npm install @engine9/core @engine9/interfaces
```

Interfaces publishes on its own. When schemas or transforms change, upgrade
interfaces in the site and redeploy:

```
npm install @engine9/interfaces@latest
npx wrangler deploy
```

Leave `@engine9/core`'s version alone when only interfaces changed.

## Plugins

Plugins are every `index.js` directory and `*.plugin.js` file inside the
packages listed in `package.json` `engine9.pluginPackages`; Node imports them
from `node_modules` when the process starts, Cloudflare compiles them into the
bundle when it deploys.

- `lib/pluginRegistry.js` is the registry interface and the error codes
  (`PLUGIN_CONFIG_INVALID`, `PLUGIN_PACKAGE_NOT_DECLARED`, `PLUGIN_NOT_FOUND`,
  `PLUGIN_IMPORT_FAILED`). Nothing under `lib/` reads plugin code from disk.
- `bin/nodePluginRegistry.js` (`@engine9/core/plugins/node`) is the Node
  registry. `dynamicPluginPackages` (re-read on every use) is Node only.
- `bin/buildPlugins.js` (`e9core build-plugins`) serializes the same discovery
  for a bundle. `e9core setup` puts it in wrangler's `build.command`; do not
  tell people to run it by hand, and do not commit `engine9.plugins.js`.
- No `install({ source })`, no absolute plugin paths, no second loader. A
  plugin that is not in a listed package is an error with one of the codes
  above. In this
repository, tests use the sibling checkout (`file:../interfaces` in
devDependencies). Keep that path. The peer range in package.json is what a
deployed site must satisfy.

An identity provider is optional. Production defaults to delegate
([docs/identityProviders/delegate.md](docs/identityProviders/delegate.md)).
Local development does not require one.

## Tests

```
npm test
```

Auth-related only:

```
node --test --test-concurrency=1 test/auth.policy.test.js test/delegate.auth.test.js test/api.auth.test.js test/api.test.js test/setup.test.js
```

Do not start HTTP servers unless asked.

## Identity

An identity provider is optional. People writes need an API key only.
Production defaults to delegate. Provider-specific terms (including UNID)
belong in [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md),
not in setup docs.

- Vocabulary in core docs: **User**, **Domain**, **Identity Token**, **Identity Level**.
  The JWT claim remains `aud`.
- Do not invent OpenID Connect discovery, `id_token` aliases, or extra OIDC claims.
- A Core Session is an optional HMAC token the **host** delivers (cookie or
  `X-Engine9-Session`). Never required for authentication. The env name is
  `SESSION_SECRET`. It is the local authenticator so later requests skip the
  identity provider. Documented in [auth/README.md](auth/README.md).
- Roles may set `requiredAuth.minLevel`; that is authorization policy, not
  an identity level itself.

Do not git commit unless the user asks.
