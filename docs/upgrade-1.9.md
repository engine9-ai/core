# Upgrading Cloudflare deployments to @engine9/core 1.9.1

Instructions for an agent that maintains several Cloudflare sites built on
`@engine9/core` with a D1 database. Do every step for every deployment.

## What changed

- The schema package `@engine9/interfaces` is now `@engine9/schemas`.
  `@engine9/interfaces` is not published past 1.8.1.
- Core 1.9.1 matches plugin paths exactly. It does not read
  `@engine9/interfaces/...` paths, and it does not strip the old `local$`
  prefix. A D1 row that still uses either fails to load (`PLUGIN_NOT_FOUND`
  or `PLUGIN_PACKAGE_NOT_DECLARED`), and settings stored on such a row read as
  unset.
- Core 1.8 cannot load `@engine9/schemas/...` paths. Old code needs old rows,
  and new code needs new rows. So rewrite the D1 rows right before the new
  Worker is deployed, with the build already done.

No table, column, or ID changes. Only stored path strings change.

## 1. Inventory

Make a table with one row per production database before you change anything:

| Project directory | Worker name | Wrangler env | D1 binding | D1 database name | Cloudflare account |
| --- | --- | --- | --- | --- | --- |

- A deployment is a directory whose `package.json` depends on `@engine9/core`.
- Read `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` for `name` and
  `d1_databases[].database_name`. Check `env.<name>.d1_databases` too. Each
  environment is its own row, and every wrangler command for it needs `--env <name>`.
- Run `npx wrangler whoami`. If the token can see several accounts, set
  `CLOUDFLARE_ACCOUNT_ID` for each row.

Stop and report if any row is missing a value.

## 2. Back up each database

```bash
npx wrangler d1 time-travel info <database> --remote
npx wrangler d1 export <database> --remote --output backup-<database>-<yyyymmdd>.sql
```

Record the bookmark from `time-travel info`. It is the fastest way to roll back.

## 3. Update the project

In the project directory:

```bash
npm uninstall @engine9/interfaces
npm install @engine9/core@^1.9.1 @engine9/schemas@^1.9.0
```

Then:

1. In `package.json`, change `engine9.pluginPackages` from
   `["@engine9/interfaces", ...]` to `["@engine9/schemas", ...]`. If
   `engine9.plugins` lists identities, change each
   `@engine9/interfaces/...` there to `@engine9/schemas/...`.
2. Search the project, excluding `node_modules`, `dist`, `.wrangler`, and
   `migrations`:

   ```bash
   rg -n -F '@engine9/interfaces' --glob '!node_modules' --glob '!dist' --glob '!.wrangler' --glob '!migrations' .
   rg -n -F 'local$' --glob '!node_modules' --glob '!dist' --glob '!.wrangler' --glob '!migrations' .
   ```

   Change every `@engine9/interfaces/` to `@engine9/schemas/` and remove every
   `local$` prefix. Look in source, `astro.config.*`, wrangler alias lists,
   seed scripts, and any SQL the site generates at run time.
3. Leave files in `migrations/` that have already been applied alone. D1
   tracks them by name. Do not rename or rewrite them.
4. Delete `engine9.plugins.js` if it exists. The build writes it again.
5. Build without deploying. Use the project's build script, for example
   `npm run build`. This must run `e9core build-plugins`. Fix any failure now,
   while production still runs the old Worker and the old rows.

## 4. Check the database

Find which tables exist:

```bash
npx wrangler d1 execute <database> --remote --json --command \
  "select name from sqlite_master where type='table' and name in ('plugin','plugin_history','segment','setting')"
```

Count the rows that need rewriting. Leave out the lines for tables that do not
exist:

```bash
npx wrangler d1 execute <database> --remote --json --command "
select 'plugin.path' as col, count(*) as n from plugin where path like '%@engine9/interfaces/%' or path like '%local\$%'
union all select 'plugin.schema', count(*) from plugin where schema like '%@engine9/interfaces/%' or schema like '%local\$%'
union all select 'plugin_history.path', count(*) from plugin_history where path like '%@engine9/interfaces/%' or path like '%local\$%'
union all select 'segment.definition_path', count(*) from segment where definition_path like '%@engine9/interfaces/%' or definition_path like '%local\$%'
union all select 'segment.search', count(*) from segment where search like '%@engine9/interfaces/%' or search like '%local\$%'
union all select 'setting.value', count(*) from setting where value like '%@engine9/interfaces/%' or value like '%local\$%'"
```

Check that no plugin is stored under both an old and the current path:

```bash
npx wrangler d1 execute <database> --remote --json --command "
select replace(replace(path, 'local\$', ''), '@engine9/interfaces/', '@engine9/schemas/') as path, count(*) as n
from plugin
where path not like '%person_custom%'
group by 1
having count(*) > 1
   and sum(case when path like '%@engine9/interfaces/%' or path like '%local\$%' then 1 else 0 end) > 0"
```

If this returns any rows, stop for that deployment and report them. Do not
delete plugin rows yourself; segments and settings point at them by `id`.
`person_custom` is excluded because it may have several rows on purpose.

If every count is 0, the database is already current. Go to step 6.

## 5. Rewrite and deploy

Write `rewrite-plugin-paths.sql`, again leaving out the statements for tables
that do not exist:

```sql
update plugin set path = replace(replace(path, 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/')
  where path like '%@engine9/interfaces/%' or path like '%local$%';
update plugin set schema = replace(replace(schema, 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/')
  where schema like '%@engine9/interfaces/%' or schema like '%local$%';
update plugin_history set path = replace(replace(path, 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/')
  where path like '%@engine9/interfaces/%' or path like '%local$%';
update segment set definition_path = replace(replace(definition_path, 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/')
  where definition_path like '%@engine9/interfaces/%' or definition_path like '%local$%';
update segment set search = replace(replace(search, 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/')
  where search like '%@engine9/interfaces/%' or search like '%local$%';
update setting set value = replace(replace(value, 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/')
  where value like '%@engine9/interfaces/%' or value like '%local$%';
```

Run it and deploy immediately after:

```bash
npx wrangler d1 execute <database> --remote --file rewrite-plugin-paths.sql
npx wrangler deploy
```

- Use `d1 execute --file`. Do not add this file to `migrations/`.
- The `modified_at` trigger updates that column on the rewritten rows. That is
  expected.
- The statements are safe to run again; a second run changes nothing.

Run the same file with `--local` instead of `--remote` to update the local
development database.

## 6. Verify

1. Run the count query from step 4 again. Every count must be 0.
2. Run `npx wrangler tail <worker>` and load the site. Exercise one request
   that uses `/api` (for example a sign-in, or a people write with the site's
   API key). There must be no `PLUGIN_NOT_FOUND`,
   `PLUGIN_PACKAGE_NOT_DECLARED`, or `plugin_registry_missing` errors.
3. `npm ls @engine9/interfaces` must not list the package.

## Rolling back one deployment

```bash
npx wrangler d1 time-travel restore <database> --bookmark=<bookmark from step 2>
npx wrangler rollback
```

Restore the database and roll back the Worker together. Either one on its own
leaves code and rows that do not match.

## Report

When you finish, report one line per inventory row: the counts before, the
counts after, the deployed version id, and whether verification passed. List
separately every deployment you stopped on, with the reason.

## Not on Cloudflare

A Node host on MySQL or MariaDB stores the same columns. Use the same
statements, with three changes: write `` `schema` `` in backticks, because it
is a reserved word; read the JSON columns through `cast(... as char)`; and
assign `modified_at = modified_at` so the rewrite does not change it:

```sql
update `segment` set `search` = replace(replace(cast(`search` as char), 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/'), modified_at = modified_at
  where cast(`search` as char) like '%@engine9/interfaces/%' or cast(`search` as char) like '%local$%';
update `plugin` set `schema` = replace(replace(cast(`schema` as char), 'local$', ''), '@engine9/interfaces/', '@engine9/schemas/'), modified_at = modified_at
  where cast(`schema` as char) like '%@engine9/interfaces/%' or cast(`schema` as char) like '%local$%';
```

Add `, modified_at = modified_at` to the other four updates as well.
