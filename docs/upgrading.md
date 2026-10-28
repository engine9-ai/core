# Upgrading @engine9/core and @engine9/schemas

Every engine9 database upgrades the same way, on every host:

1. Install the new packages.
2. Deploy the new code.
3. Run `e9core upgrade` against each database.

Step 3 is required. A deploy changes code only. The Cloudflare Worker never
installs plugins or changes tables, and a Node site changes them only when you
run a command. New tables, new columns, refreshed inbound pipelines, and data
moves all wait for `e9core upgrade`.

Permission levels and how to bring a site to them: [PERMISSIONS.md](../PERMISSIONS.md).

Release notes, with what a site changes at each release: [CHANGELOG.md](../CHANGELOG.md).

Release guides: [1.17.0](upgrade-1.17.md) (upgrades move into the plugins; `plugin_history` retired),
[1.12.0](upgrade-1.12.md) (operator role removed; superadmins),
[1.11.3](upgrade-1.11.md) (`setting.value` widens to text),
[1.10.1](upgrade-1.10.md) (person names move to `person_name`),
[1.9.1](upgrade-1.9.md) (package rename; written before `e9core upgrade`
existed, so it is a manual runbook).

## What `e9core upgrade` does

It calls `PluginWorker.upgrade` ([lib/upgrades](../lib/upgrades/index.js)):

1. **Window.** A database last upgraded with a core older than this
   release supports is refused before anything runs
   ([The upgrade window](#the-upgrade-window)).
2. **Plugin upgrades.** Core has no upgrades of its own. Each
   `@engine9/schemas` plugin declares the data changes a reinstall cannot make
   ([plugin-upgrades.md](plugin-upgrades.md)). For example,
   `@engine9/schemas/person` moves `person.given_name` / `family_name` into
   `person_name`. Each upgrade's `shouldUpgrade` looks at the schema first;
   only an upgrade that applies reads the data, and it does nothing when the
   account is already current. A re-run finishes a partial run.
3. **Refresh.** It reinstalls every installed `@engine9/schemas` plugin from
   the deployed package. That adds new tables and columns (never drops) and
   refreshes each plugin's inbound pipeline snapshot. `@engine9/schemas/plugin`
   goes first, then stacks, so a stack that now includes a new plugin
   installs it. Only `@engine9/schemas`
   plugins are refreshed. Any other plugin is upgraded by naming it
   ([Upgrading one plugin](#upgrading-one-plugin)).
4. **Record.** A real run writes one `upgrade` record to the audit log: the
   upgrades it applied, the plugins it reinstalled, those that failed, the
   `@engine9/schemas` version, and who ran it. Nothing about the run is kept
   in the database; the next run checks every upgrade again.

The JSON result has `ok`, and each upgrade has a `status`:

| `status` | Meaning |
| --- | --- |
| `pending` | Dry run: this upgrade has work to do |
| `applied` | This run changed the database |
| `current` | Nothing to do |
| `blocked` | Needs a decision. A real run stops here and changes nothing for this upgrade |
| `opt_in` | A removal that runs only with its switch (`opt_in` names it, e.g. `drop_name_columns`). Nothing changed |

Each upgrade also names the `plugin` that declares it. Pass an opt-in switch
as a flag: `--drop-name-columns` is `drop_name_columns`. Any flag the command
does not read itself goes to the upgrades, and `unused_options` in the result
names one no upgrade reads, such as a misspelling.

An opt-in upgrade removes something site code may still read, such as a
column whose data moved. The default run copies the data and leaves the old
column. Run the opt-in step once nothing reads it.

`refresh.failed` lists plugins that could not be reinstalled, usually a path
that is no longer in the installed package. The command exits 1 when `ok` is
false.

## Where to run it

| Database | Command |
| --- | --- |
| Cloudflare production (D1) | `npx e9core upgrade --url https://www.example.com` |
| Local `wrangler dev` (local D1) | `npx e9core upgrade --url http://localhost:8787` |
| Local SQLite file, or a Node site's SQLite or MySQL | `npx e9core upgrade --db sqlite://./engine9.db` |
| An account on the engine9 server | `e9 pluginworker upgrade -a <account_id>`, or MCP `plugin` with `command: upgrade` |

`--url` posts to `POST /api/admin/upgrade` with `E9_ADMIN_API_KEY` (from
`--key`, the environment, or `./.env`). The upgrade runs inside the Worker
against its own D1 binding. No process outside Cloudflare can open D1 with a
connection string. The route needs a key with the `admin` scope.

Add `--dry-run` to see the plan first. `--no-refresh` skips step 3.

Every install writes the plugin row's `last_install_at`, `last_install_status`,
and `last_install` columns and, when it changed the schema or failed, a `plugin.install` record in the audit log.
`npx e9core status` reads both ([docs/status.md](status.md)).

## Upgrading one plugin

```bash
npx e9core upgrade --plugin @acme/plugins/blog --url https://www.example.com --dry-run --sql
npx e9core upgrade --plugin @acme/plugins/blog --url https://www.example.com
npx e9core upgrade --failed --url https://www.example.com
```

`--plugin` runs only the named plugins (comma-separated): each one's own
upgrades, then a reinstall. A plugin that carries only upgrades for other
plugins runs without a plugin row
([plugin-upgrades.md](plugin-upgrades.md#upgrades-for-other-plugins)).
`--failed` reinstalls every plugin whose last install failed. Each plugin in the result has its diff `before` and `after`, its
`status` (`ok`, `failed`, `pending`, `current`, `not_installed`), and on a
failure the `step` and `error`. `--dry-run` changes nothing; `--sql` adds
the statements the diff would run (SQLite and D1).

Use it for a plugin outside `@engine9/schemas` after its package changes (an
upgrade never runs those on its own; `e9core status` reports their pending
upgrades), to
retry an install `e9core status` reports as failed, and to see exactly what
an install would run before it does.

## The upgrade window

Upgrades are deleted from a package once every supported database is past
them, so each release supports databases back to a certain version only:

- **Core**: `CORE_UPGRADE_FROM` in [lib/version.js](../lib/version.js),
  against the core version that last installed the `@engine9/schemas`
  plugins. Outside it, `e9core upgrade` refuses and changes nothing, and
  `e9core status` fails `upgrades.window`.
- **Each plugin**: its `upgradeFrom`, against the package version it was last
  installed from. Outside it, its upgrades and reinstall are skipped and
  `plugin.upgrade_window` fails.

Both read the install record on each plugin row. A database whose plugin rows
have no record was last upgraded before core 1.17.0; status warns, and the
next upgrade records every install.

A database outside a window upgrades through an older release first: install
the release the message names, deploy, `e9core upgrade`, then install the
current release and upgrade again.

## Order of operations

1. **Back up.** Cloudflare: `npx wrangler d1 time-travel info <database> --remote`
   and keep the bookmark. MySQL: a dump or snapshot.
2. **Read the release guide** and check your own code against it, for example
   site queries that read a column the release moves.
3. **Install and build.** `npm install @engine9/core@^X @engine9/schemas@^X`,
   then the project's build (which runs `e9core build-plugins`).
4. **Deploy.** `npx wrangler deploy`, or restart the Node service.
5. **Dry run.** `npx e9core upgrade --url <site> --dry-run`. Resolve anything
   `blocked`.
6. **Upgrade.** `npx e9core upgrade --url <site>`.
7. **Verify.** `npx e9core status --url <site>` ([docs/status.md](status.md)),
   then the checks in the release guide.

Deploy first, then upgrade. The old code expects the old tables. The new code
keeps working on a database that has not been upgraded yet: every release
keeps the steps an old inbound snapshot names, so writes still land where they
did until the upgrade moves them. Keep the gap between steps 4 and 6 short.

In CI, run the upgrade right after the deploy, with the admin key as a secret:

```json
{
  "scripts": {
    "deploy": "wrangler deploy && e9core upgrade --url $E9_SITE_URL && e9core status --url $E9_SITE_URL"
  }
}
```

## Why not `wrangler d1 migrations`

D1 migrations are the usual Cloudflare tool, and they are fine for your own
project tables. They do not fit engine9 tables:

- **Triggers.** Every engine9 table with `modified_at` needs a SQLite trigger.
  `wrangler d1 migrations apply` posts each file to D1 `/query` with a ledger
  insert appended, and `/query` breaks on the trigger body
  (`SQLITE_ERROR [code: 7500]`). See
  [Applying schema SQL to D1](../AGENTS.md#applying-schema-sql-to-d1).
- **One database type.** The same upgrade has to run on D1, SQLite, and MySQL
  (Node sites and the engine9 server).
- **Per-account decisions.** Upgrades read the account first: whether it is
  PII-free, which plugins are installed, what is already copied. A static SQL
  file cannot.
- **Plugin rows.** Inbound pipeline snapshots come from the plugin code in the
  deployed bundle, not from SQL.

`e9core upgrade` keeps what migrations are good for: the same ordered list
for every site, a dry run, a record of each run, and one command after each
deploy. It does not need a ledger of which steps ran: every step checks the
database, so a database restored from a backup, or one that skipped
releases, gets exactly the steps it still needs.

Keep engine9 schema files out of `migrations/`, the folder `wrangler d1
migrations` reads. `e9core setup` builds its schema in a temporary folder,
loads it with `wrangler d1 execute --file`, and deletes it. A file in `migrations/` that
was never applied with `migrations apply` stays pending in `wrangler d1
migrations list` forever, and `migrations apply` runs it again on a database
that already has the tables (`table api_key already exists`).

## Rolling back

The default upgrade copies and does not drop, so rolling back the Worker
alone runs the old code. An opt-in step can drop columns; after one, rolling
back the Worker alone leaves old code on a new database. Roll back both
together:

```bash
npx wrangler d1 time-travel restore <database> --bookmark=<bookmark from before the upgrade>
npx wrangler rollback
```

On MySQL, restore the backup, then deploy the old version.

## Writing an upgrade (maintainers)

A release of a plugin package that removes, renames, or moves a column,
changes a column's type, changes what a table means, or changes an inbound
step that old snapshots name ships an upgrade in that plugin. An additive
change (new table, new column, new plugin in a stack) does not; the refresh
deploys it. Core never carries a plugin's upgrade. The contract, the rules,
and how to retire an upgrade are in [plugin-upgrades.md](plugin-upgrades.md).

For `@engine9/schemas`: bump its minor version and core's peer range to
match, write `docs/upgrade-<version>.md` here (what changed, what to check in
site code, verification queries), and test it in `test/upgrade.test.js` on
SQLite and in `test/workerd.bundle.test.js` through the bundled Worker on D1.
