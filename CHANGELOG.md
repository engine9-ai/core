# Release notes: @engine9/core

This file lists what changed in each release, what was retired, and what a
site should change. The current way to do things is in [README.md](README.md).
Upgrading a database (`e9core upgrade`) is in [docs/upgrading.md](docs/upgrading.md).

Only releases from the last week are listed here with site steps. Older
releases have a guide in `docs/upgrade-<version>.md`.

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

## 1.16.0: Login finds people by confirmed email; the KV caches are gone

Two changes. Read both before you deploy. Neither changes the database: there
is no `lib/upgrades` entry and nothing to run with `e9core upgrade`.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | A Delegate login finds the person by its confirmed email, not by the Domain UNID | Every site that signs people in with Delegate | No. Who a login resolves to can change |
| 2 | `PERSON_ID_DELEGATE_KV`, `PERSON_SEGMENT_VK`, and `@engine9/core/cloudflare/kv` are removed | Cloudflare sites that bound either namespace or import that path | Yes, if you import `@engine9/core/cloudflare/kv` |

### Find out whether this affects your site

Run in your site's repository:

```bash
rg -n "cloudflare/kv|kvEnv|PERSON_ID_DELEGATE_KV|PERSON_SEGMENT_VK|domain_unids|domainUnids" . -g '!node_modules'
rg -n "domainUnid|domain_unid|person_id_delegate" . -g '!node_modules'
rg -n "\.login\([^)]*person" . -g '!node_modules'
```

- No matches in the first command: change 2 needs nothing from you except
  deleting the KV namespaces if you created them (step 4 below).
- Matches in the second: read change 1, "Your own records".
- Matches in the third: read change 1, "`login(token, { person })`".

### 1. A login is found by its confirmed email

The Identity Token is a credential; core decides who the person is.

- **A login with a confirmed email** (`email_verified`, or Identity Level 2
  or more) finds the person core knows by that address, or creates one, the
  same way an import of that address would. The Domain UNID (`sub`) is no
  longer stored on that person.
- **A login with no confirmed email** (Level 0, a Facebook address, or a
  Grant that does not share `email`) is still found by the Domain UNID, with
  `merged_from` as before.

Before, both the Domain UNID and the email were identifiers, and whichever
matched first won. A person who changed the address they share could be
signed in as whoever owned the new address in one login and as their old
person in the next, or keep the new address on the old person.

What changes for people signing in:

| Situation | Before 1.16.0 | From 1.16.0 |
| --- | --- | --- |
| Signs in with the same address as always | Same person | Same person |
| Switches to an address core does not know | Same person; the new address added to it | A new person with that address. Signing in with the old address returns to the old person |
| Switches to an address another person in core has | That other person in some logins, their own in others | That other person, every time |
| Granted a role by address (`addPeople({ emails })`), then signs in with that address | The person their Domain UNID was first attached to, which may not hold the role | The person with that address, who holds the role |
| A Level 0 visitor who later signs in with a confirmed address | The visitor record and the person were joined | Not joined. The visitor record stays under the Domain UNID |
| Switched addresses before 1.16.0 | — | Both addresses are already on one person in core, so they stay one person |

The rule, the names (`sub`, `person_id`, `session.email`), and the use cases
are in
[auth/README.md](auth/README.md#who-is-signing-in-credential-identity-deduplication).

| Where | Find | Change to |
| --- | --- | --- |
| Your own records | Tables or lookups keyed on `session.domainUnid`, `sub`, or `person_id_delegate` | Key on `session.personId` |
| `login(token, { person })` | `person.email` meant to replace the token's address | Remove `email` from `person`. A confirmed email on the token always wins; `person.email` is used only when the token has none |
| "Change your Delegate information" / Switch email | Copy that promises the person's data follows them ("your stories stay with you") | "What you see here follows the address you sign in with" |
| Two addresses that must be one person | Expecting Delegate to join them | Join them in core: import both with the same `person_id` or `remote_person_id`, or merge |

New export: `delegateConfirmedEmail(delegateUser)` returns the confirmed
address, or undefined.

### 2. The KV caches are removed

`PERSON_ID_DELEGATE_KV` cached Domain UNID → `person_id` for API requests
that send an Identity Token as `Authorization: Bearer <jwt>`. It had no
expiry, and only erase cleared it, so an import or merge could leave a stale
`person_id`. `PERSON_SEGMENT_VK` had helper functions only; no core code read
or wrote it. Both are gone. `person_id` and segment membership are read from
D1 on every request.

| If your site… | What happens on 1.16.0 | What to do |
| --- | --- | --- |
| Imports `@engine9/core/cloudflare/kv` (`setDelegatePersonId`, `getPersonIdByDomainUnid`, `getDomainUnidByPersonId`, `deleteDelegatePersonId`, `addToSegment`, `removeFromSegment`, `isInSegment`, `listSegmentMembers` from that path) | **The build fails**: the path is no longer exported (`ERR_PACKAGE_PATH_NOT_EXPORTED`, or Wrangler "Could not resolve") | Delete the import and the calls before upgrading. Segment membership: `listSegmentMembers` from `@engine9/core/auth` (SQL) |
| Uses the Worker core ships (`@engine9/core/cloudflare/worker`) | Nothing. It no longer passes the binding | Nothing in code |
| Passes `kvEnv` to `createApi` in its own Worker | Ignored | Remove the option |
| Passes `kvEnv` or `domainUnids` to `worker.erasePeople`, or `domain_unids` to `POST /api/admin/erase` | Ignored. Erase still removes every database row for those people, including `person_id_delegate` | Remove them |
| Binds `PERSON_ID_DELEGATE_KV` or `PERSON_SEGMENT_VK` in `wrangler.toml` | The binding is unused | Remove it, then delete the namespace (steps below) |
| Sends `Authorization: Bearer <Identity Token>` to the API | Each request resolves the person in SQL (the people pipeline). Requests with a Core Session already carry `personId` and are unchanged | Prefer a Core Session (`POST /api/auth/login` once, then `X-Engine9-Session`) for repeated calls |

**Privacy:** an existing `PERSON_ID_DELEGATE_KV` namespace still holds
Domain UNID ↔ `person_id` pairs written before the upgrade, and erase no
longer touches it. Delete the namespace; do not leave it bound.

**Rollback:** 1.15.x runs without these bindings. If you roll back after
deleting the namespace, it reads from SQL. Do not roll back with the old
namespace still bound: 1.15.x would read entries written before the upgrade.

### Deploy steps, in order

1. Run the `rg` commands above and make the changes they call for.
2. Install `@engine9/core@1.16.0`, build, run your tests, and deploy.
3. Remove the `PERSON_ID_DELEGATE_KV` and `PERSON_SEGMENT_VK`
   `[[kv_namespaces]]` blocks from `wrangler.toml` (or `wrangler.jsonc`) and
   deploy again.
4. Delete the namespaces (Wrangler 3.60 or later):

   ```bash
   npx wrangler kv namespace list
   npx wrangler kv namespace delete --namespace-id <id of each one>
   ```

5. Sign in with a test address, then with a second address the site has never
   seen, and confirm `GET /api/auth/me` shows a different `personId` for each.

## 1.15.3: PII-free is `exclude_pii` only

`exclude_pii` on `@engine9/schemas/utilities/limited-pii` is the only signal
that an account is PII-free. The limited-pii stack is an install list; it no
longer contributes `metadata.exclude`, and an installed stack alone does not
make `upgrade` report `pii_free` or re-select itself in
`installDefaultPlugins`. With the setting on, leftover plaintext plugin rows
are also skipped in the inbound weave. `bootstrapAccount({ exclude_pii: true })`
installs the utility, sets the setting, then installs the limited-pii stack.

### What a site changes

| Where | Find | Change to |
| --- | --- | --- |
| Accounts that rely on the limited-pii stack without the utility setting | Stack installed, `exclude_pii` unset or false | Install `@engine9/schemas/utilities/limited-pii` and set `exclude_pii` to `true` before upgrading core/schemas |
| Docs / runbooks that say "the stack excludes plaintext plugins" | Stack `exclude` as the install guard | Use `exclude_pii`; the stack only lists what to install |

No `lib/upgrades` entry. Pair with `@engine9/schemas` that drops `exclude`
from `stacks/limited-pii`.

## 1.15.2: Test scripts

No change to what a site runs, and no `lib/upgrades` entry. Contributors:
`npm run test:auth` runs the auth tests, and `test:id-large` now loads the
plugin registry setup, as `npm test` does. Running a test file without
`--import ./test/setup-plugins.js` fails with "no plugin registry is
configured"; see `AGENTS.md`.

## 1.15.1: Retirement date

Documentation only; no code change and no `lib/upgrades` entry. 1.15.0 said
`delegate.engine9.ai` would stop working "no later than 2026-10-23". That date
was wrong. The old host is retired on **2026-10-30**. Everything in 1.15.0
below still applies.

## 1.15.0: Delegate moves to delegate.network

<!-- REMOVE-AFTER 2026-11-06: the retirement notice and the migration table below.
     One week after delegate.engine9.ai is retired (2026-10-30), delete everything from here
     to the matching "END REMOVE-AFTER" comment, and keep the "What changed" list. -->

> **`https://delegate.engine9.ai` is being retired. It will stop working on
> 2026-10-30. Move every site to `https://delegate.network` now.**

### What to change in your site

A site that does not set `DELEGATE_URL` gets the new host by upgrading to
1.15.0. A site that names the old host anywhere must change that text. Find
every place:

```bash
rg -n "delegate\.engine9\.ai" . -g '!node_modules' -g '!dist' -g '!.wrangler'
```

| Where | Find | Change to |
| --- | --- | --- |
| `wrangler.jsonc` `vars` | `"DELEGATE_URL": "https://delegate.engine9.ai"` | Delete the line (the default is `https://delegate.network`), or set `"DELEGATE_URL": "https://delegate.network"` |
| `.env`, `.env.production`, `.env.<name>`, `.dev.vars` | `DELEGATE_URL=https://delegate.engine9.ai` | Delete the line, or `DELEGATE_URL=https://delegate.network` |
| Cloudflare dashboard (Worker variables), CI, and your host's environment | `DELEGATE_URL` set to the old host | Delete it, or set it to `https://delegate.network` |
| `createApi({ delegate: { delegateUrl } })` | `delegateUrl: 'https://delegate.engine9.ai'` | `delegateUrl: env.DELEGATE_URL` (unset uses the default), or `'https://delegate.network'` |
| `createDelegateAuth({ delegateUrl, issuer })` | `delegateUrl` or `issuer` naming the old host | Same values with `https://delegate.network`. Drop `issuer` unless you need to override it |
| `verifyDelegateIdentityToken({ token, delegateUrl, issuer })` | Same | Same |
| `delegateIdentityUrl({ delegateUrl, ... })`, `auth.identityUrl(...)` | Same | Same |
| Your own checks of the token's `iss` | `=== 'https://delegate.engine9.ai'` | Compare to your configured `delegateUrl` origin: `'https://delegate.network'` |
| Hard-coded links and fetches | `https://delegate.engine9.ai/user`, `/identity/authorize`, `/identity/bridge`, `/identity/logout`, `/.well-known/jwks.json`, `/.well-known/delegate-configuration` | Same paths on `https://delegate.network` |
| Content-Security-Policy (`connect-src`, `frame-src`, `form-action`), firewall and proxy allowlists | `delegate.engine9.ai` | `delegate.network` (add it before you remove the old entry) |
| Tests, mocks, and fixtures that sign tokens | `iss: 'https://delegate.engine9.ai'` | `iss: 'https://delegate.network'` |

Rules:

- **Change browser and server together, in one deploy.** The server
  (`@engine9/core`) checks the token's `iss` against the Delegate URL it was
  configured with. A browser on `@engine9/id` 1.13.0 sends people to
  `delegate.network`, and a server still configured for the old host rejects
  those tokens. See the matching steps in
  [`@engine9/id` CHANGELOG](https://github.com/engine9-ai/id/blob/main/CHANGELOG.md).
- **Do not accept both issuers.** Core verifies `iss` against the one
  `delegateUrl` you configure. There is no "either issuer" option, and none
  was added.
- **Registered Domains need nothing.** A Domain registered with Delegate works
  on the new host. Do not ask for a new registration.
- **Redeploy after the change.** A Worker reads `DELEGATE_URL` when it is
  deployed or restarted.

What your Users see: each User signs in once more, because the new host does
not have their Delegate session and tokens from the old host no longer verify.
Delegate recognizes the same account, so it is the same User and the same
Domain UNID, and no new person is created. Core Sessions already issued
(the `e9_session` cookie, `X-Engine9-Session`) are signed with your
`SESSION_SECRET`, not by Delegate, so they stay valid until they expire.

<!-- END REMOVE-AFTER 2026-11-06 -->

### What changed

- `DEFAULT_DELEGATE_URL` is `https://delegate.network` (was
  `https://delegate.engine9.ai`).
- Docs, examples, and tests use the new host.
- No schema change and no `lib/upgrades` entry. `e9core upgrade` has nothing
  new to apply.
- Documentation: do not run `installDefaultPlugins` while a visitor waits on
  the login return; ask whether the database is already installed and install
  only when it is not. See
  [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md#keep-the-return-from-delegate-fast).

## Site steps for the last week's releases

If you are on a release older than 1.11.0, do each section from your version
up, in order. After the last one, run `npx e9core upgrade --url <site>`
(or `--db <url>`).

### 1.14.0 (2026-10-23): one-link sign-in and a role gate

Added: `GET /api/auth/start`, `GET /api/auth/callback`,
`@engine9/core/auth/gate` (`requireRole`, `createGate`),
`@engine9/core/auth/signIn`, `POST /api/admin/install-default-plugins`, and
`e9core installDefaultPlugins --url <site>`.

| Where | Change |
| --- | --- |
| Your own sign-in route | Optional. Replace it with `<a href="/api/auth/start?returnTo=/members">Log in</a>`. Set `config.signIn` (`minLevel`, `fields`, `loginProviders`, `brand`, `sessionCookie`, `sessionTtlSeconds`). On the Cloudflare example Worker it is the `E9_SIGN_IN` variable (JSON) |
| Any route you serve at `/api/auth/start` or `/api/auth/callback` | Rename it. Core now answers those paths |
| A page you protect in your own Worker | Optional. `const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' })`. It reads `person_segment` now, not the roles copied into the cookie |
| `brand.google: 'skip'` in `config.signIn`, `identityUrl`, or `@engine9/id` | Delete it. It is accepted and does nothing extra; one provider on a full-page login opens by itself |
| A fresh Cloudflare database whose tables you created by replaying SQL | Use `npx e9core installDefaultPlugins --url https://www.example.com` |
| Logout | `POST /api/auth/logout` now also clears the `e9_session` cookie that `/auth/callback` set |

### 1.13.1 (2026-10-23): manage segments on a deployed site

Added: `e9core segment list|members|add|remove --url <site>`,
`GET /api/admin/segments`, `GET /api/admin/segments/:segment/members`, and
role names as `segment_id` in `POST /api/auth/segments`.

| Where | Change |
| --- | --- |
| First admin on a Cloudflare (D1) site | `npx e9core segment add --segment admin --url https://www.example.com --email you@example.org`. It uses the production admin key (`--key`, `E9_ADMIN_API_KEY`, or `.env.production`) |
| A plugin package of your own that declares `exports` | `build-plugins` writes only exported paths. Export `<dir>/index.js` and re-export `schema` and `settings` from it. A plugin the package does not export stops the build with `PLUGIN_CONFIG_INVALID` |

### 1.13.0 (2026-10-22): admin and superadmin; `operator` removed

Full steps: [docs/upgrade-1.12.md](docs/upgrade-1.12.md). (That guide is
titled 1.12.0; the published version is 1.13.0.) Requirements:
[PERMISSIONS.md](PERMISSIONS.md).

| Where | Change |
| --- | --- |
| Config, code, or data that names the `operator` role | Remove it. `ROLE_NAMES.OPERATOR` is gone and `roles: 'standard'` installs only `admin`. Existing `operator` rows stay and grant nothing |
| Former operators | Make them `admin` for their account: `npx e9core segment add --segment admin --email sam@example.com` (add `--url <site>` for a deployed site) |
| Staff who need every account | `npx e9core superadmin add --email chris@example.com`. On Cloudflare set `E9_SUPERADMINS` (comma-separated) in the Worker's vars and redeploy |
| A privileged decision in your code | `auth.rolesForSession(session)`. `auth.rolesForPerson(personId)` does not see superadmins |
| `@engine9/input-tools` | Now `^2.6.0` |

### 1.11.3, 1.11.2, 1.11.1 (2026-10-20 and 2026-10-21): plugin settings

Full steps: [docs/upgrade-1.11.md](docs/upgrade-1.11.md).

| Where | Change |
| --- | --- |
| Install | `npm install @engine9/core@^1.11.3 @engine9/schemas@^1.11.3`, deploy |
| Database | `npx e9core upgrade --url https://www.example.com --dry-run`, then without `--dry-run`. `setting_value_text` widens `setting.value` to `text` |
| A `*_custom_fields` setting saved before the upgrade | Re-save it with `setSetting` if it was cut at 255 characters |
| Code that sets a setting | `setSetting` now throws before inserting a value that does not fit the column. Catch the error instead of expecting a silent cut |
| A plugin of your own that declares settings | A setting name must be unique across the plugin and its submodules. A duplicate now throws `Duplicate setting "<name>"`; rename one |
| Scripts | Use Node.js, not Python, for deploy and maintenance scripts ([docs/deploy.md](docs/deploy.md#scripting-use-nodejs-not-python)) |

### 1.11.0 (2026-10-16): safer login and sessions

| Where | Change |
| --- | --- |
| A server callback that receives the token in the URL (`response_mode=query`) | Replace `login(token)` with `auth.beginLogin({ returnTo })` on the way out and `auth.finishLogin(delegate_token, { state, cookie })` on the way back. A `state_mismatch` means "sign in again", not an error. The authorize URL now asks for a 5-minute token |
| Logout | Pass a KV-like store as `delegate.sessionRevocations` (Cloudflare: bind `SESSION_REVOCATIONS`) so logout ends the session token, not only the cookie. Without it logout only clears the cookie |
| Sessions minted before this release | They have no `typ` and are accepted until they expire (`acceptLegacySessions: true`). A day after upgrading, set `acceptLegacySessions: false` |
| Production keys | Run `npx e9core setup --remote` (or `setup-keys --remote`, add `--env staging` for another environment). Production gets its own admin key and `SESSION_SECRET`, saved in `.env.production`; the old admin key stops working in production and everyone is signed out. Update CI and scripts that call production with the admin key |
| Privileged decisions | Read `auth.rolesForPerson(personId)` at that moment. The `roles` in a session are a copy for deciding what to show |
| Requests that name a `role_id` | Send one only for a role the caller holds. Any other is `403` (`unknown_role` or `role_not_held`); it no longer falls back to the key's scopes |
| `GET /api/read/:name?person_id=` | With a session it reads the signed-in person. Another `person_id` needs `admin` |
| Erasing a person | New: `POST /api/admin/erase` with `{ person_ids, dry_run: true }` first |

## Older releases

[1.10.1](docs/upgrade-1.10.md) (person names move to `person_name`),
[1.9.1](docs/upgrade-1.9.md) (package rename).
