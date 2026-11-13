# Release notes: @engine9/core

This file lists what changed in each release, what was retired, and what a
site should change. The current way to do things is in [README.md](README.md).
Upgrading a database (`e9core upgrade`) is in [docs/upgrading.md](docs/upgrading.md).

Only releases from the last week are listed here with site steps. Older
releases have a guide in `docs/upgrade-<version>.md`.

## 1.20.1: standard plugin catalog entries; registry attaches credentials

No site needs to change anything for this release.

A plugin's **catalog entry** is now a documented, versioned published surface:
name, publisher, credentials, settings, and the methods callers may run.
Secrets tools, task callers, settings UIs, and [market.engine9.ai](https://market.engine9.ai)
read that entry; they do not read the plugin's code to find these things out.
Tables, transforms, upgrades, and install rules stay in the package.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | **New: the catalog entry standard.** Top-level `credentials`, `settings`, `methods`, and `submodules.<Name>.{settings,methods}` (no longer nested under `metadata`). JSON Schema at `@engine9/core/pluginCatalog.schema.json`; prose in [docs/plugin-catalog.md](docs/plugin-catalog.md) | Plugin authors, market publishers, hosts that build or validate entries | No. Hosts still read the older nested shape during the move |
| 2 | **New: `@engine9/core/pluginCatalog`.** `buildPluginCatalogEntry`, `validatePluginCatalogEntry`, `bundlePluginCatalog`, `pluginCredentialsDefinition` (secrets definition derived from `credentials`) | Packages and hosts that produce or check entries | No |
| 3 | **New: `e9core catalog build` and `e9core catalog validate`.** Build reads plugins through `package.json` `"engine9"`, the same way install does, and writes one entry per plugin path | Plugin package maintainers | No |
| 4 | **Registry compile attaches `credentials`.** `compileRegistryPlugin` sets `plugin.credentials` from the module when the plugin object does not already have it, the same way it attaches `settings` | Packages that export `credentials` beside the plugin | No |
| 5 | **Settings read the new entry shape.** `catalogSettingDefinitions` takes `settings` and `submodules.<Name>.settings`, and still accepts `metadata.settings` / `submodules.<Name>.metadata.settings` | Hosts that supply `PluginWorker.getPluginCatalogEntry` | No |

Producers write only the new shape (`e9core catalog build`). Consumers that already load entries through `ENGINE9_PLUGIN_METADATA_PATH` keep working with either shape.

| What a site changes | |
| --- | --- |
| Every site | Nothing |
| A plugin package that publishes a catalog entry | Prefer the new shape; run `npx e9core catalog build --package <name> --out catalog` and `npx e9core catalog validate` before publishing. Declare connect fields under `credentials`, not as settings |
| Code that built entries with `metadata.auth_fields` / `metadata.settings` | Write `credentials` and top-level `settings` instead ([docs/plugin-catalog.md](docs/plugin-catalog.md#from-the-older-shape)). Hosts still accept the old keys |

## 1.20.0: setup with no command line; the 1.19.0 deprecations are removed

A site changes something only if it still uses one of the items 1.19.0
deprecated ([Removed](#removed-in-1200)).

This release came out of a site deployed only through GitHub Actions. Its
owner works in the GitHub web pages and an agent wrote the code, so nobody
could run a command. The site worked only because its workflow had a script
that guarded `e9core setup` against a second run and made a signing secret
itself when one was missing. The production admin key ended up stored
nowhere a person could read it. Setup kept its state on the machine it ran
on (`.env.production`, `.e9core/`). On a fresh CI runner that state is gone,
so a second run would have made new signing secrets and signed everyone out.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | **`setup --remote` decides from the target.** It asks Cloudflare which secrets the Worker has (`wrangler secret list`) and which tables production D1 has. It sends only the secrets the Worker lacks. One the Worker has is kept, whether `.env.production` is missing or holds another value. A missing one is made. The tables load only when D1 has no `plugin` table. Before, it went by `.env.production` and `.e9core/setup.json`, and on a fresh machine it made new values and replaced the Worker's | Everyone who runs `setup --remote` or `setup-keys --remote` | No. A second run on any machine now changes nothing. `--rotate` still replaces everything |
| 2 | `setup --remote` and `setup-keys --remote` work on production only: no local database, no local D1, no `.env`, and no knex or better-sqlite3 install. Production's schema is built over `node:sqlite` | A laptop that used `setup --remote` alone to make its local project | Run `npx e9core setup` for the local project |
| 3 | A folder with no public key in `.env` takes it from `.env.production` or the committed `public/engine9-config.js` before making one, so a fresh clone or a CI run no longer makes a second public key | Fresh clones, CI | No |
| 4 | Setup reads the Worker name and D1 database from the site's `wrangler.jsonc`. `--name` defaults to its `name`, `--d1` to its `DB` binding, and `--env` uses that environment's database. Before, a run without `--d1` used `engine9` and rewrote the binding's `database_name` to it | Sites whose database is not named `engine9` | No |
| 5 | **New: `--remote` on `upgrade`, `status`, `segment`, and `installDefaultPlugins`.** It writes an admin key's hash to the site's D1 through wrangler with a 15-minute `expires_at`, runs the command, and deletes the row. `--url` defaults to the one custom-domain route in `wrangler.jsonc` | CI, agents, and any machine without the admin key | No |
| 6 | **New: the status page.** `GET /api/admin/status` opened in a browser with no API key shows the status report as a page. Only a person signed in with the `admin` role at Level 3 or higher sees it: a member of the role's segment or a superadmin, checked with `requireRole`. It is read-only. The JSON answer and every other admin route still need the admin key ([PERMISSIONS.md](PERMISSIONS.md#how-a-request-is-decided)) | Sites with login on | No |
| 7 | Status checks carry `fix_web` beside `fix` in the site's own report: the same fix for someone with no terminal (run the deploy workflow, with a command, options, or "rotate"). `secrets.<NAME>` and the 501 below name `setup-keys --remote` for a missing secret and `setup-keys --remote --rotate` for a malformed one; neither deploys | Readers of `GET /admin/status` | No |
| 8 | `/auth/*` without login answers 501 with `reason: 'login_off'`, `missing` or `invalid: 'SESSION_SECRET'`, `fix`, and `fix_web`. `error` still starts `login is not enabled:` | Code that reads the 501 | No |
| 9 | New: [`cloudflare/github-deploy.yml.example`](cloudflare/github-deploy.yml.example), a GitHub Actions workflow (setup, deploy, upgrade on every push), and [docs/no-command-line.md](docs/no-command-line.md) | Sites deployed from GitHub | No |
| 10 | **New: the Login button, served by core.** `GET /api/auth/login.js` (no API key) is a script that puts the `@engine9/id` login widget in `<span data-e9-login-widget>`, with `core: { session: 'cookie' }` and the site's public key from `E9_PUBLIC_API_KEY`. A page adds two lines, `<span data-e9-login-widget></span>` and `<script src="/api/auth/login.js" defer></script>`, and copies no key. It asks Delegate for what `config.signIn` says. Optional: nothing changes until a page includes it, and `config.signIn.loginButton: false` turns the route off. Setup and the setup wizard print the two lines. Results that are not JSON (`text/javascript` here) are now sent as is by every adapter. A site that uses Delegate login uses this button rather than a sign-in of its own ([docs/sign-in.md](docs/sign-in.md)) | Sites that want login, above all sites set up only in GitHub, whose pages had no way to get the public key | No |
| 11 | **Fix: `npx e9core setup --node --db mysql://…` works.** The local install added the site's `website` plugin row with `INSERT OR IGNORE`, which MySQL rejects, so setup stopped after the tables. It now uses SQL every database accepts | Node sites on MySQL or MariaDB | No |
| 12 | **Fix: MariaDB JSON columns.** MariaDB keeps `JSON` as `LONGTEXT` with a `json_valid` CHECK. `describe` now reads that CHECK (as the server does), so `e9core status` no longer reports every JSON column as different. MySQL 8 is unchanged | Sites on MariaDB | No |

Upgrades still run only from `e9core upgrade`; a deploy never changes the
database. The workflow runs `e9core upgrade --remote` after each deploy.

The secrets rule now reads "never choose one yourself". A machine makes
`SESSION_SECRET` and `AGENT_CREDENTIALS_SECRET`: setup on Cloudflare,
`openssl rand -hex 32` on your own servers.

| What a site changes | |
| --- | --- |
| Every other site | Nothing |
| A Worker that binds `API_KEYS` (KV) | Run `npx e9core setup-keys --remote` on 1.19 first, so the keys are in the `api_key` table, then remove the binding and upgrade. On 1.20 the binding is ignored and keys are read from `api_key` only |
| Code that imports `KVApiKeyStore` | `SqlApiKeyStore` |
| Config that passes `roleSegments` to `createApi` or `createDelegateAuth` | `roles: { '<segment-uuid>': { name: '<role>' } }`, or `roles: 'standard'`. A `roleSegments` option is now ignored |
| An import of `publicSettingDefinition` or `settingFormFromDefs` from `@engine9/core` | Import them from `@engine9/core/pluginSettings`, or read the form from `listAccountPluginSettings` |
| A call to `bulkConvertPersonIdentifiers` or `PluginWorker.deployEmail` | The server's own copies |
| An import of `@engine9/core/id/PersonIdentifierDO`, `/sql/sqliteDDL`, `/sql/standardizeSchema`, `/batchStallWatcher`, or `/sql/dialects/MySQLBinaryTypes` | `PersonIdentifierDO` from `@engine9/core/id`; the others from `@engine9/core` (root exports). `MySQLBinaryTypes` has no replacement |
| Optional: a CI script that checks D1 before running `e9core setup`, runs setup in a scratch folder, or makes a signing secret when one is missing | Delete it. Run `npx e9core setup --remote --no-deploy` in the site's own folder, then `wrangler deploy`, then `npx e9core upgrade --remote` ([no-command-line.md](docs/no-command-line.md)) |
| Optional: CI that keeps the admin key as a secret for `e9core upgrade --url` | Use `--remote` and delete that secret |
| Optional: a site deployed from GitHub with no workflow yet | Copy `cloudflare/github-deploy.yml.example` to `.github/workflows/deploy.yml` and set the secrets it names |
| A laptop that ran only `setup --remote` to get its local project | Run `npx e9core setup` |

### Removed in 1.20.0

1.19.0 deprecated these and named this release for their removal.

- `KVApiKeyStore`, and the shipped Worker's `API_KEYS` KV binding. Keys are
  in the `api_key` table (`SqlApiKeyStore`), which is what setup writes.
- The `roleSegments` option of `createApi` and `createDelegateAuth`, and of
  `normalizeRoleRegistry`.
- `publicSettingDefinition` and `settingFormFromDefs` as root exports. They
  stay in `@engine9/core/pluginSettings`.
- `bulkConvertPersonIdentifiers` (root and `@engine9/core/id`) and
  `PluginWorker.deployEmail`.
- The package subpaths `@engine9/core/id/PersonIdentifierDO`,
  `@engine9/core/sql/sqliteDDL`, `@engine9/core/sql/standardizeSchema`,
  `@engine9/core/batchStallWatcher`, and
  `@engine9/core/sql/dialects/MySQLBinaryTypes`.

`E9_PLUGIN_ID` is still deprecated and still honored.

## 1.19.0: accountHandle; setup keeps the account id; E9_PLUGIN_ID deprecated

No site needs to change anything for this release.

Every id namespaced under an account -- role segments, the site's own
`website` plugin, the `roles` plugin, `e9console`/`e9workers`/`e9forms`,
the Durable Object identifier store -- used to be computed from `accountId`
directly, so an account's id could never change: a rename silently moved
every admin out of their role and every account-scoped plugin onto a new,
empty row.

Those ids are now computed from `worker.accountHandle`, which defaults to
`worker.accountId`, so every existing site computes exactly the ids it did
before. Set `accountHandle` (`E9_ACCOUNT_HANDLE` on a Worker or in `.env`,
`--handle` on the CLI) only if the account id changes later: set it to the
old id. A handle never changes once it has produced rows.

`config.pluginId` in `createApi` is now optional; it defaults to the site's
own `website` plugin (`getPluginUUID(worker.accountHandle, 'website')`),
the row `e9core setup` creates.

**`E9_PLUGIN_ID` is deprecated, and still honored.** The Worker, `serve`,
and the CLI use it when it is set, before the derived default. `e9core
setup` no longer writes it to a new project; on an existing project it
keeps the value and uses it for the local `website` row. A site that sets
it keeps writing under the same plugin it always has. Support will be
removed in a later release, which will say what such a site changes.

`e9core status` and `GET /admin/status` gained two checks:
- `handle.default` reports, as a pass, a site running on one of core's
  generic account ids (`client`, `cloudflare`, `local`, `my-site`). That
  value is the site's permanent handle; nothing to change.
- `handle.fingerprint` warns when the configured account id or handle (or
  `E9_PLUGIN_ID`, when set) does not match the ids already in the database.
  `e9core status` reads these from `wrangler.jsonc` vars, or from `.env`
  / `--account` / `--handle` with `--db`; with `--db` and no account id,
  the check is skipped.

`npx e9core setup` also writes `E9_ACCOUNT_ID` to `.env` when it is not
there yet, so a local `npx e9core serve` computes the same ids setup did.

**Setup never changes an account id a project already has.** Before, every
`npx e9core setup` run without `--name`, including the wizard's Deploy
step, reset `E9_ACCOUNT_ID` in `wrangler.jsonc` to `my-site`, and the next
deploy moved the site onto new role and plugin ids. Now an existing
`E9_ACCOUNT_ID` always wins and `--name` names only a new project's
account. A project that already has a D1 database but no `E9_ACCOUNT_ID`
runs on the Worker's `cloudflare` default; setup leaves it that way and
adds nothing. Setup also derives the local `website` row from
`E9_ACCOUNT_HANDLE` when it is set.

**Every `--db` command reads the account the same way:** `--account` and
`--handle`, then `E9_ACCOUNT_ID` and `E9_ACCOUNT_HANDLE` from the
environment, then from `.env`. Before, `upgrade`, `installDefaultPlugins`,
and `create-api-key` ignored both variables and used `client`, and the
wizard always used `local`. Those defaults still apply when nothing is set.
`segment add --handle` now creates a missing role segment under the handle,
not the account id.

**Sessions without `typ` are refused.** The `acceptLegacySessions` option
of `createDelegateAuth` and the `acceptUntyped` option of
`verifySessionToken` are removed. Only a session minted before 1.11.0
(2026-10-16) lacks `typ`, and the default session lifetime is one day. A
site that passes either option can leave it: it is ignored.

**Deprecated, removed in 1.20.** Each still works in 1.19.
- `KVApiKeyStore`, and the `API_KEYS` KV binding on the Cloudflare Worker
  (it logs a warning once). Keys belong in the `api_key` table
  (`SqlApiKeyStore`), which is what setup writes.
- The `roleSegments` option of `createApi` and `createDelegateAuth` (it
  logs a warning once). Use `roles: { '<segment-uuid>': { name: 'admin' } }`
  or `roles: 'standard'`.
- `publicSettingDefinition` and `settingFormFromDefs` as root exports.
  `listAccountPluginSettings` returns the same form.
- `bulkConvertPersonIdentifiers` and `PluginWorker.deployEmail`: server
  operations, now in the server.
- The package subpaths `@engine9/core/id/PersonIdentifierDO` (use
  `PersonIdentifierDO` from `@engine9/core/id`), `@engine9/core/sql/sqliteDDL`,
  `@engine9/core/sql/standardizeSchema`, and `@engine9/core/batchStallWatcher`
  (their functions are root exports of `@engine9/core`), and
  `@engine9/core/sql/dialects/MySQLBinaryTypes`.

`cloudflare/wrangler.toml.example` is now `cloudflare/wrangler.jsonc.example`,
the format setup writes. It no longer binds `API_KEYS`: copying that block
switched the Worker to a KV key store that setup never fills, and every
request was refused.

| What a site changes | |
| --- | --- |
| Every site | Nothing |
| Optional, local development: `.env` has no `E9_ACCOUNT_ID` | Re-run `npx e9core setup` (or add `E9_ACCOUNT_ID` from `wrangler.jsonc`) so `serve` uses the site's account id instead of `local` |
| `e9core status` warns `handle.fingerprint` | Read the check's `detail`; set `E9_ACCOUNT_HANDLE` to the value that produced the existing rows. Never change it afterward |
| Optional, before 1.20: a Worker that binds `API_KEYS` | Run `npx e9core setup-keys --remote` (it adds the site's keys from `.env.production` to the `api_key` table), recreate any other key with `e9core create-api-key`, then remove the `API_KEYS` binding and deploy |
| Optional, before 1.20: config that passes `roleSegments` | Pass `roles` keyed by segment id instead |
| Optional, before 1.20: an import of a deprecated export or subpath above | Use the replacement named there |

## 1.18.2: 1.18.1 as intended

1.18.1 on npm was published from a working tree that also held unreleased
changes. 1.18.2 is the 1.18.1 below and nothing else. Install 1.18.2.

| What a site changes | |
| --- | --- |
| On 1.18.1 | `npm install @engine9/core@1.18.2`, then the 1.18.1 steps below if not done |

## 1.18.1: signing secrets are made by setup, and a typed one is refused

**`SESSION_SECRET` and `AGENT_CREDENTIALS_SECRET` are now 64 random hex
characters (32 random bytes) or nothing.** Anyone who signs in once holds a
token signed with the secret and can test guesses against it offline, so a
phrase such as `I am god` let anyone mint a session for any person, admins
included. Until now core accepted any non-empty `SESSION_SECRET`.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | `createDelegateAuth` throws when `sessionSecret` is not 64 hex characters. `createApi` with such a `delegate.sessionSecret` leaves `/auth/*` off (501, with the fix) and every other route works | Sites whose `SESSION_SECRET` was typed rather than made by `e9core setup` | Login stops until the secret is replaced. A secret `e9core setup` or `openssl rand -hex 32` made is unaffected |
| 2 | `e9core setup-keys` (and `--remote`) writes `AGENT_CREDENTIALS_SECRET` beside `SESSION_SECRET`, its own value in each environment, and stores it as a Cloudflare secret | Sites that use `@engine9/core-agent-credentials` | No |
| 3 | `e9core setup-keys` replaces a `SESSION_SECRET` or `AGENT_CREDENTIALS_SECRET` of any other form, and says so | Sites with a typed secret | No. People signed in with the old value sign in again |
| 4 | `e9core status` fails `secrets.SESSION_SECRET` and `secrets.AGENT_CREDENTIALS_SECRET` (site) and `secrets.<target>.<NAME>` (`.env`, `.env.<target>`) when the value is not 64 hex characters | Everyone | No |
| 5 | New exports: `generateSigningSecret`, `signingSecretProblem` | Hosts that make their own secrets | No |

| What a site changes | |
| --- | --- |
| Cloudflare | `npx e9core setup-keys --remote` (add `--env staging` per environment). It replaces a typed secret and stores the new one |
| Your own servers | Set `SESSION_SECRET` (and `AGENT_CREDENTIALS_SECRET` if used) to the output of `openssl rand -hex 32`, one per environment |
| Code | Nothing, unless it passes a hand-written `sessionSecret` to `createDelegateAuth` or `createApi` (tests included). Use `generateSigningSecret()` or a 64-hex value |

## 1.18.0: one session cookie for every sign-in, and an access-denied page that fixes itself

**The recommended way to sign people in is now one session, core's HttpOnly
`e9_session` cookie, set by core however the person signs in, and one gate,
`requireRole`, on the server.** A site writes no sign-in route and keeps no
session of its own. The full setup is [docs/sign-in.md](docs/sign-in.md),
and [`demo-festival`](https://github.com/engine9-ai/demo-festival) is the
reference implementation.

This release came out of a site where a signed-in person without the admin
role was sent back to sign in. Delegate returned the same address at once,
so they went round with nothing on screen. Core's gate already answered that
case with a 403, but the site had built its own sign-in, session, and admin
check. One reason sites do that: until now the `@engine9/id` Login widget
could only get a session token back into page JavaScript, which a server
gate cannot see, so every widget site with a server wrote its own route to
turn the token into a cookie. 1.18.0 removes that reason. Core now sets the
cookie itself from the widget's sign-in, and binds that sign-in to the
browser with a nonce core issues.

Pair with `@engine9/id` 1.15.0 (`core: { session: 'cookie' }`).

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | **New: `POST /auth/begin`** returns `{ state, nonce }` and sets the signed `e9_login` cookie (`auth.beginLoginRequest()`), so page JavaScript can ask Delegate for a token bound to this browser | Sites that use the Login widget or a popup sign-in | No |
| 2 | **New: `POST /auth/login` with `{ delegate_token, state, cookie: true }`** sets `e9_session` and answers `{ session }` with no token. It refuses a token whose nonce is not the one `/auth/begin` issued to this browser (`401 state_mismatch`) and a request from another site's page (`403 origin_mismatch`). Without `cookie: true`, `/auth/login` is unchanged | Sites with a server that use `@engine9/id`. Use this instead of a route of your own | No |
| 3 | `POST /auth/role` from a cookie session (your own role) re-signs `e9_session` and leaves the token out of the body. A header session gets its token as before | Sites whose widget changes roles through core | No |
| 4 | `requireRole`'s `role` takes a list (`['VIP', 'admin']`): holding any one is enough | Pages more than one role may see | No |
| 5 | `requireRole`'s 403 page says who the person is signed in as and links to **Use a different email or account** (`prompt=select&reason=access_denied`). A role held below its `requiredAuth` says it needs a stronger sign-in | Sites that use `requireRole` | No |
| 6 | `requireRole` answers `fetch()` (`Sec-Fetch-Mode` other than `navigate`, or `Accept: application/json`) with JSON: 401 `{ reason: 'sign_in_required', signInUrl }` instead of a 302 to Delegate, and 403 `{ reason, role, email, changeUrl }` instead of HTML. Page loads are unchanged. `page: true \| false` overrides it | Page code that `fetch()`es a gated route and followed the 302 | Only if that code relied on the redirect. It used to end in a CORS error |
| 7 | The `requireRole` result carries `reason`, `signInUrl`, `changeUrl`, and on a 403 `email` and `role` | Sites that render their own 403 | No |
| 8 | New: `signInUrl(path)`, `changeSignInUrl(path, { reason? })`, `isPageRequest(request)`, `DEFAULT_START_PATH` in `@engine9/core/auth/signIn` | Everyone building links to `/api/auth/start` | No |
| 9 | `GET /auth/start` takes `reason=access_denied`. It implies `prompt=select`, and Delegate shows a notice. `auth.identityUrl` and `delegateIdentityUrl` take `reason` | Sites with access-denied pages | No |
| 10 | `GET /auth/me` returns `email` (the confirmed address of this sign-in, or null) | Page code that shows "Signed in as" | No |

### What a site should change

| Where | Find | Change to |
| --- | --- | --- |
| `package.json` | `"@engine9/core": "1.17.0"` | `"1.18.0"`, with `"@engine9/id": "1.15.0"` |
| The browser's `@engine9/id` config | `core: { apiUrl, publicApiKey }` | `core: { apiUrl, publicApiKey, session: 'cookie' }` (pages and `/api` on one host) |
| A route of your own that takes the widget's `delegate_token` and sets a session cookie | `fetch('/your/route', { body: { delegate_token } })` | `await id.core.login()`, then delete the route |
| Your own redirect callback (`/auth/delegate`, `/auth/callback`) and its state cookie | — | A link to `/api/auth/start?returnTo=…` (`signInUrl(path)`), and `config.signIn` for what Delegate asks for. Delete the callback |
| A session cookie of your own | `cookies.set('session', …)` | Core's `e9_session`; read it with `sessionFromRequest` or `requireRole` |
| An access check on the roles copied into the cookie | `sessionHasRole(session, ADMIN)` before serving a page | `requireRole({ auth, request, role: 'admin' })` |
| A signed-in person without the role | `redirect('/login?required=admin')` | `return gate.response` (or your own 403 from `gate.email` and `gate.changeUrl`) |
| A Logout that navigates in the widget's `onLogout` | `onLogout() { location.assign('/') }` | `onLoggedOut() { location.assign('/') }`; `id.logout()` ends core's session |

Every row is what demo-festival 1.13.0 did. Its diff is the worked example.

## 1.17.0: `e9core status`, an audit log, upgrades move into the plugins, and a refused API key says so

This release came out of a deploy where login looked successful and nothing
else worked. The production `api_key` table had lost the site's public key, so
core refused every login with `unauthorized: unknown_key`. The site's page
code swallowed that error, and Wrangler was logged in to a second Cloudflare
account, so it took a long time to find. 1.17.0 makes a refused key easy to
see, removes a trap that can leave production without its key rows, and adds
`e9core status` so the next one is found in one command.

Install, deploy, then `npx e9core upgrade --url <site>` as usual. The default
upgrade changes no people data: it adds three `plugin` columns. One new
upgrade, `plugin_history`, is opt-in
([docs/upgrade-1.17.md](docs/upgrade-1.17.md)). Pair with `@engine9/schemas`
1.13.0: core no longer carries upgrades, and 1.13.0 is the release that
declares them.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | `e9core setup` keeps no schema file. It no longer writes `migrations/0001_engine9.sql`, and deletes the one an earlier setup wrote | Every Cloudflare site set up before 1.17.0 | No |
| 2 | A refused API key is a 401 with `reason`, `kind: "api_key"`, and `hint`, and the Worker logs it | Page code and scripts that handle core's 401s | No. `error` is unchanged |
| 3 | `@engine9/id` 1.14.0 throws `site_key_rejected` for a refused key and reports it in the console | Sites that use `@engine9/id` with `core` | No |
| 4 | New: `e9core status` and `GET /api/admin/status` | Every site | No |
| 5 | New: an audit log, separate from the data log. Admin records move to it | Sites that read `upgrade`, `plugins.install_default`, or role membership records from `LOG_BUCKET` | No |
| 6 | New: `e9core upgrade --plugin`, `--failed`, `--sql`; every install is recorded on its `plugin` row | Sites with plugins outside `@engine9/schemas` | No |
| 7 | `plugin_history` is retired, with an opt-in drop | Databases that have the table | No |
| 8 | Upgrades keep no ledger in `setting`; each run is an audit record | Scripts that read `upgrade.<id>` settings | No |
| 9 | Upgrades are declared by plugins, with `shouldUpgrade`, and each release has an upgrade window | Plugin authors; code that reads `PluginWorker.upgrade` results by position; scripts that pass upgrade flags | Yes, without `@engine9/schemas` 1.13.0 |

### First: check that production still has your keys

Do this on any Cloudflare site that has seen a failed D1 import, a
`table api_key already exists` error, or a Wrangler command run while logged
in to more than one account. In the site's repository, after installing
1.17.0, `npx e9core status --url <site>` does all of it. By hand:

```bash
npx wrangler whoami                 # is this the account that owns the database_id in wrangler.jsonc?
node --env-file=.env -e "console.log(require('node:crypto').createHash('sha256').update(process.env.E9_PUBLIC_API_KEY).digest('hex'))"
npx wrangler d1 execute engine9 --remote --command "SELECT name, active, substr(key_hash, 1, 12) AS key_hash FROM api_key"
```

The first 12 characters of the hash should appear in the list with `active`
1. Repeat with `E9_ADMIN_API_KEY` from `.env.production`. If either row is
missing, `npx e9core setup-keys --remote` puts both back without changing a
key; no redeploy is needed. Run it in the folder whose `.env` holds the public
key the live page sends. Details:
[When the API answers `unauthorized`](docs/deploy.md#when-the-api-answers-unauthorized).

If `wrangler whoami` lists more than one account, add
`"account_id": "<the account that owns the database>"` to `wrangler.jsonc`.

### 1. The schema file is no longer in `migrations/`

`migrations/` is the folder `wrangler d1 migrations` reads. Setup loaded
`migrations/0001_engine9.sql` with `wrangler d1 execute --file`, so D1's
migration ledger never recorded it. As a result:

- `wrangler d1 migrations list engine9 --remote` showed it as unapplied, forever.
- `wrangler d1 migrations apply` ran it again against a database that already
  had the tables, and failed with `table api_key already exists` (or with
  `SQLITE_ERROR [code: 7500]` on the `modified_at` triggers).

Setup now keeps no schema file at all. When it loads D1 (the first run, a
later `--remote`, or `--refresh-schema`), it installs the default plugins
into a new SQLite file in a temporary folder, loads its dump with
`wrangler d1 execute --file`, prints the tables it loaded, and deletes the
folder. D1 gets a fresh install, never a copy of `engine9.db`, so test people
from the local site stay local. The next `npx e9core setup` deletes the old
file when its first line is `-- generated by e9core setup`. To do it now:

| Where | Find | Change to |
| --- | --- | --- |
| Your repository | `migrations/0001_engine9.sql` | Delete it (`git rm migrations/0001_engine9.sql` if it was committed). Setup builds the schema again whenever it loads D1 |
| `wrangler d1 migrations list` | Lists `0001_engine9.sql` as unapplied | Nothing to apply. It disappears once the file is gone |
| Your own migrations in `migrations/` (`0002_…` and on) | Project tables you apply with `migrations apply` | Keep them. Only the engine9 file moves |
| Scripts or CI | `wrangler d1 migrations apply` run to "finish" engine9 setup | Remove that step. Engine9 tables change through `npx e9core upgrade --url <site>` after a deploy ([docs/upgrading.md](docs/upgrading.md)) |
| Scripts | `wrangler d1 execute … --file migrations/0001_engine9.sql` to load a new database | `npx e9core setup --remote` (add `--env <name>` for another environment) |
| `--db` on a Cloudflare `setup` | Expecting that file's rows to be copied to D1 | Nothing is copied. Load data through the API or `e9core` after setup |

If you ran `migrations apply` on production and it failed, run the key check
above.

### 2. A refused API key says so

Before, a refused key returned only `{ "error": "unauthorized: unknown_key" }`,
which page code could not tell apart from a person who is not signed in.
Now:

```json
{
  "error": "unauthorized: unknown_key",
  "reason": "unknown_key",
  "kind": "api_key",
  "hint": "No row in this site's api_key table matches the key this request sent. …"
}
```

`kind: "api_key"` means the site's key was refused, not the person. Reasons:
`missing_key`, `unknown_key`, `inactive_key`, `expired_key`. The Worker also
logs `engine9 api key rejected: <reason> key_hash=<first 12 hex> path=… origin=…`
for every refused key except a missing one, so `npx wrangler tail` shows it.
The key itself is never logged.

| Where | Find | Change to |
| --- | --- | --- |
| Page code that calls core | `catch {}` or `.catch(() => {})` around `/api/auth/login`, `/api/auth/me`, or other core calls | Let errors through, or show one when `body.kind === 'api_key'` (with `@engine9/id`: `isSiteKeyRejected(err)`). Signing in again never fixes it |
| Page code | A 401 always treated as "sign in again" | Check `kind` first. Only a 401 without `kind: "api_key"` is about the person |
| Code that matches `error` | `'unauthorized: unknown_key'` | Nothing; the text is unchanged. `body.reason` is the stable field to use |
| Log alerts on Worker `console.warn` | — | Expect `engine9 api key rejected:` lines. Each one is a request with a key this site does not accept |

### 3. `@engine9/id` 1.14.0

`core.login()`, `core.me()`, and `core.changeRole()` throw a
`DelegateIdentityError` with code `site_key_rejected` when core refuses the
public key. `details` holds `status`, `reason`, and `hint`. The client logs it
once with `console.error`, even when the site catches it, and `loginWidget()`
tells the visitor it is a site problem. It also recognizes the bare
`unauthorized: <reason>` text from core before 1.17.0, so you can upgrade
`@engine9/id` first. Other core failures keep their codes and now carry
core's message and `details.reason` too.

| Where | Find | Change to |
| --- | --- | --- |
| `package.json` | `"@engine9/id": "1.13.2"` | `"1.14.0"` |
| Script tag or CDN pin | `@engine9/id@1.13.2/dist/id.iife.js` | `@engine9/id@1.14.0/dist/id.iife.js` |
| `onCoreError` or a `catch` around `core.login()` | Ignores the error | `if (isSiteKeyRejected(err))` show it (`engine9Id.isSiteKeyRejected` with the script tag) |

### 4. `e9core status`

Read-only: does the database match the deployed code, and if not, what fixes
it. It checks the Cloudflare account, the Worker's secrets, the site keys by
hash, pending upgrades, the modified_at triggers, and, for every installed
plugin, that its code is in the build, its schema diff, settings, inbound
snapshot, dependencies, last install, and whether the code changed since. It
works through the site (`--url`), a database (`--db`), or, when the site
refuses the admin key, a copy of the D1 schema made with Wrangler. Every check
id and fix: [docs/status.md](docs/status.md). Plugins can add their own checks
with a `status` hook.

| Where | Find | Change to |
| --- | --- | --- |
| Deploy script | `wrangler deploy && e9core upgrade --url $E9_SITE_URL` | Add `&& e9core status --url $E9_SITE_URL` |

### 5. The audit log

Two logs, never mixed. The data log (`logger`, `LOG_BUCKET`) keeps people
data. The audit log (`audit`, `AUDIT_BUCKET` on Cloudflare) keeps schema,
plugin, key, setting, and role changes, with no people data beyond the
subject of a role grant. `plugin.install` records list the tables and columns
each install changed. Without an audit sink, records go to the Worker log as
one JSON line each. New exports: `ConsoleLogger` and `s3Sink` from
`@engine9/core/logging`.

| Where | Find | Change to |
| --- | --- | --- |
| `wrangler.jsonc` | No `AUDIT_BUCKET` | An `r2_buckets` entry with `"binding": "AUDIT_BUCKET"` on its own bucket |
| Your own Worker or Node host | `createApi({ logger })` | Also pass `audit` (a `BatchLogger` with `r2Sink`/`s3Sink`, or a `JsonlFileLogger`) |
| Readers of `modifications/` | `action: 'upgrade'` or `'plugins.install_default'` | Read them from `audit/` |
| Readers of `modifications/` | `segment.membership` on a role segment (`admin`, or a `config.roles` segment) | `role.grant` / `role.revoke` in `audit/`. Other segments stay in `modifications/` |

### 6. Upgrading one plugin; the last install on the `plugin` row

`e9core upgrade` still reinstalls only `@engine9/schemas` plugins. Any other
plugin is upgraded by name: `e9core upgrade --plugin <path> --url <site>`.
`--failed` retries every plugin whose last install failed; `--dry-run --sql`
shows the statements first. Every install now writes three new columns on its
`plugin` row (`@engine9/schemas` 1.12.0): `last_install_at`,
`last_install_status` (`ok` or `failed`), and `last_install` (what ran it,
the step it stopped at, the error, package versions, a schema hash).
`e9core status` and `--failed` read them. `e9core upgrade` adds the columns;
it now reinstalls `@engine9/schemas/plugin` before the other plugins, so
the rest of that same upgrade is recorded. Installs on a database without the
columns skip the record.
`SchemaWorker.deploy` returns `changes` (the diff it applied).

| Where | Find | Change to |
| --- | --- | --- |
| Plugins outside `@engine9/schemas` | Expecting `e9core upgrade` to deploy their new columns | `npx e9core upgrade --plugin <path> --url <site>` after each release of that plugin |
| Code that copies or compares whole `plugin` rows (`select * from plugin`) | — | Expect `last_install_at`, `last_install_status`, `last_install` |

### 7. `plugin_history` is retired

`@engine9/schemas` 1.12.0 no longer declares the table; nothing wrote to it.
The opt-in upgrade drops it when empty:
`npx e9core upgrade --url <site> --drop-plugin-history`
([docs/upgrade-1.17.md](docs/upgrade-1.17.md)).

### 8. Upgrades keep no ledger

Since 1.10.1 each upgrade wrote an `upgrade.<id>` setting on
`@engine9/schemas/plugin` the first time a run found the account current.
Nothing depended on it: every upgrade checks the data on every run. Settings
are for what people set, so the ledger is gone. Each real `e9core upgrade`, by
any route (`--url`, `--db`, the server), now writes one `upgrade` or
`upgrade.plugins` record to the audit log with what it applied and who ran
it. The `upgrade.<id>` settings core wrote stay until you delete them
([docs/upgrade-1.17.md](docs/upgrade-1.17.md#4-optional-delete-the-old-ledger-settings)).
The result of `PluginWorker.upgrade` no longer has `recorded` on each upgrade.

| Where | Find | Change to |
| --- | --- | --- |
| Scripts or checks | `select … from setting where name = 'upgrade.person_name'` | `npx e9core upgrade --url <site> --dry-run` (every step `current`), or the audit log's `upgrade` records |
| Code that reads `PluginWorker.upgrade` results | `upgrades[].recorded` | `upgrades[].status` |

### 9. Upgrades are declared by plugins

`lib/upgrades` held upgrades for specific tables (`person_name`,
`setting.value`, `plugin_history`) that most databases never needed, and
every change to a schema plugin needed a core release. Core now holds only the
machinery. A plugin's default export declares `upgrades`, each with
`shouldUpgrade(ctx)` (does it apply, from the schema alone) and `run(ctx)`,
and an `upgradeFrom` version ([docs/plugin-upgrades.md](docs/plugin-upgrades.md)).

- `e9core upgrade` runs the upgrades of every `@engine9/schemas` plugin in the
  build, core plugin first. The four upgrades core carried are in
  `@engine9/schemas` 1.13.0 with the same ids, options, and results. Each
  result entry also names its `plugin`, and the list is in plugin order.
- Any other plugin's upgrades run with `e9core upgrade --plugin <path>`,
  before its reinstall. A plugin that carries only upgrades, for any plugins'
  tables, runs that way without a plugin row.
- `e9core status` calls `shouldUpgrade`, then dry-runs only the upgrades that
  apply. Upgrades that do not apply fold into `upgrades.none`. On a Wrangler
  copy it now checks `shouldUpgrade` too; `upgrades.unchecked` is gone.
- Upgrade windows: `e9core upgrade` refuses a database last upgraded with a
  core older than `CORE_UPGRADE_FROM` (1.9.0), and skips a plugin installed
  from a version older than its `upgradeFrom`. `e9core status` reports
  `upgrades.window` and `plugin.upgrade_window`. A database with no install
  records yet (every database before this release) gets a warning, and the
  upgrade records them.
- `e9core upgrade` passes every flag it does not read itself to the upgrades
  (`--drop-name-columns` is `drop_name_columns`, as before), and the result's
  `unused_options` names a truthy one no upgrade reads.
- New: `SQLWorker.changeColumnType({ table, column, type })`, for an upgrade
  that changes a column's type on D1, SQLite, or MySQL.

| Where | Find | Change to |
| --- | --- | --- |
| `package.json` | `@engine9/schemas` below `^1.13.0` | `^1.13.0`. With 1.12.0, core 1.17.0 runs no upgrades |
| Code that reads `PluginWorker.upgrade` results | `upgrades[0]`, `upgrades[1]` | `upgrades.find((u) => u.id === 'person_name')` (order is by plugin) |
| Code that reads the audit log | `meta.upgrades` as a list of ids | A list of `{ plugin, id }` |
| Code that imports from `@engine9/core/lib/upgrades` | `personName.js`, `settingValueText.js` | Nothing to import: the upgrades run through `PluginWorker.upgrade` |
| A plugin that needs a data change at a release | Asking for an upgrade in core | `upgrades` in the plugin ([docs/plugin-upgrades.md](docs/plugin-upgrades.md)) |
| A database that still has `@engine9/interfaces` plugin paths | — | The 1.9.1 runbook first ([docs/upgrade-1.9.md](docs/upgrade-1.9.md)). The window cannot see it: databases before this release have no install records |

### Also: one copy of the shared helpers, in `@engine9/input-tools` 2.7.0

Core needs `@engine9/input-tools` ^2.7.0, now MIT licensed. The value and id
helpers every engine9 package uses live once, in its portable
`values.js` and `uuidTools.js`. `@engine9/core/utilities` re-exports them
instead of keeping its own copies: `bool`, `getStringArray`, `isValidDate`,
`relativeDate`, `ObjectError`, `dateFromString`, `getPluginUUID`,
`getInputUUID`, `getVersionedUUID`, `getUUIDTimestamp`, `getEntryType`,
`getEntryTypeId`, `getTimelineEntryUUID`. Timeline and plugin ids no longer
come from two copies that could drift apart.

New in both: `parseJSONValue(value, fallback)` (a JSON column's value, which
is text on SQLite and D1 and an object on MySQL), `stableStringify` (JSON
with sorted keys), and `chunkArray`. New in `@engine9/core/sql/shared`:
`isMissingColumnError`.

One behavior change: `dateFromString` (and so `getVersionedUUID` and
`getTimelineEntryUUID`) reads a 12-digit numeric string as epoch
milliseconds, as `@engine9/input-tools` always did, where core's copy needed 13
digits and threw on 12.

| Where | Find | Change to |
| --- | --- | --- |
| `package.json` | `"@engine9/input-tools": "^2.6.0"` or lower | `^2.7.0` (npm installs it with core) |

## Older releases

Each guide lists what a site changes for that release. If you are more than
one release behind, do them in order, then run `npx e9core upgrade --url <site>`
(or `--db <url>`).

| Release | Date | What changed | Guide |
| --- | --- | --- | --- |
| 1.16.0 | 2026-10-25 | A Delegate login finds the person by confirmed email, not the Domain UNID. `PERSON_ID_DELEGATE_KV`, `PERSON_SEGMENT_VK`, and `@engine9/core/cloudflare/kv` are removed | [upgrade-1.16.md](docs/upgrade-1.16.md) |
| 1.15.3 | 2026-10-25 | `exclude_pii` is the only signal that an account is PII-free | [upgrade-1.15.md](docs/upgrade-1.15.md) |
| 1.15.2 | 2026-10-23 | Test scripts only | — |
| 1.15.1 | 2026-10-23 | Docs only: `delegate.engine9.ai` retires 2026-10-30 | — |
| 1.15.0 | 2026-10-23 | The default Delegate host is `https://delegate.network` | [upgrade-1.15.md](docs/upgrade-1.15.md) |
| 1.14.0 | 2026-10-23 | One-link sign-in (`/api/auth/start`, `/api/auth/callback`), `requireRole`, `installDefaultPlugins --url` | [upgrade-1.14.md](docs/upgrade-1.14.md) |
| 1.13.1 | 2026-10-23 | `e9core segment … --url` manages segments on a deployed site | [upgrade-1.14.md](docs/upgrade-1.14.md) |
| 1.13.0 | 2026-10-22 | Admin and superadmin; the `operator` role is removed | [upgrade-1.12.md](docs/upgrade-1.12.md) (titled 1.12.0) |
| 1.11.1–1.11.3 | 2026-10-20 to 21 | `setting.value` is `text`; `setSetting` refuses a value that does not fit | [upgrade-1.11.md](docs/upgrade-1.11.md) |
| 1.11.0 | 2026-10-16 | Login state binding, session `typ`, logout revocation, per-environment production keys | [upgrade-1.11.md](docs/upgrade-1.11.md#1110-2026-10-16-safer-login-and-sessions) |
| 1.10.1 | 2026-10-13 | Person names move to `person_name` | [upgrade-1.10.md](docs/upgrade-1.10.md) |
| 1.9.1 | | Package rename | [upgrade-1.9.md](docs/upgrade-1.9.md) |
