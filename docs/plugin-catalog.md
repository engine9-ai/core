# Plugin catalog entries

A catalog entry is the published surface of one plugin: what it is, who
publishes it, what a person configures (credentials and settings), and what a
caller can run (methods). Secrets tools, task callers, settings screens, and
plugin catalogs such as [market.engine9.ai](https://market.engine9.ai) read the
entry. None of them reads the plugin's code to find these things out.

An entry does not list everything a plugin does. Tables, transforms, upgrades,
install rules, and anything a plugin keeps to itself stay in the package. A
method that is not in the entry can still exist; it just is not offered to
callers.

- JSON Schema: [plugin-catalog.schema.json](plugin-catalog.schema.json),
  exported as `@engine9/core/pluginCatalog.schema.json`. Its `$id`,
  `https://market.engine9.ai/schemas/plugin/v1.json`, names the standard;
  `PLUGIN_CATALOG_SCHEMA_URL` is read from that file.
- Build and check entries: `@engine9/core/pluginCatalog`
  (`buildPluginCatalogEntry`, `validatePluginCatalogEntry`) and
  `e9core catalog build` / `e9core catalog validate`.

## One entry per plugin

Each plugin has its own entry, a JSON file published on its own. The plugin
path is the entry's identity, the same path install uses
(`acme-plugins/loyalty`, `@engine9/plugins/e9email`,
`@frakture-com/channelbots/ActBlueBot`).

A catalog publishes the newest entry for each path and the entry for each
package version, which never changes once published. Where a catalog serves
them is the catalog's own business; a host finds entries and definitions
through the catalog it is configured to use, never through an address in
core.

The version is the npm package version (`package.json` `"version"`), the
only version a plugin has. A task caller that knows which package version a
host runs reads that version's entry; anything else reads the newest.

## Example

```json
{
  "$schema": "https://market.engine9.ai/schemas/plugin/v1.json",
  "catalog_version": 1,
  "path": "acme-plugins/shop",
  "package": { "name": "acme-plugins", "version": "1.4.0" },
  "name": "Acme Shop",
  "alias": "acmeshop",
  "description": "Orders and customers from an Acme shop.",
  "categories": ["commerce"],
  "logo": "https://acme.example/engine9/logo.png",
  "homepage": "https://acme.example/engine9",
  "publisher": { "name": "Acme", "url": "https://acme.example", "email": "engine9@acme.example" },
  "dependencies": { "@engine9/schemas/person": ">=1.9.0" },
  "credentials": {
    "fields": [
      { "name": "shop_id", "type": "string", "label": "Shop ID", "required": true, "secret": false },
      { "name": "api_key", "type": "password", "label": "API key", "required": true, "secret": true }
    ]
  },
  "settings": [
    { "name": "late_days", "type": "integer", "default": 7, "min": 1, "description": "Days before an order counts as late." }
  ],
  "submodules": {
    "Orders": {
      "description": "Orders from the shop.",
      "methods": {
        "loadOrders": {
          "description": "Read orders placed since a date.",
          "options": {
            "start": { "type": "date", "description": "Earliest order date", "required": true },
            "limit": { "type": "integer", "description": "Most orders to read" }
          }
        }
      }
    }
  }
}
```

## The entry

| Key | Required | |
| --- | --- | --- |
| `$schema` | | The schema URL above. Producers write it |
| `catalog_version` | yes | `1` |
| `path` | yes | The plugin path. It starts with `package.name` |
| `package` | yes | `{ name, version }`. `name` is the package part of the path; `version` is that package's release version |
| `name` | yes | Display name |
| `publisher` | yes | `{ name, url?, email? }`: who stands behind the plugin and answers for it |
| `alias` | | Short lower-case name callers may use for the plugin (`mailchimp`) |
| `description` | | One or two sentences |
| `categories` | | Strings, such as `crm`, `email`, `payments`, `commerce` |
| `logo` | | An https URL, or a path starting with `/` on the host that serves the entry |
| `homepage` | | An https URL for people to read about the plugin |
| `bot_path` | | Frakture plugins only: the Frakture bot id that runs it (`channelbots.ActBlueBot`) |
| `dependencies` | | `{ "<plugin path>": "<semver range>" }`: plugins that must be installed first, as in `metadata.dependencies` |
| `credentials` | | What a person enters to connect the plugin. Kept in secrets |
| `settings` | | Per-install configuration. Kept in the account's `setting` table |
| `methods` | | Methods a caller can run on the plugin itself |
| `submodules` | | `{ Name: { description?, settings?, methods? } }` |

Any other key is an error, except keys that start with `x-`, which consumers
ignore. Use `x-<publisher>-…` for something only your own tools read.

## Fields

Credentials, settings, and method options are all fields, and share one
vocabulary. It is the secrets definition format
([secrets docs/definitions.md](https://secrets.engine9.ai/docs)), with
`array`, `date`, `datetime`, and `deprecated` added.

| Key | |
| --- | --- |
| `name` | The key in the value object. Letters, digits, `_ . -`; up to 64. In method options the name is the key of `options`, so leave it out |
| `type` | `string`, `text`, `password`, `secret_text`, `email`, `url`, `number`, `integer`, `boolean`, `select`, `json`, `array`, `date`, `datetime` |
| `label`, `description`, `help`, `placeholder` | How the field is shown |
| `section` | Groups fields in a form. For credentials, a key of `credentials.sections` |
| `required` | A value must be given |
| `hidden` | Kept, but not shown in forms |
| `secret` | The value is never shown again once saved |
| `deprecated` | `true`, or a note saying what to use instead |
| `default` | Used when no value is given. Never on a secret field |
| `values` | The choices for a `select`: strings, or `{ value, label }` |
| `pattern` | A regular expression a text value must match |
| `min`, `max` | A number range, or a text length |

A missing `type` is `string` in credentials and settings. In method options a
missing `type` means any JSON value.

## Credentials

`credentials.fields` lists what a person enters to connect the plugin: keys,
tokens, logins, account ids. Every credentials field says `secret`: `true`
for anything that grants access, `false` for an id or a region a person may
read back. `credentials.sections` gives section keys a label and description.

Credentials are kept in secrets, never in settings. A catalog derives the
secrets definition from the newest entry's `credentials` with
`pluginCredentialsDefinition`, so every catalog derives the same one. The
host (secrets, the server) looks it up through its own configured catalog. A
plugin with no `credentials` has no definition, so a plugin whose secrets
need a definition declares at least one field. Secrets saved for a plugin
follow its newest definition, so a new field reaches every connection without
rewriting it. A field that was ever secret stays
secret in secrets, whatever a later entry says.

A field the plugin writes for itself, such as an OAuth refresh token, need
not be declared: secrets treats an undeclared field as secret.

## Settings

`settings` are per-install configuration that people may read back: names of
custom fields to pull, a default phone type, a sync interval. They are kept in
the account's `setting` table, one row per plugin install.

- Setting names are plugin-wide. A submodule's settings share the plugin's
  row, and get that submodule's name as their `section` unless they set one.
  The same name twice in one entry is an error.
- A secret does not belong in settings. A setting with `secret: true` is a
  warning in version 1; declare it under `credentials`.

A host reads settings from the entry first, then from the package (its
`settings` export) for names the entry does not declare.

## Methods and submodules

`methods` and `submodules.<Name>.methods` list what a caller can run. A task
names the plugin path, the submodule, and the method
(`acme-plugins/shop:Orders` + `loadOrders`) and passes options that match the
method's `options`.

Methods are opt-in. An entry lists only the methods the plugin chose to
publish, each with its options. A caller never offers a method the entry does
not list.

| Method key | |
| --- | --- |
| `description` | What it does |
| `deprecated` | `true`, or a note naming what replaces it |
| `options` | `{ name: field }` |

A submodule appears when it publishes methods or declares settings.

## Producing an entry

### A package a host installs

Run `e9core catalog build` in the package's own checkout (or a site that
installs it). It loads the plugins through `package.json` `"engine9"`, the same
way install does, and writes one entry per plugin:

```bash
npx e9core catalog build --package acme-plugins --out catalog
npx e9core catalog validate catalog/acme-plugins/*.json
```

It reads, from each plugin:

| From | Becomes |
| --- | --- |
| `metadata.name`, `alias`, `description`, `categories`, `logo`, `homepage`, `dependencies` | The same keys |
| `metadata.publisher`, else the package's `"author"` | `publisher` |
| `package.json` `"version"` | `package.version` |
| A `credentials` export: `{ fields, sections? }` or a list of fields | `credentials` |
| The `settings` export or `settings.js` | `settings` |
| A worker class on the plugin object, with `metadata` | A submodule. Its `metadata.catalog_methods` lists the methods to publish; their options come from `Worker.prototype.<method>.metadata.options` |

`metadata.unique`, `metadata.prefix`, schemas, transforms, and upgrades are
install rules, not part of the published surface, and are left out.

### Plugins that run elsewhere

Engine9's own workers and Frakture's bots run on their own servers, so their
code is not loaded by the host. Their builders write the same entries:
engine9's `Engine9Workers.registerPluginCatalog` and Frakture's
`BotFactory.register`. Frakture bots list published methods in
`metadata.mcp_methods` (or `catalog_methods`) and keep their own
`auth_fields`, which the builder converts to `credentials`.

## Publishing

How entries are published is up to each catalog: its API, keys, and
addresses are in its own guide (market's is
[market.engine9.ai/docs](https://market.engine9.ai/docs)). Any catalog:

- **Validates every entry** with `validatePluginCatalogEntry`, the same check
  `e9core catalog validate` runs, and refuses one that does not meet the
  standard.
- **Stores each version once.** A published `path` and `package.version`
  never change. The same content again is not an error; different content for
  a published version is refused.
- **Derives secrets definitions with `pluginCredentialsDefinition`.**

A published version never changes, so anything that changes an entry needs a
new `package.version`, and two builds of the same code must produce the same
entry (no timestamps or hostnames).

## Bundles

A host reads entries through `ENGINE9_PLUGIN_METADATA_PATH`: one file or a
directory of files. A file holds one entry, or an object of entries keyed by
path (a bundle). The producers above write one file per plugin and then bundle
them (`bundlePluginCatalog`) into `engine9-plugins.catalog.json` and
`frakture-bots.catalog.json` for hosts that read those. A bundle has no
meaning beyond the entries in it.

## From the older shape

Entries written before this standard nested credentials and settings in
`metadata`. Hosts read both shapes during the move; producers write only this
one.

| Before | Now |
| --- | --- |
| `metadata.name`, `metadata.alias`, `metadata.categories`, `metadata.logo` | `name`, `alias`, `categories`, `logo` |
| `metadata.auth_fields` (a map; `is_visible`, `options`, `type: "link"`) | `credentials.fields` (a list; `secret`, `values`, `hidden`) |
| `metadata.auth_sections` | `credentials.sections` |
| `metadata.settings`, `submodules.<Name>.metadata.settings` | `settings`, `submodules.<Name>.settings` |
| `metadata.dependencies` | `dependencies` |
| `methods`, `submodules.<Name>.methods` | Unchanged; options are fields |
| `metadata.prefix`, `unique`, `version`, `mcp_methods`, `channel`, `isWarehouse`, `message_*`, `picture`, `thumbnail` | Left out |

## Checklist for a plugin author

- Every plugin has `metadata.name`, a `publisher` (or the package has an
  `"author"`), and a package version.
- Credentials are a `credentials` export, each field with `secret` set. No
  key, token, or password is a setting.
- Settings have distinct names across the plugin and its submodules.
- Only the methods a caller should run are in `catalog_methods`, each with
  described options.
- `e9core catalog validate` passes with no warnings before you publish.
