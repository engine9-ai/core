import { createBatchStallWatcher, resolveBatchStallTimeoutMs } from '../batchStallWatcher.js';
import { runPeopleTransformStep } from './runPeopleTransformStep.js';

/**
 * Run one in-memory batch through the full inbound transform chain.
 * Used by client PersonWorker.processPeople and as the per-batch engine inside loadPeople streams.
 */
export async function runPeopleBatchPipeline({
  worker,
  batch: inputBatch,
  transformConfigArray,
  pluginId,
  pipeline = {},
  batchStallTimeoutMs: batchStallTimeoutMsOpt,
  onStall,
  onSlowBindings
}) {
  let batch = inputBatch.map((o) => ({ ...o }));
  batch.tablesToUpsert = batch.tablesToUpsert || {};
  const batchStallTimeoutMs = resolveBatchStallTimeoutMs({ batch_stall_timeout_ms: batchStallTimeoutMsOpt });
  const batchStallWatcher = createBatchStallWatcher({
    timeoutMs: batchStallTimeoutMs,
    onStall:
      onStall ||
      ((context) => {
        throw new Error(`Batch stall in ${context.path} #${context.batchIndex ?? '?'} after ${context.elapsedMs}ms`);
      })
  });
  const executionStats = {};
  const batchIndexes = {};
  const resolvedTransforms = [];
  for (const transformConfig of transformConfigArray) {
    resolvedTransforms.push(await worker.resolveTransform(transformConfig));
  }
  try {
    for (let i = 0; i < transformConfigArray.length; i++) {
      const transformConfig = transformConfigArray[i];
      const resolvedTransform = resolvedTransforms[i];
      const path = resolvedTransform.path || transformConfig.path || transformConfig;
      batchIndexes[path] = (batchIndexes[path] || 0) + 1;
      const result = await runPeopleTransformStep({
        worker,
        batch,
        transformConfig,
        resolvedTransform,
        pluginId,
        pipeline,
        batchIndex: batchIndexes[path],
        batchStallWatcher,
        recordsCompleted: pipeline.recordsCompleted ?? 0,
        onSlowBindings
      });
      batch = result.batch;
      batch.tablesToUpsert = batch.tablesToUpsert || {};
      executionStats[result.path] = executionStats[result.path] || {
        time: 0,
        inputRecords: 0,
        outputRecords: 0,
        records: 0
      };
      executionStats[result.path].time += result.batchDurationMs;
      executionStats[result.path].inputRecords += result.inputRecords;
      executionStats[result.path].outputRecords += result.outputRecords;
      executionStats[result.path].records += batch.length;
    }
  } finally {
    batchStallWatcher.clearAll?.();
  }
  return { batch, executionStats, batchIndexes };
}
