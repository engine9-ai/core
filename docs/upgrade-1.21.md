# Upgrading to @engine9/core 1.21

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL), or
engine9 server accounts. Do every step for every site. The general process
is in [upgrading.md](upgrading.md).

## 1.21.0: required plugins; stacks become editions

Core 1.21.0 pairs with `@engine9/schemas` 1.14.0.

- Every database has the [required plugins](../README.md#the-required-plugins):
  `@engine9/schemas/plugin`, `person`, `segment`, and `source_code`. Core
  installs nothing else by default. `installDefaultPlugins` is gone.
- `@engine9/schemas/stacks/standard` is now `@engine9/schemas/editions/contact`,
  and `@engine9/schemas/stacks/limited-pii` is now
  `@engine9/schemas/editions/pii-free`. An edition lists only what it adds to
  the required plugins.
- The `default_stack` setting is retired.
- `exclude_pii` refuses plaintext contact plugins (and any plugin that
  includes one). It no longer chooses what to install.

### 1. Upgrade the packages, deploy, upgrade the database

```bash
npm install @engine9/core@^1.21.0 @engine9/schemas@^1.14.0
npx wrangler deploy            # Cloudflare; Node sites restart instead
npx e9core upgrade --url https://www.example.com --dry-run
npx e9core upgrade --url https://www.example.com
```

The dry run lists `retire_stacks` when the database has a `stacks/` plugin
row or a `default_stack` setting. The real run:

| Before | After |
| --- | --- |
| A `@engine9/schemas/stacks/standard` plugin row | The same row, renamed `@engine9/schemas/editions/contact` |
| A `@engine9/schemas/stacks/limited-pii` plugin row | The same row, renamed `@engine9/schemas/editions/pii-free` |
| A `stacks/` row whose edition already has a row | The `stacks/` row is deleted |
| `default_stack` naming a stack the account never installed | That edition is installed, unless `exclude_pii` refuses it (the contact edition on a PII-free account) |
| `default_stack` naming anything else | Reported as `dropped_default`; nothing is installed |
| The `default_stack` setting row | Deleted |

Between the deploy and `e9core upgrade`, `e9core status` reports the old
`stacks/` row as a plugin not in the build. The upgrade clears it. Tables and
people writes keep working throughout.

A database that is missing a required plugin gets it from the same run
(`refresh.required_missing` in the result, `core.required_plugins` in
status).

### 2. Change what calls the removed names

Find them:

```bash
rg -n "installDefaultPlugins|install-default-plugins|stackMetadata|loadStackMetadata|DEFAULT_CORE_SCHEMAS|STACK_PATH|default_stack|defaultStackPath|schemas/stacks/|--stack|stack\.json" . -g '!node_modules' -g '!dist' -g '!.wrangler'
```

| Find | Change to |
| --- | --- |
| `npx e9core installDefaultPlugins` (no path) | `npx e9core upgrade` (installs any missing required plugin) |
| `npx e9core installDefaultPlugins --stack <path>` or `--path <path>` | `npx e9core install --plugin <path>` |
| The deploy workflow's `command` option `installDefaultPlugins` | `install`, with `--plugin <path>` in `options` |
| `worker.installDefaultPlugins()` | `worker.installRequiredPlugins()`, then `worker.install({ path })` for what the site needs |
| `POST /api/admin/install-default-plugins` | `POST /api/admin/install` with `{ "path": "<plugin>" }` |
| `DEFAULT_CORE_SCHEMAS` | `REQUIRED_PLUGINS` from `@engine9/core/requiredPlugins`, plus the edition the site installs |
| `@engine9/core/stackMetadata`, `loadStackMetadata` | `@engine9/core/pluginIncludes`, `loadPluginIncludes` |
| `@engine9/schemas/stacks/standard`, `STANDARD_STACK_PATH` | `@engine9/schemas/editions/contact` |
| `@engine9/schemas/stacks/limited-pii`, `LIMITED_PII_STACK_PATH` | `@engine9/schemas/editions/pii-free` |
| `bootstrapAccount({ stack })` | `bootstrapAccount({ path })` |
| `stack.json` in a plugin package | `plugin.json` |

`DEFAULT_CORE_SCHEMAS` also held `person_name`, `person_remote`,
`person_email`, `person_phone`, and `person_address`. A site that relied on
them for a fresh database (a login that installs when rows are missing, a
test, a script) now installs them explicitly, usually with the contact
edition.

### 3. A site that sets `engine9.plugins`

`build-plugins` adds only the required plugins and the plugins they include
to an `engine9.plugins` list. Add the edition (or the plugins) the site
installs:

```json
{
  "engine9": {
    "pluginPackages": ["@engine9/schemas"],
    "plugins": ["@engine9/schemas/editions/contact"]
  }
}
```

A site with no `engine9.plugins` bundles every `@engine9/schemas` plugin and
needs no change.

### 4. PII-free accounts

`exclude_pii` refuses the contact edition and the plaintext contact plugins,
as before. It no longer installs the pii-free edition for you. An account
that wants hashed email and phone installs it:

```bash
npx e9core install --plugin @engine9/schemas/editions/pii-free --url https://www.example.com
```

An account that was already on the limited-pii stack has its row renamed by
the upgrade and needs nothing else.

### 5. A site set up from now on

Start a new site with the contact edition. The setup wizard's new
`plugins` step recommends it, or run `npx e9core setup --step plugins` before
`setup`. Either one writes `"engine9": { "install": ["@engine9/schemas/editions/contact"] }`
to `package.json`, and setup installs it in every database it creates. A
database that already exists gets it with:

```bash
npx e9core install --plugin @engine9/schemas/editions/contact --url https://www.example.com
```

Until a plugin that stores email is installed, `segment add --email` and
admin provisioning by email fail, and each sign-in makes a new person.

### 6. Plugin catalogs, secrets, and hosts

Core's docs no longer give a catalog's addresses or publish API. A service
that built entry or definition URLs from them
(`https://market.engine9.ai/definitions/<path>.json`,
`https://plugins.engine9.ai/definitions/<path>.json`) configures its catalog
address itself. Entries, the schema, and `PLUGIN_CATALOG_SCHEMA_URL` are
unchanged.

### 7. Check

```bash
npx e9core status --url https://www.example.com
```

`core.required_plugins` passes, and no `@engine9/schemas/stacks/` row is
left.
