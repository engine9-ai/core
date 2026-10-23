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

Release guides: [1.12.0](upgrade-1.12.md) (operator role removed; superadmins),
[1.11.3](upgrade-1.11.md) (`setting.value` widens to text),
[1.10.1](upgrade-1.10.md) (person names move to `person_name`),
[1.9.1](upgrade-1.9.md) (package rename; written before `e9core upgrade`
existed, so it is a manual runbook).

## What `e9core upgrade` does

It calls `PluginWorker.upgrade` ([lib/upgrades](../lib/upgrades/index.js)):

1. **Account upgrades, in release order.** Each one is a data change that
   adding tables and columns cannot make. For example, 1.10.1 moves
   `person.given_name` / `family_name` into `person_name` and drops them from
   `person`. An upgrade looks at the database first and does nothing when the
   account is already current. A re-run finishes a partial run.
2. **Refresh.** It reinstalls every installed `@engine9/schemas` plugin from
   the deployed package. That adds new tables and columns (never drops) and
   refreshes each plugin's inbound pipeline snapshot. Stacks go first, so a
   stack that now includes a new plugin installs it.
3. **Ledger.** It records each upgrade as a `setting` row on the
   `@engine9/schemas/plugin` row, named `upgrade.<id>`, with the time, the
   result, and the `@engine9/schemas` version. The row is written once, the
   first time a real run finds the account current.

The JSON result has `ok`, and each upgrade has a `status`:

| `status` | Meaning |
| --- | --- |
| `pending` | Dry run: this upgrade has work to do |
| `applied` | This run changed the database |
| `current` | Nothing to do |
| `blocked` | Needs a decision. A real run stops here and changes nothing for this upgrade |
| `opt_in` | A removal that runs only with its switch (`opt_in` names it, e.g. `drop_name_columns`). Nothing changed |

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

Add `--dry-run` to see the plan first. `--no-refresh` skips step 2.

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
7. **Verify** with the checks in the release guide.

Deploy first, then upgrade. The old code expects the old tables. The new code
keeps working on a database that has not been upgraded yet: every release
keeps the steps an old inbound snapshot names, so writes still land where they
did until the upgrade moves them. Keep the gap between steps 4 and 6 short.

In CI, run the upgrade right after the deploy, with the admin key as a secret:

```json
{
  "scripts": {
    "deploy": "wrangler deploy && e9core upgrade --url $E9_SITE_URL"
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
for every site, a dry run, a ledger, and one command after each deploy.

Do not add engine9 schema files to `migrations/` for `migrations apply`. The
`migrations/0001_engine9.sql` that `e9core setup` writes is loaded with
`wrangler d1 execute --file` and is not a migration ledger entry.

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

A release of `@engine9/schemas` or `@engine9/core` that removes, renames, or
moves a column, changes what a table means, or changes an inbound step that
old snapshots name ships an upgrade. An additive change (new table, new
column, new plugin in a stack) does not; the refresh deploys it.

- Add `lib/upgrades/<id>.js` exporting `{ id, since, description, run }` and
  append it to `UPGRADES`. Never remove or reorder entries. A site can skip
  several releases and run them all at once.
- `run(worker, options)` inspects the database and returns `pending`
  (dry run) or `changed` (real run), a `plan` of strings, and any
  facts the operator needs. A choice that loses data is `blocked` until an
  explicit option allows it. On a real run, throw instead.
- Use only `worker.query`, `describe`, `list`, and `install`, so the same code
  runs on D1, SQLite, and MySQL. Install any plugin the upgrade needs itself.
  Split long statements into chunks (D1 limits how long one statement runs).
- Copy, then check that nothing is left behind. Do not drop in the same
  upgrade: put the drop in a separate entry with `optIn: '<option>'`, which
  runs only when that option is true. Never drop data the upgrade did not
  verify.
- Keep the new code working against an un-upgraded database. Keep transforms
  that old snapshots name exported until the upgrade refreshes them.
- Bump the `@engine9/schemas` minor version and core's peer range to match.
  Write `docs/upgrade-<version>.md` (what changed, what to check in site code,
  verification queries). Test it in `test/upgrade.test.js` on SQLite and in
  `test/workerd.bundle.test.js` through the bundled Worker on D1.
