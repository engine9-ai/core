# Writing plugin upgrades

Core declares no upgrades. A plugin that changes its tables in a way a
reinstall cannot carries the upgrade itself, next to its schema. Core finds
it, asks it whether it applies, and runs it. Running upgrades for a whole
database is in [upgrading.md](upgrading.md).

A reinstall adds tables, columns, and indexes, and refreshes the plugin's
inbound snapshot. Ship an upgrade only when a release does something a
reinstall cannot:

- removes, renames, or moves a column, or moves data to another table;
- changes a column's type (a reinstall never changes a type);
- changes what a table means;
- changes an inbound step that saved snapshots name.

A new table, a new column, or a new plugin in a stack needs no upgrade.

## The declaration

A plugin's default export may carry `upgrades` and `upgradeFrom`:

```js
// my_plugin/index.js
import schema from './schema.js';
import { upgrades } from './upgrades.js';

export default {
  metadata: { name: '@acme/plugins/blog' },
  schema,
  upgrades,
  upgradeFrom: '2.0.0'
};
```

```js
// my_plugin/upgrades.js
export const upgrades = [
  {
    id: 'blog_slug',
    since: '2.3.0',
    description: 'Move acme_blog_post.legacy_slug into acme_blog_slug.',
    shouldUpgrade: async ({ snapshot }) => {
      if (!snapshot.hasTable('acme_blog_post')) return false;
      const { columns } = await snapshot.describe({ table: 'acme_blog_post' });
      return columns.some((c) => c.name === 'legacy_slug');
    },
    run: async ({ sqlWorker, dryRun }) => {
      // Inspect the data, return the plan; change it only when !dryRun.
    }
  }
];
```

Put `upgrades.js` beside `index.js`. Do not make an `upgrades/index.js`
folder: every directory with an `index.js` in a plugin package is a plugin.

| Field | Meaning |
| --- | --- |
| `id` | Unique in the plugin. `e9core status` reports it as `upgrade.<id>` |
| `since` | The version of the plugin's package that needs it |
| `description` | One sentence for the dry run and for status |
| `optIn` | Optional. An option name, e.g. `drop_name_columns`. The upgrade runs only when that option is true; otherwise a run reports `opt_in` and changes nothing |
| `options` | Optional. `{ name: description }` for other options `run` reads, e.g. `discard_names` |
| `shouldUpgrade(ctx)` | Does this upgrade apply? Return a boolean |
| `run(ctx)` | Do it, or with `ctx.dryRun` report what it would do |

`upgradeFrom` is the plugin's [upgrade window](#the-upgrade-window).

### `shouldUpgrade`

Answer from the schema. `ctx.snapshot` is the schema as read once for the
whole run: `hasTable(name)`, `tableType(name)`, `tableNames()`,
`describe({ table })`, `indexes({ table })`. `ctx.account.excludePii` is
whether the account is PII-free. You may read `plugin` and `setting` rows
through `ctx.sqlWorker`, and nothing else. Never read people tables here.

`e9core status` calls `shouldUpgrade` for every upgrade on every check,
including on a copy of the database that has no data rows. A `false` answer
costs nothing more: `run` is not called and the upgrade is not listed. In
status it has five seconds to answer.

An upgrade can stay `true` after it has run, for example while an opt-in
column drop has not happened yet. Then `run` decides, and a dry run that
finds nothing to do reports `current`.

### `run`

`run(ctx)` returns an object:

| Key | Meaning |
| --- | --- |
| `pending` | There is work to do |
| `changed` | A real run changed the database |
| `plan` | Strings: what it will do (dry run) or did |
| `blocked` | A reason it cannot go on without a decision. Return it from a dry run; on a real run, throw an error with that reason instead |
| anything else | Facts the operator needs (`copied`, `people_with_names`, `dropped`) |

Rules:

- **Re-runnable.** Check the database before every step, so a second run
  finishes a partial one and a third does nothing.
- **Portable.** Use only `ctx.sqlWorker.query`, `describe`, `list`,
  `install`, `tableType`, and `changeColumnType`, so the same code runs on
  D1, SQLite, and MySQL. Split long statements into id ranges (D1 limits how
  long one statement runs).
- **Copy, verify, keep.** Copy the data, check nothing was left behind, and
  leave the old column. Put the drop in a separate upgrade with `optIn`.
  Never drop data the upgrade did not verify.
- **Install what it needs.** `sqlWorker.install({ path, unique: true,
  trigger: 'upgrade' })`.
- **Keep old code paths.** The new code must keep working on a database that
  has not been upgraded: keep transforms that saved snapshots name exported
  until the upgrade refreshes them.

### What `ctx` holds

| Key | Value |
| --- | --- |
| `sqlWorker` | The account's PluginWorker |
| `snapshot` | The schema, read at the start of the run and again after any upgrade that changed it |
| `plugin` | `{ id, path, tablePrefix, installed }` for the plugin that declares the upgrade. `id` is `null` and `installed` is `false` when it has no plugin row. A plugin installed twice runs its upgrades once per row |
| `account` | `{ id, name, excludePii }` |
| `options` | The run's options: opt-in switches and the options upgrades declare |
| `dryRun` | `run` only. `true`: change nothing |

## When upgrades run

Only `e9core upgrade` (`PluginWorker.upgrade`, `POST /api/admin/upgrade`)
runs them, and `e9core status` checks them. Installs, `installDefaultPlugins`,
and requests never call either hook.

| Plugin | Runs with |
| --- | --- |
| `@engine9/schemas` plugins | Every `e9core upgrade`. Every plugin in the build is asked, installed or not, so an upgrade can find tables its plugin row never recorded |
| Any other plugin | `e9core upgrade --plugin <path>`: its upgrades, then a reinstall. `e9core status` reports its pending upgrades with that command as the fix |

## Upgrades for other plugins

An upgrade can change any plugin's tables. A plugin can carry nothing but
upgrades: a suite of fixes across several plugins, for example. It needs no
schema and no plugin row:

```js
// @acme/upgrades/cleanup/index.js
export default {
  metadata: { name: 'Cleanup' },
  upgrades: [
    { id: 'empty_blog_titles', since: '1.0.0', description: '…', shouldUpgrade, run },
    { id: 'orphan_tags', since: '1.0.0', description: '…', shouldUpgrade, run }
  ]
};
```

List its package in `engine9.pluginPackages`, deploy, then run it by name:

```bash
npx e9core status --plugin @acme/upgrades/cleanup --url https://www.example.com
npx e9core upgrade --plugin @acme/upgrades/cleanup --url https://www.example.com --dry-run
npx e9core upgrade --plugin @acme/upgrades/cleanup --url https://www.example.com
```

Running it creates no plugin row. `ctx.plugin.installed` is `false`.

## The upgrade window

Upgrades do not stay in a package forever. Each package keeps a window: the
oldest version a database can have last been installed from for the current
upgrades to bring it current.

- A plugin declares `upgradeFrom`, a version of its own package. Every
  install records the package version on the plugin row
  (`last_install.version`). A row installed from a version below
  `upgradeFrom` is outside the window: `e9core status` fails
  `plugin.upgrade_window`, and `e9core upgrade` runs none of that plugin's
  upgrades and does not reinstall it.
- Core has its own window, `CORE_UPGRADE_FROM` in
  [lib/version.js](../lib/version.js), against the core version on the plugin
  rows `e9core upgrade` reinstalls (`last_install.core`, oldest first). A
  database outside it is refused before any upgrade runs (`upgrades.window`).
  Plugin rows with no install record were last installed before core 1.17.0.

The fix for a database outside a window is to upgrade through an older
release first: install the release named in the message, deploy, run
`e9core upgrade`, then return to the current release.

To retire an upgrade:

1. Raise `upgradeFrom` to a version every supported database has reached,
   for example the release from a year ago.
2. Delete every upgrade whose `since` is at or below the new `upgradeFrom`.
3. Note both in the package's release notes.

`@engine9/schemas` keeps one window for the package (`UPGRADE_FROM` in
`plugin/upgrades.js`), and its tests fail on an upgrade older than the window.

## Testing

Test an upgrade on SQLite through `PluginWorker.upgrade`. Build the old layout,
then check: the dry run reports `pending` and changes nothing, the real run
reports `applied`, a re-run reports `current`, and `e9core status` reports the
upgrade before and not after. Core runs the `@engine9/schemas` upgrades in
`test/upgrade.test.js`, and through the bundled Worker on D1 in
`test/workerd.bundle.test.js`. The machinery itself is tested in
`test/pluginUpgrades.test.js`.
