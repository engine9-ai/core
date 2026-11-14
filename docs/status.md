# Checking a site: `e9core status`

`e9core status` answers one question: does this database match the code that
is deployed, and if not, what failed and what fixes it? It only reads. Every
problem it reports comes with the command that fixes it.

Run it after every deploy and upgrade, and first whenever something on a site
looks wrong (logins that do nothing, writes that fail, a plugin that does not
appear).

```bash
npx e9core status --url https://www.example.com     # a deployed site
npx e9core status --remote                          # the same, with a temporary admin key (CI)
npx e9core status                                   # in a Cloudflare project folder, when the site cannot answer
npx e9core status --db sqlite://./engine9.db         # a Node site or a local database
```

| Flag | Meaning |
| --- | --- |
| `--url <site>` | Ask the deployed site (`GET /api/admin/status`, admin key found like `upgrade --url`) |
| `--remote` | Ask the deployed site with a temporary admin key written through wrangler ([upgrading.md](upgrading.md#where-to-run-it)). `--url` defaults to the one custom-domain route in `wrangler.jsonc` |
| `--db <connection>` | Read a database directly |
| `--account <id>`, `--handle <handle>` | With `--db`: the account id and handle the database was built under. Default `E9_ACCOUNT_ID` and `E9_ACCOUNT_HANDLE` from `.env` or the environment. Without either, the `handle.*` checks are skipped |
| `--env staging` | A wrangler environment: its D1 binding, its secrets, `.env.staging` |
| `--plugin <path>[,<path>]` | Only these plugins |
| `--json` | The report as JSON |
| `--strict` | Exit 1 on a warning too (a failure always exits 1) |
| `--no-wrangler` | Skip the Cloudflare checks |

## In a browser

An admin opens `https://www.example.com/api/admin/status` in a browser. A
page load sends no API key. The site shows the same report as a page to a
person signed in with the `admin` role at the role's Identity Level (Level 3
or higher). That means a member of the role's segment or a superadmin, read
fresh on each request (`requireRole`). A signed-out visit goes to sign-in and
comes back. Anyone else gets a 403. The page is read-only and runs no script.
The JSON answer and every other admin route still need the admin key.

## Where it looks

It uses every source it can reach and says which in its first line.

- **The deployed site** (`--url`). The check runs inside the Worker and
  compares the database with the bundle that is actually deployed. It also
  checks the Worker's secrets (by name, and the keys by hash) and whether the
  audit log has a sink. Separately, the command sends the public key from
  `.env` to the site, and compares it with the key the live page sends.
- **Wrangler**, in a folder with `wrangler.jsonc`. It checks the Cloudflare
  account Wrangler is logged in to, the Worker's secret names, and the project
  files. When `--url` is not given, or the site refuses the admin key, it also
  copies the D1 schema (`wrangler d1 export --no-data`) and the `plugin`,
  `setting`, and `api_key` rows into a temporary SQLite file, then checks that
  copy against this folder's `node_modules`. Plugin setting values stay in D1,
  except the ones status reads (`exclude_pii`, `identifier_store_kind`). The copy has
  no people rows, so it checks only whether each upgrade applies to the schema
  (`shouldUpgrade`), not its plan. This
  is the path that still works when the API's keys are broken.
- **A database** (`--db`), read directly.

The schema is read in three queries (one for the objects, one for every
column, one for every index), so the check stays inside a Worker request's D1
query budget.

## Checks

Every check has a stable id, a status (`pass`, `warn`, `fail`, `skip`), and,
when it is not a pass, a `fix`. The site's own report (`GET
/api/admin/status` and the page) also gives `fix_web`, the same fix for
someone with no terminal, where one exists: run the deploy workflow again, or
run it by hand with a command, options, or "rotate"
([no-command-line.md](no-command-line.md)), or a line to add to
`wrangler.jsonc`.

| Id | Fails or warns when | Fix it reports |
| --- | --- | --- |
| `account.logged_in` | Wrangler is not logged in | `npx wrangler login` |
| `account.owns_database` | The logged-in account cannot see the `database_id` in `wrangler.jsonc` | Log in to the account that owns it; pin `account_id` |
| `account.pinned` | More than one account is reachable and `wrangler.jsonc` has no `account_id`, or `account_id` is not one of them | Add `"account_id"` |
| `schema_file.legacy` | `migrations/0001_engine9.sql` is in wrangler's migrations folder | Delete it, or run `npx e9core setup` |
| `secrets.<NAME>` | `E9_ADMIN_API_KEY`, `E9_PUBLIC_API_KEY`, or `SESSION_SECRET` is not set (warn); `SESSION_SECRET` or `AGENT_CREDENTIALS_SECRET` is set but is not 64 random hex characters (fail); `E9_SETUP_TOKEN` is set in production | Not set: `npx e9core setup-keys --remote`. Malformed: `npx e9core setup-keys --remote --rotate`, since a value only the Worker holds is kept by a plain run |
| `secrets.<target>.<NAME>` | `SESSION_SECRET` or `AGENT_CREDENTIALS_SECRET` in `.env` (`local`) or `.env.<target>` is not 64 random hex characters | `npx e9core setup-keys`, or `setup-keys --remote` for a deployed environment. Either replaces the value |
| `audit.configured` | No audit log sink: changes go only to the Worker log | Bind `AUDIT_BUCKET` |
| `database.copy` | Wrangler could not export the schema or read the rows | Read the detail |
| `handle.default` | Always a pass. No `E9_ACCOUNT_ID` (or `accountId`) was set, so the site runs on a core default (`client`, `cloudflare`, `local`, `my-site`), and that default is its permanent handle | Nothing. If `E9_ACCOUNT_ID` is set later, also set `E9_ACCOUNT_HANDLE` to the default so the ids stay the same |
| `handle.fingerprint` | The configured account id or handle (or the site's plugin id, when the site sets one) does not match the ids already in the `roles`/`website`/`e9console`/`e9workers`/`e9forms` plugin rows or the admin segment (fail only in effect — reported as `warn`; it does not block requests, but every write under this config lands on a different row than the account's existing data) | Set `accountHandle` (`E9_ACCOUNT_HANDLE`) to the value that produced the existing rows; never change the rows |
| `core.tables` | `plugin`, `setting`, or `api_key` is missing | `npx e9core upgrade` |
| `core.core_plugin` | `@engine9/schemas/plugin` has no row | `npx e9core upgrade` |
| `core.triggers` | A table with `modified_at` has no `<table>_modified_at_auto_update` trigger (SQLite, D1) | Load `e9core sqlite-ddl` output for that plugin with `wrangler d1 execute --file` |
| `core.required_plugins` | A [required plugin](../README.md#the-required-plugins) has no row | `npx e9core upgrade` (it installs missing required plugins) |
| `keys.public`, `keys.admin` | The site's key has no row in `api_key`, or the row is turned off or expired | `npx e9core setup-keys --remote` |
| `keys.live_public` | The site refuses the public key in `.env` | `npx e9core setup-keys --remote` |
| `keys.admin_live` | The site refuses the admin key, or `/api/admin/status` failed | `npx e9core setup-keys --remote` |
| `keys.page_matches` | The live page sends a different public key than `.env` | Run where `.env` has the deployed key, or redeploy |
| `upgrades.window` | The database was last upgraded with a core older than this release upgrades (fail), or its plugin rows have no install record (warn) | Upgrade through the release the detail names; for the warning, `npx e9core upgrade` |
| `upgrade.<id>` | An upgrade a plugin declares applies (its `shouldUpgrade` is true) and its dry run is pending (warn) or blocked (fail). An opt-in step not run is `skip`. On a Wrangler copy, an upgrade that applies is a warning without a plan. `plugin` names the plugin that declares it | `npx e9core upgrade`, or `upgrade --plugin <path>` outside `@engine9/schemas`; on a copy, add `--dry-run` |
| `upgrades.none` | Never: it passes when no upgrade applies | — |
| `upgrades.declaration` | A plugin's `upgrades` are malformed | Fix the plugin ([plugin-upgrades.md](plugin-upgrades.md)) |
| `plugin.code_present` | A plugin row exists but its code is not in the build | Add its package to `engine9.pluginPackages` and redeploy |
| `plugin.schema` | A table or column the plugin declares is missing (fail); an index or a column attribute differs (warn) | `npx e9core upgrade`, or `upgrade --plugin <path>` outside `@engine9/schemas` |
| `plugin.settings` | A setting the plugin declares has no row | as `plugin.schema` |
| `plugin.inbound_snapshot` | The people pipeline still uses an older snapshot of the plugin's inbound steps | as `plugin.schema` |
| `plugin.dependencies` | A dependency in `metadata.dependencies` is missing or the wrong version | Install or upgrade the dependency |
| `plugin.duplicates` | More than one row for a plugin that installs once | Remove the extra rows |
| `plugin.last_install` | The plugin's last install failed. Shows when, at which step, and the error | `npx e9core upgrade --plugin <path>` |
| `plugin.upgrade_window` | The plugin row was last installed from a version of its package older than the plugin's `upgradeFrom` | Upgrade through that version first |
| `plugin.code_changed` | The deployed code (schema or package version) changed since the plugin was last installed | as `plugin.schema` |
| `plugin.custom.<id>` | The plugin's own `status` hook reported it | The plugin's fix |

`e9core upgrade` runs the upgrades of `@engine9/schemas` plugins and
reinstalls only those. Any other plugin is upgraded by naming it, so for
those the fix is always `npx e9core upgrade --plugin <path> …`. Status checks
the upgrades of every installed plugin, and with `--plugin` those of a plugin
that carries only upgrades and has no row.

## The last install of each plugin

Every install writes three columns on that plugin's row in the `plugin`
table:

| Column | Holds |
| --- | --- |
| `last_install_at` | When it ran (UTC) |
| `last_install_status` | `ok` or `failed` |
| `last_install` | `{ "step": "schema", "error": "…", "trigger": "upgrade", "package": "@engine9/schemas", "version": "1.12.0", "core": "1.17.0", "schema_hash": "…" }` |

Find every failed install with
`select path, last_install_at, last_install from plugin where last_install_status='failed'`.

`step` is where it stopped: `schema`, `settings`, `segments`, `install_hook`,
or `inbound`. `trigger` is what ran it: `upgrade`, `upgrade_plugin`,
`install_default`, `install`, or `cli`. They are a cache for this command and `upgrade --failed`. The history of every
install is the audit log (below). Status always diffs the schema itself,
whatever these columns say.

To retry, or to see what an install would do:

```bash
npx e9core upgrade --plugin @engine9/schemas/event --url https://www.example.com --dry-run --sql
npx e9core upgrade --plugin @engine9/schemas/event --url https://www.example.com
npx e9core upgrade --failed --url https://www.example.com
```

Each plugin in the result has its diff `before` and `after`, its `status`, and,
on a failure, `step` and `error`. `--sql` adds the statements the diff would
run (SQLite and D1).

## The audit log

Changes to the database's structure, plugins, keys, settings, and who holds a
role go to the audit log. People data goes to the data log. The two never mix,
and the audit log holds no people data except the person id or email of
someone who gains or loses a role.

| Record | When |
| --- | --- |
| `plugin.install` | An install changed the schema, failed, or was the plugin's first. `meta.changes` lists the tables and columns it changed |
| `upgrade`, `upgrade.plugins` | `e9core upgrade` (not a dry run), by any route: `--url`, `--db`, the server. Who ran it: the API key and role, or `by: "cli"` |
| `plugins.install` | `e9core install --url` (`POST /admin/install`), with the plugin and what it included |
| `role.grant`, `role.revoke` | A role segment's membership changed, with who did it |
| `segment.policy` | `e9core segment policy` changed who may join, leave, or manage a segment |

| Host | Sink |
| --- | --- |
| Cloudflare | An R2 bucket bound as `AUDIT_BUCKET` (objects under `audit/`). Without it, each record is one JSON line in the Worker log |
| Node (`e9core serve`) | `./logs/audit/engine9-audit-<date>.jsonl` when `./logs` exists |
| Your own host | `createApi({ audit })` or `new PluginWorker({ audit })`: `BatchLogger` with `r2Sink` or `s3Sink`, or `JsonlFileLogger` |
| `e9core … --db` | `./logs/audit` when `./logs` exists, else stderr |

## For plugin authors: a `status` hook

A plugin can report what a schema diff cannot see: a webhook it registered, a
setting it needs, a remote account it connects to. Export `status` next to
`install` on the plugin's default export:

```js
export default {
  metadata: { name: 'Acme Blog' },
  schema,
  async status({ sqlWorker, plugin, account }) {
    const { data } = await sqlWorker.query('select count(*) as n from acme_blog_post');
    return [
      { id: 'posts', status: data[0].n ? 'pass' : 'warn', title: `${data[0].n} posts`, fix: 'Import the posts' }
    ];
  }
};
```

- Return an array of `{ id, status, title, detail?, fix?, data? }`. Each
  becomes `plugin.custom.<id>`.
- Read only. Status runs inside a Worker request with a D1 query budget, so
  keep it to a few queries.
- It has 5 seconds. A hook that throws or takes longer is reported as
  `plugin.custom.error`, and the rest of the report still runs.
