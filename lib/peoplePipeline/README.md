# The inbound people pipeline and how plugins join it

This is the pipeline every person record goes through on its way into an
engine9 account: a signup form post, a CSV of donors, a nightly CRM sync, a
transaction file. It runs the same way on the server (`PersonWorker.loadPeople`)
and in the core client (`PersonWorker.processPeople`, including Cloudflare
Workers). The code is `getInboundTransforms.js` in this directory.

## The one idea: slots

The pipeline is a fixed sequence of **slots**. A slot is a phase, not a plugin.

| Slot        | Who fills it        | What happens here                                                                 |
| ----------- | ------------------- | --------------------------------------------------------------------------------- |
| `beforeAll` | caller only         | Anything a job wants to run first (rare).                                         |
| `normalize` | plugins             | Clean up field names/values before anyone looks at them. `person` lowercases keys. |
| `id`        | plugins             | Look at a row and push `identifiers[]` — things that can name a person (email hash, phone hash, remote id). Nothing is written. |
| `assign`    | **core only**       | Turn identifiers into a `person_id` (create a new person if none match), resolve the input, entry type and source code. |
| `upsert`    | plugins             | Queue rows for your tables now that `person_id` is known (`person_email`, `person_hash_email`, custom fields…). |
| `afterAll`  | caller only         | Anything a job wants to run last, e.g. timeline upserts.                          |

Order inside a slot does not matter. In `id` every plugin just adds identifiers
and core decides priority in `assign`. In `upsert` every plugin queues rows and a
single `sql.tables.upsert` step writes them all at the end. Core sorts woven
steps by path so the listing is stable and easy to compare.

## The weaver

Core does **not** have a list of person plugins. When a load starts it asks the
account which plugins are installed (`select … from plugin`) and, for each one
that declares inbound slots, drops its transforms into those slots. That is the
weaver. Install a plugin and its steps appear; uninstall it (or never install
it, as a PII-free account does with `person_email`) and they do not exist.

```
plugin rows ──► which plugins are installed
metadata.inbound ──► which slot each of their transforms belongs in
extraTransforms / omitTransforms ──► per-job additions and removals
                        │
                        ▼
      beforeAll → normalize → id → assign → upsert → afterAll
```

A PII-free account (`@engine9/interfaces/stacks/limited-pii`) is the clearest
example: it has `person_hash` installed and `person_email` / `person_phone` /
`person_address` not installed. The weave for that account has hash steps in
`id` and `upsert` and no plaintext steps anywhere. No flag in core, no branch —
just different rows.

## Joining as a plugin author

Two things, both in your package:

1. Export the transforms as usual (`transforms.id`, `transforms.upsert`, …).
2. Say which slot each one runs in:

```js
const metadata = {
  name: '@acme/engine9-loyalty',
  version: '1.0.0',
  inbound: {
    id: ['extractLoyaltyNumber'],
    upsert: ['upsertMembership']
  }
};
```

`inbound` maps **slot → list of your transform export keys**. The left side is
fixed vocabulary (`normalize`, `id`, `upsert`). The right side is whatever you
named your exports — prefer verbs that say what the step does
(`extractEmailHashes`, `upsertPersonEmail`). A slot can hold several:

```js
inbound: {
  id: ['extractLoyaltyNumber'],
  upsert: ['upsertMembership', 'upsertPoints']
}
```

Core does not guess from export names or from the `type` field on a transform
(outbound transforms also use `type: 'id'`). Only `metadata.inbound` puts a
transform into the pipeline.

Then install the plugin. `PluginWorker.install` checks every key exists on
`transforms`, checks that a transform declaring `type: 'id'` or `'upsert'` is in
that slot, and saves the spec onto the plugin row (`plugin.transforms.inbound`).
From then on the account weaves you in. No core change, no per-job config.

Rules of the slots you will use:

- **`id` transforms** receive `{ batch }`. Push
  `{ path, type, value }` onto `row.identifiers` (`type` is the identifier
  table, e.g. `email_hash_v1`). Do not write to the database. Export
  `type = 'id'`.
- **`upsert` transforms** bind `tablesToUpsert: { path: 'sql.tables.upsert' }`
  and queue rows with `mergeIntoQueue` from `@engine9/input-tools`. Every row
  already has `person_id`. Export `type = 'upsert'`. See
  `person_email/transforms/inbound/upsert_tables.js`.
- Keep transforms self-contained: do not assume another plugin's tables exist.
  `person_hash` never touches `person_email` even when both are installed.

## Seeing the weave (debugging)

Every step carries `slot` and `source` (`woven` from a plugin, `core`, or
`extra` from the job). Ask for the listing:

```js
await personWorker.getInboundTransforms({ pluginId, describe: true });
```

```
normalize woven  @engine9/interfaces/person:transforms:normalizeFieldNames
id        woven  @engine9/interfaces/person_email:transforms:extractEmailHashes
id        woven  @engine9/interfaces/person_phone:transforms:extractPhoneHashes
id        woven  @engine9/interfaces/person_remote:transforms:extractRemotePersonIds
id        core   person.extractDelegateIdentifiers
assign    core   person.appendInputId
assign    core   person.appendPersonId
assign    core   person.appendEntryTypeId
assign    core   person.validateSourceCodeAscii table=source_code_dictionary
assign    core   person.appendSourceCodeId
upsert    woven  @engine9/interfaces/person:transforms:upsertPerson
upsert    woven  @engine9/interfaces/person_address:transforms:upsertPersonAddress
upsert    woven  @engine9/interfaces/person_email:transforms:upsertPersonEmail
upsert    woven  @engine9/interfaces/person_phone:transforms:upsertPersonPhone
upsert    woven  @engine9/interfaces/person_remote:transforms:upsertPersonRemote
```

CLI: `e9 personworker getInboundTransforms --plugin_id=<id> --describe=true`.
`loadPeople` and `processPeople` also log this at debug level.

Typical questions this answers:

- "Why did nothing land in my table?" — your path is not in the listing: the
  plugin is not installed, or `metadata.inbound` is missing.
- "Why is PII showing up on a PII-free account?" — a plaintext plugin row exists.
  The listing shows it; fix the install, not the pipeline.
- "Which steps ran for this job?" — the listing, plus `extra` lines for anything
  the job added.

## Per-job overrides

Jobs can adjust the woven chain without touching plugins:

- `extraTransforms` (`extra_transforms` on the server) appends steps to a slot:
  `{ afterAll: [{ path: '@engine9/interfaces/timeline:transforms:upsert' }] }`.
  Extras run after the woven steps in that slot. An extra that repeats a woven
  path is dropped, so old configs that spelled out a now-installed plugin still
  run it once.
- `omitTransforms` (`omit_transforms`) removes paths for this job only:
  `['@engine9/interfaces/person_address:transforms:upsertPersonAddress']`.
- `doNotUpsert` (`do_not_upsert`) stops after `assign`: identify people, write
  nothing.

## Guard rails

- Plugin table exists but no installed plugin declares inbound slots → the load
  fails with "No inbound people plugins are installed. Run installStandard".
  Silent skipping would lose data, so this is loud on purpose.
- A known plugin is installed but has no saved spec and the runtime cannot load
  its package (Cloudflare Workers cannot import packages at runtime) → fails with
  "re-run install". Re-running `installStandard` refreshes the snapshots.
- No plugin table at all (unit tests, fresh dev database) → every package the
  runtime can execute is treated as installed. Real accounts always have the
  table.

## Where things live

- Weaver, slots, describe: `core/lib/peoplePipeline/getInboundTransforms.js`
- Snapshot at install: `core/lib/PluginWorker.js` (`installRow`)
- Client transform registry (what a Worker can execute): `core/lib/PersonWorker.js`
- Example declarations: `interfaces/person_email/index.js`, `interfaces/person_hash/index.js`
- Tests: `core/test/inboundWeaver.test.js`
