import { createBatchStallWatcher, resolveBatchStallTimeoutMs } from '../batchStallWatcher.js';
import { runPeopleTransformStep } from './runPeopleTransformStep.js';

/**
 * Run one in-memory batch through the full inbound transform chain sequentially.
 * Used by client PersonWorker.processPeople and loadPeople stream batch processing.
 */
export async function runPeopleBatchPipeline({
  worker,
  batch: inputBatch,
  transformConfigArray,
  resolvedTransforms: resolvedTransformsInput = null,
  pluginId,
  pipeline = {},
  batchIndex,
  batchStallTimeoutMs: batchStallTimeoutMsOpt,
  batchStallWatcher: batchStallWatcherInput = null,
  recordsCompleted = 0,
  onStall,
  onSlowBindings,
  onPhase,
  onStepStart,
  onStepDone
}) {
  let batch = inputBatch.map((o) => ({ ...o }));
  batch.tablesToUpsert = batch.tablesToUpsert || {};
  const batchStallTimeoutMs = resolveBatchStallTimeoutMs({ batch_stall_timeout_ms: batchStallTimeoutMsOpt });
  const ownsStallWatcher = !batchStallWatcherInput;
  const batchStallWatcher =
    batchStallWatcherInput ||
    createBatchStallWatcher({
      timeoutMs: batchStallTimeoutMs,
      onStall:
        onStall ||
        ((context) => {
          throw new Error(`Batch stall in ${context.path} #${context.batchIndex ?? '?'} after ${context.elapsedMs}ms`);
        })
    });
  const executionStats = {};
  const stepIndexes = {};
  let resolvedTransforms = resolvedTransformsInput;
  if (!resolvedTransforms) {
    resolvedTransforms = [];
    for (const transformConfig of transformConfigArray) {
      resolvedTransforms.push(await worker.resolveTransform(transformConfig));
    }
  }
  try {
    for (let i = 0; i < transformConfigArray.length; i++) {
      const transformConfig = transformConfigArray[i];
      const resolvedTransform = resolvedTransforms[i];
      const path = resolvedTransform.path || transformConfig.path || transformConfig;
      stepIndexes[path] = (stepIndexes[path] || 0) + 1;
      const stepBatchIndex = batchIndex ?? stepIndexes[path];
      onStepStart?.({ path, batchIndex: stepBatchIndex, batchSize: batch.length });
      const result = await runPeopleTransformStep({
        worker,
        batch,
        transformConfig,
        resolvedTransform,
        pluginId,
        pipeline,
        batchIndex: stepBatchIndex,
        batchStallWatcher,
        recordsCompleted,
        onPhase: (phase) => onPhase?.({ path, batchIndex: stepBatchIndex, phase }),
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
      onStepDone?.({ path, batchIndex: stepBatchIndex, ...result });
    }
  } finally {
    if (ownsStallWatcher) batchStallWatcher.clearAll?.();
  }
  return { batch, executionStats, batchIndexes: stepIndexes };
}
