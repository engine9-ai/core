# Upgrading to @engine9/core 1.17.0 and @engine9/schemas 1.13.0

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL), or
engine9 server accounts. Do every step for every database. The general process
is in [upgrading.md](upgrading.md).

## What changed

- **Upgrades live in the plugins.** Core no longer carries any upgrade. Each
  plugin declares its own (`upgrades`, each with a `shouldUpgrade` check), and
  `e9core upgrade` runs those of the `@engine9/schemas` plugins
  ([plugin-upgrades.md](plugin-upgrades.md)). The four upgrades core carried
  moved to `@engine9/schemas` 1.13.0 with the same ids and options:
  `person_name` and `person_name_columns` (`@engine9/schemas/person`),
  `setting_value_text` and `plugin_history` (`@engine9/schemas/plugin`). With
  `@engine9/schemas` 1.12.0, core 1.17.0 finds no upgrades, so install both.
- **Upgrade windows.** Each release upgrades databases back to a stated
  version only: core from 1.9.0, `@engine9/schemas` from 1.9.0. A database
  outside a window is refused and told which release to upgrade through.
- **`plugin_history` is retired.** `@engine9/schemas` 1.12.0 no longer
  declares it. Nothing wrote to it. Install history is the audit log
  (`plugin.install` records). A new database does not create the table; an
  existing one keeps it until the opt-in `plugin_history` upgrade
  (`drop_plugin_history`) drops it. That upgrade drops only an empty table and
  refuses while it has rows.
- **Every install is recorded** in three new `plugin` columns
  (`last_install_at`, `last_install_status`, `last_install`), and in a
  `plugin.install` audit record when an install changed the schema or failed.
  The upgrade below adds the columns (it reinstalls `@engine9/schemas/plugin`
  first); installs before it skip the record. The upgrade windows read these
  records.
- **Upgrades keep no ledger.** Each real `e9core upgrade` writes one `upgrade`
  record to the audit log. The `upgrade.<id>` settings that earlier versions
  wrote on `@engine9/schemas/plugin` are no longer read; they stay until you
  delete them.
- **`e9core status`** checks the database against the deployed code
  ([status.md](status.md)), including which upgrades apply.

The default upgrade changes no people data: it adds the `plugin` columns. The
`plugin_history` drop is opt-in.

## 1. Install and deploy

```bash
npm install @engine9/core@^1.17.0 @engine9/schemas@^1.13.0
npx wrangler deploy   # or restart the Node service / server release
```

## 2. Upgrade, then check

```bash
npx e9core upgrade --url https://www.example.com --dry-run
npx e9core upgrade --url https://www.example.com
npx e9core status --url https://www.example.com
```

Before this upgrade, `status` warns `upgrades.window`: the plugin rows have no
install record yet. The upgrade records one on every row, and the warning
clears. `status` reports `upgrade.plugin_history` as `skip` while the opt-in
step has not run, and only on a database that still has the table.

## 3. Optional: drop `plugin_history`

```bash
npx e9core upgrade --url https://www.example.com --dry-run --drop-plugin-history
```

- `current`: the table is already gone.
- `pending`: it is empty. Run the same command without `--dry-run`.
- `blocked`, with a row count: something outside core wrote to it. Those rows
  are not in the audit log. Copy them somewhere you keep, delete them
  (`delete from plugin_history`), then run the drop.

Server account: `e9 pluginworker upgrade -a <account_id> --drop_plugin_history true`.

## 4. Optional: delete the old ledger settings

Nothing reads them. To remove them:

```sql
delete from setting
where name in ('upgrade.person_name', 'upgrade.person_name_columns', 'upgrade.setting_value_text', 'upgrade.plugin_history')
  and plugin_id in (select id from plugin where path = '@engine9/schemas/plugin');
```

## 5. Verify

```bash
npx e9core status --url https://www.example.com
```

No failures. `upgrades.window` passes. After the drop, `upgrade.plugin_history`
is no longer listed. A database that still has `person.given_name` keeps an
`upgrade.person_name_columns` skip until that opt-in drop runs.
