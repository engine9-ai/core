# Upgrading to @engine9/core 1.10.1 and @engine9/schemas 1.10.1

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL). Do every
step for every database. The general process is in
[upgrading.md](upgrading.md).

## What changed

- **Person names moved to `person_name`.** Many groups need PII-free data,
  and `person` is in every account. `given_name` and `family_name` are now in
  the `@engine9/schemas/person_name` table (`person_id` primary key). New
  `person` tables have only `id`, `created_at`, and `modified_at`.
  - The upgrade copies names into `person_name` and leaves the two columns on
    an existing `person`. Later loads write `person_name` only, so the
    `person` columns keep the names as of the upgrade. Dropping them is a
    separate, opt-in step (step 8).
  - The standard stack and the default core schemas install `person_name`.
  - The limited-pii stack and `exclude_pii` accounts never install it. On
    those accounts, inbound names are dropped.
- **Payer contact fields on `transaction`.** New installs put `given_name`,
  `family_name`, and `email` in `@engine9/schemas/transaction/contact_details`,
  which limited-pii excludes. This upgrade leaves those columns on existing
  `transaction` tables.
- **Search and exports.**
  - The name search is `@engine9/schemas/person_name:search:names`; the
    `person` search keeps ids only.
  - `appendName` is `@engine9/schemas/person_name:transforms:appendName`. The
    old `person:transforms:appendName` path still works. Both return null
    names on an account without `person_name`.
- **Console UI.** The person record forms that wrote names to `person` are
  gone.
- **New command.** `e9core upgrade` and `POST /api/admin/upgrade` are new in
  this release.

Signups and `POST /api/people` keep the same fields (`given_name`,
`family_name`). Only where they are stored changes.

## 1. Inventory

One row per database before you change anything:

| Project directory | Host (Cloudflare / Node) | Site URL | D1 database or connection | Wrangler env |
| --- | --- | --- | --- | --- |

For Cloudflare, read `wrangler.jsonc` (`name`, `d1_databases[].database_name`,
and every `env.<name>`). Each environment is its own row. Stop and report if
a row is missing a value, or if the project has no `E9_ADMIN_API_KEY` in
`.env` or in the deploy environment.

## 2. Check the site's own code

After step 6, `person.given_name` and `person.family_name` stop changing:
code that reads them sees names as of the upgrade, and names written there
are not read by core. After step 8 they are gone. Move that code to
`person_name` before step 8, and preferably before step 6. Search, excluding
`node_modules`, `dist`, `.wrangler`, and `migrations`:

```bash
rg -n 'given_name|family_name' --glob '!node_modules' --glob '!dist' --glob '!.wrangler' --glob '!migrations' .
```

Change each match that touches the `person` table:

| Before | After |
| --- | --- |
| `select p.given_name from person p` | `select n.given_name from person p left join person_name n on n.person_id = p.id` |
| `POST /api/upsert/person` with names | `POST /api/upsert/person_name` with `person_id`, or `POST /api/people` |
| A `reads` entry on `person` with name columns | The same read on `person_name` |
| A custom `upsertTables` list in `createApi` | Add `person_name` (the default list has it) |
| `person:search:person` with `givenName` / `familyName` | `person_name:search:names` |

Payloads to `POST /api/people` need no change.

## 3. Back up

```bash
npx wrangler d1 time-travel info <database> --remote
npx wrangler d1 export <database> --remote --output backup-<database>-<yyyymmdd>.sql
```

Record the bookmark. On MySQL, take a dump.

## 4. Update, build, deploy

```bash
npm install @engine9/core@^1.10.1 @engine9/schemas@^1.10.1
npm run build          # must run e9core build-plugins
npx wrangler deploy    # Node: restart the service
```

From here until step 6, signups still save names on `person` through the
account's saved inbound pipeline. Nothing is lost. Go straight on.

## 5. Dry run

```bash
npx e9core upgrade --url https://<site> --dry-run
```

Read `upgrades[0]` (`id: person_name`):

| Field | Expect |
| --- | --- |
| `status` | `pending`, or `current` if it already ran |
| `pii_free` | `false` for most sites |
| `people_with_names` | How many names will be copied |
| `plan` | Install `person_name`, copy, refresh the person snapshot |

`upgrades[1]` (`id: person_name_columns`) is the opt-in drop from step 8. It
reports `opt_in` while the columns exist and changes nothing.

If `status` is `blocked`:

- `person_is_view: true`: `person` is a view over an older table. Replace the
  view with a `person` table, then re-run.
- `person_plugin_installed: false`: the `person` table exists but the
  `@engine9/schemas/person` plugin row does not. Install the account's stack,
  then re-run.

A PII-free account (`pii_free: true`) copies nothing; its names stay on
`person` until step 8.

## 6. Upgrade

```bash
npx e9core upgrade --url https://<site>
```

Expect `ok: true`, `upgrades[0].status: applied`, `copied` equal to
`people_with_names`, `upgrades[1].status: opt_in`, and an empty
`refresh.failed`.

Run it for the local development database too:
`npx e9core upgrade --url http://localhost:8787` while `wrangler dev` is
running, or `--db sqlite://./engine9.db` for the local file.

## 7. Verify

```bash
npx wrangler d1 execute <database> --remote --json --command "pragma table_info(person)"
npx wrangler d1 execute <database> --remote --json --command "select count(*) as n from person_name"
npx wrangler d1 execute <database> --remote --json --command \
  "select s.value from setting s join plugin p on p.id = s.plugin_id where p.path = '@engine9/schemas/plugin' and s.name = 'upgrade.person_name'"
```

- `person` still has `given_name` and `family_name`.
- `person_name` holds at least `copied` rows.
- The ledger row exists.
- A signup with a name, through the site or `POST /api/people`, adds a
  `person_name` row. `npx wrangler tail` shows no errors.

A second `e9core upgrade` reports `status: current`.

## 8. Drop the person columns (opt-in, later)

Only when no code reads `person.given_name` or `person.family_name` (step 2
finds nothing that touches `person`):

```bash
npx e9core upgrade --url https://<site> --drop-name-columns --dry-run
npx e9core upgrade --url https://<site> --drop-name-columns
```

Expect `upgrades[1].status: applied` and
`dropped: ["person.given_name", "person.family_name"]`. Take a backup first
(step 3). The drop is blocked when a name on `person` has no `person_name`
row.

On a PII-free account with names on `person`, the drop is blocked: those
names have nowhere to go. Ask the site owner. Either the account should not
be PII-free (install the standard stack, then upgrade), or the names are
discarded (add `--discard-names`). Do not choose for them.

## Rolling back

Before step 8, `person` still has the name columns, so `wrangler rollback`
alone runs the old code. Names saved after the upgrade are only in
`person_name`.

After step 8, core 1.9 code cannot run. Restore the database and roll back
the Worker together:

```bash
npx wrangler d1 time-travel restore <database> --bookmark=<bookmark from step 3>
npx wrangler rollback
```

## Report

One line per inventory row: `people_with_names`, `copied`, the deployed
version id, and whether verification passed. List every row you stopped on,
with the reason (for example `blocked`, or site code still reading
`person.given_name`).
