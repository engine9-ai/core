# Transform chain runner

`@engine9/core/transformChain` (`lib/transformChain.js`) runs a batch of rows
through an ordered list of row transforms, in memory. It imports nothing, so
the same file runs in a server worker and in a browser.

## Transforms

A transform is named by path, `<plugin file>:transforms:<name>`, and
defined in a plugin module:

```js
export default {
  transforms: {
    mapRow: {
      description: 'What it does',
      options: { /* defaults, merged under the step's options */ },
      bindings: { /* optional: name -> { path, options } */ },
      transform({ batch, options, pluginId, inputId /*, ...bound items */ }) {
        return { batch: batch.filter(keep).map(toDestination) };
      },
    },
  },
};
```

It returns `{ batch }` (a new array; fewer rows filters) or nothing (it
changed `batch` in place). A step is a path string or `{ path, options }`.

## API

- `runTransformChain({ steps, rows, resolveTransform, resolveBindings?, pluginId?, inputId?, trace?, limit? })`
  → `{ rows, steps, output: { row_count, rows, truncated }, warnings }`.
  With `trace: true`, each step reports rows in and out, changed fields,
  queued writes, console output and time; a step that throws stops the chain
  (`status: 'error'`, later steps `skipped`) and the output is the batch
  before it. `limit` caps the rows reported (default 20); `rows` is all of
  them.
- `prepareTransformChain({ steps, resolveTransform, resolveBindings?, ... })`
  → `{ steps, runBatch(batch), tablesToUpsert }`, for running batch after
  batch of a file.
- `createPluginTransformResolver(plugins, { fallback })`: a
  `resolveTransform` over plugin modules already loaded, keyed by plugin path.
- `parseTransformPath`, `normalizeTransformStep`.

## Bindings

The host supplies `resolveBindings`. Without one, only `sql.tables.upsert`
binds: rows are queued in memory and reported as writes, never written. Any
other binding throws, saying the transform needs account data and cannot be
bound there.

## Who uses it

- The engine9 server's `InputWorker.transform` task (a file or inline rows
  in, one file out), with its own `resolveTransform` / `resolveBindings`.
- Conductor's local runs: the server serves this file
  (`GET /conductor/transform-chain.js`) and Conductor runs it in a sandboxed
  worker on sample rows, with plugin files from a folder on the person's
  machine. No server accepts transform code: code reaches servers only
  through the reviewed repository they pull from.
