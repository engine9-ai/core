/**
 * Run a single inbound transform step on one batch (shared by processPeople and loadPeople).
 */
export async function runPeopleTransformStep({
  worker,
  batch,
  transformConfig,
  resolvedTransform = null,
  pluginId,
  pipeline = {},
  batchIndex,
  batchStallWatcher,
  recordsCompleted = 0,
  onSlowBindings,
  onPhase
}) {
  onPhase?.('resolveTransform');
  const { transform, bindings, options, path } =
    resolvedTransform || (await worker.resolveTransform(transformConfig));
  const stallContext = { path, batch, batchIndex, recordsCompleted };
  const stallPromise = batchStallWatcher?.start?.(stallContext);
  const startedAt = Date.now();
  try {
    batch.tablesToUpsert = batch.tablesToUpsert || {};
    onPhase?.('bindings');
    const bindingsStartedAt = Date.now();
    const { boundItems } = await worker.resolveBindings({
      bindings,
      pipeline,
      tablesToUpsert: batch.tablesToUpsert,
      path,
      batch
    });
    const bindingsDurationMs = Date.now() - bindingsStartedAt;
    if (bindingsDurationMs > 1000 && onSlowBindings) {
      onSlowBindings({ path, batchIndex, bindingsDurationMs });
    }
    onPhase?.('transform');
    const output =
      (await Promise.race([transform({ ...boundItems, batch, options, pluginId }), stallPromise].filter(Boolean))) ||
      {};
    let currentBatch = batch;
    if (output.batch) currentBatch = output.batch;
    return {
      path,
      batch: currentBatch,
      batchDurationMs: Date.now() - startedAt,
      bindingsDurationMs,
      inputRecords: batch.length,
      outputRecords: currentBatch.length
    };
  } finally {
    batchStallWatcher?.clear?.({ path, batchIndex });
  }
}
