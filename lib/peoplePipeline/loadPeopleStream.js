import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import JSON5 from 'json5';
import { v4 as uuidv4 } from 'uuid';
import { createBatchStallWatcher, resolveBatchStallTimeoutMs } from '../batchStallWatcher.js';
import { runPeopleBatchPipeline } from './runPeopleBatchPipeline.js';

function throttleProgress(intervalMs, fn) {
  let lastAt = 0;
  return (...args) => {
    const now = Date.now();
    if (now - lastAt < intervalMs) return;
    lastAt = now;
    fn(...args);
  };
}

function shortTransformPath(path) {
  const parts = String(path).split(':');
  return parts[parts.length - 1] || path;
}

function batchSampleForLog(batch, limit = 2) {
  return batch.slice(0, limit).map((record) => {
    const copy = { ...record };
    delete copy.identifiers;
    return copy;
  });
}

const noop = () => {};

/**
 * Stream-based bulk loadPeople pipeline (Node server). Client processPeople uses
 * runPeopleBatchPipeline on a single in-memory batch instead.
 */
export async function runLoadPeopleStream({
  worker,
  sourceStream,
  transformConfigArray,
  pluginId,
  opts = {},
  hooks = {},
  outputStreams = [],
  pipelineState = {}
}) {
  const {
    batchSize = 300,
    sourceTable,
    batch_stall_timeout_ms: batchStallTimeoutMsOpt,
    batchStallTimeoutMs: batchStallTimeoutMsLegacy
  } = opts;
  const batchStallTimeoutMs = resolveBatchStallTimeoutMs({
    batch_stall_timeout_ms: batchStallTimeoutMsOpt ?? batchStallTimeoutMsLegacy
  });
  const info = hooks.info || noop;
  const debug = hooks.debug || noop;
  const progress = hooks.progress || noop;
  const shouldLogRecordCount = hooks.shouldLogRecordCount || (() => false);

  const compiledPipeline = pipelineState.compiledPipeline || { newStreams: [], promises: [], files: [] };
  const start = Date.now();
  const summary = {
    sourceRecords: 0,
    samples: {},
    records: 0,
    recordsWithPersonIds: 0
  };
  const executionStats = {};
  const batchIndexes = {};
  const inFlight = [];
  let sqlBatchIndex = 0;
  const loadContext = { pluginId, sourceTable, batchSize, stallTimeoutMs: batchStallTimeoutMs };
  const pipelineIdleCheckMs = 15000;
  let lastPipelineActivityAt = Date.now();
  let lastPipelineActivity = { stage: 'init' };

  function formatInFlight() {
    return inFlight.map(({ path, batchIndex, startedAt, phase }) => ({
      path,
      batchIndex,
      phase,
      runningMs: Date.now() - startedAt
    }));
  }

  function formatLoadPeopleProgressMessage() {
    const elapsedMs = Math.max(Date.now() - start, 1);
    const completedRate = summary.records > 0 ? ((1000 * summary.records) / elapsedMs).toFixed(1) : '0';
    const sourceRate = summary.sourceRecords > 0 ? ((1000 * summary.sourceRecords) / elapsedMs).toFixed(1) : '0';
    const active = formatInFlight();
    let stageDetail = lastPipelineActivity.stage;
    if (active.length > 0) {
      stageDetail = active.map((f) => `${shortTransformPath(f.path)}#${f.batchIndex}`).join(', ');
    }
    const table = loadContext.sourceTable ? ` ${loadContext.sourceTable}` : '';
    const pending = Math.max(summary.sourceRecords - summary.records, 0);
    const pendingPart = pending > 0 ? `, ${pending} pending` : '';
    return `loadPeople${table}: ${summary.records} records completed (${completedRate}/s)${pendingPart}, ${summary.sourceRecords} sourced (${sourceRate}/s), sql batches ${sqlBatchIndex}, stage: ${stageDetail}`;
  }

  const reportLoadPeopleProgress = throttleProgress(5000, (sample) => {
    const message = formatLoadPeopleProgressMessage();
    debug(`Progress: ${message}`, sample ? JSON5.stringify(sample) : '');
    progress(message);
  });

  function notePipelineActivity(stage, detail = {}) {
    lastPipelineActivityAt = Date.now();
    lastPipelineActivity = { stage, ...detail };
  }

  const batchStallWatcher = createBatchStallWatcher({
    timeoutMs: batchStallTimeoutMs,
    onStall: ({ path, batch, batchIndex, recordsCompleted, elapsedMs }) => {
      const sample = batchSampleForLog(batch, 10);
      const message = `Batch stall in ${path} #${batchIndex ?? '?'} after ${elapsedMs}ms (${recordsCompleted} records completed, batch size ${batch.length}, stallTimeoutMs ${batchStallTimeoutMs})`;
      const contextJson = JSON5.stringify(loadContext);
      const sampleJson = JSON5.stringify(sample);
      debug(message, contextJson, sampleJson);
      info(message, contextJson, sampleJson);
      throw new Error(`${message} context: ${contextJson} sample: ${sampleJson}`);
    }
  });

  const pipelineIdleTimer = setInterval(() => {
    const idleMs = Date.now() - lastPipelineActivityAt;
    if (idleMs < pipelineIdleCheckMs) return;
    info(
      `loadPeople pipeline idle ${idleMs}ms`,
      `lastActivity=${JSON5.stringify(lastPipelineActivity)}`,
      `inFlight=${JSON5.stringify(formatInFlight())}`,
      `batchIndexes=${JSON5.stringify(batchIndexes)}`,
      `sourceRecords=${summary.sourceRecords}`,
      `sqlBatches=${sqlBatchIndex}`,
      `recordsCompleted=${summary.records}`,
      `stallWatch=${JSON5.stringify(batchStallWatcher.activeKeys?.() || [])}`,
      JSON5.stringify(loadContext)
    );
    progress(`${formatLoadPeopleProgressMessage()} (idle ${Math.round(idleMs / 1000)}s)`);
  }, pipelineIdleCheckMs);

  info('loadPeople transform pipeline', JSON5.stringify(transformConfigArray.map((t) => t.path || t)));
  const resolvedTransforms = [];
  for (const transformConfig of transformConfigArray) {
    resolvedTransforms.push(await worker.resolveTransform(transformConfig));
  }
  notePipelineActivity('pipeline-configured', { transformCount: transformConfigArray.length });
  reportLoadPeopleProgress();
  info(
    'loadPeople starting',
    JSON5.stringify({
      ...loadContext,
      remoteInputId: opts.remoteInputId,
      inputType: opts.inputType ?? opts.input_type
    })
  );

  const transforms = [
    sourceStream,
    new Transform({
      objectMode: true,
      async transform(o, enc, cb) {
        const sourceRecordId = uuidv4();
        summary.sourceRecords += 1;
        const source = structuredClone(o);
        o.sourceRecordId = sourceRecordId;
        this.push(o);
        if (summary.sourceRecords < 4) {
          summary.samples[sourceRecordId] = { source, output: [] };
        }
        if (shouldLogRecordCount(summary.sourceRecords)) {
          info(`loadPeople source record #${summary.sourceRecords}`, JSON5.stringify(loadContext));
          reportLoadPeopleProgress();
        }
        notePipelineActivity('source-record', { sourceRecords: summary.sourceRecords });
        cb();
      }
    }),
    new Transform({
      objectMode: true,
      transform(record, enc, cb) {
        this.buffer = this.buffer || [];
        this.buffer.push(record);
        notePipelineActivity('source-batch-buffer', {
          bufferLen: this.buffer.length,
          sourceRecords: summary.sourceRecords
        });
        if (this.buffer.length >= batchSize) {
          sqlBatchIndex += 1;
          const batch = this.buffer;
          this.buffer = [];
          info(
            `loadPeople sql batch formed #${sqlBatchIndex} size=${batch.length} sourceRecords=${summary.sourceRecords}`,
            JSON5.stringify(loadContext)
          );
          notePipelineActivity('sql-batch-formed', { sqlBatchIndex, batchSize: batch.length });
          reportLoadPeopleProgress();
          this.push(batch);
        }
        cb();
      },
      flush(cb) {
        if (this.buffer?.length > 0) {
          sqlBatchIndex += 1;
          info(
            `loadPeople sql batch formed #${sqlBatchIndex} (flush) size=${this.buffer.length} sourceRecords=${summary.sourceRecords}`,
            JSON5.stringify(loadContext)
          );
          notePipelineActivity('sql-batch-formed', {
            sqlBatchIndex,
            batchSize: this.buffer.length,
            flush: true
          });
          this.push(this.buffer);
          this.buffer = [];
        }
        cb();
      }
    })
  ];

  let pipelineBatchIndex = 0;
  transforms.push(
    new Transform({
      objectMode: true,
      async transform(batch, enc, cb) {
        pipelineBatchIndex += 1;
        const batchIndex = pipelineBatchIndex;
        const batchStartedAt = Date.now();
        const inFlightEntry = {
          path: 'pipeline',
          batchIndex,
          startedAt: batchStartedAt,
          phase: 'start'
        };
        inFlight.push(inFlightEntry);
        const removeInFlight = () => {
          const inFlightIdx = inFlight.indexOf(inFlightEntry);
          if (inFlightIdx >= 0) inFlight.splice(inFlightIdx, 1);
        };
        notePipelineActivity('batch-start', { path: 'pipeline', batchIndex });
        info(
          `loadPeople pipeline batch start #${batchIndex} size=${batch.length} recordsCompleted=${summary.records} stallTimeoutMs=${batchStallTimeoutMs}`,
          JSON5.stringify(loadContext),
          JSON5.stringify(batchSampleForLog(batch))
        );
        try {
          const result = await runPeopleBatchPipeline({
            worker,
            batch,
            transformConfigArray,
            resolvedTransforms,
            pluginId,
            pipeline: compiledPipeline,
            batchIndex,
            batchStallTimeoutMs: batchStallTimeoutMs,
            batchStallWatcher,
            recordsCompleted: summary.records,
            onStall: ({ path, batch, batchIndex: idx, recordsCompleted, elapsedMs }) => {
              const sample = batchSampleForLog(batch, 10);
              const message = `Batch stall in ${path} #${idx ?? '?'} after ${elapsedMs}ms (${recordsCompleted} records completed, batch size ${batch.length}, stallTimeoutMs ${batchStallTimeoutMs})`;
              const contextJson = JSON5.stringify(loadContext);
              const sampleJson = JSON5.stringify(sample);
              debug(message, contextJson, sampleJson);
              info(message, contextJson, sampleJson);
              throw new Error(`${message} context: ${contextJson} sample: ${sampleJson}`);
            },
            onPhase: ({ path, phase }) => {
              inFlightEntry.path = path;
              inFlightEntry.phase = phase;
            },
            onStepStart: ({ path, batchIndex: idx, batchSize }) => {
              batchIndexes[path] = idx;
              info(
                `loadPeople batch start ${path} #${idx} size=${batchSize} recordsCompleted=${summary.records}`,
                JSON5.stringify(loadContext)
              );
            },
            onStepDone: ({ path, batchIndex: idx, batchDurationMs, inputRecords, outputRecords }) => {
              executionStats[path] = executionStats[path] || {
                time: 0,
                inputRecords: 0,
                outputRecords: 0
              };
              executionStats[path].time += batchDurationMs;
              executionStats[path].inputRecords += inputRecords;
              executionStats[path].outputRecords += outputRecords;
              info(
                `loadPeople batch done ${path} #${idx} durationMs=${batchDurationMs} in=${inputRecords} out=${outputRecords} recordsCompleted=${summary.records}`,
                JSON5.stringify(loadContext)
              );
            },
            onSlowBindings: ({ path, batchIndex: idx, bindingsDurationMs, phase }) => {
              info(
                `loadPeople slow ${phase || 'bindings'} ${path} #${idx} durationMs=${bindingsDurationMs}`,
                JSON5.stringify(loadContext)
              );
            }
          });
          const batchDurationMs = Date.now() - batchStartedAt;
          notePipelineActivity('batch-done', { path: 'pipeline', batchIndex, batchDurationMs });
          reportLoadPeopleProgress();
          inFlightEntry.phase = 'push';
          const pushed = this.push(result.batch);
          if (pushed) {
            removeInFlight();
            cb();
          } else {
            info(
              `loadPeople backpressure pipeline #${batchIndex} waiting for drain`,
              `inFlight=${JSON5.stringify(formatInFlight())}`,
              JSON5.stringify(loadContext)
            );
            notePipelineActivity('backpressure', { path: 'pipeline', batchIndex });
            inFlightEntry.phase = 'backpressure';
            this.once('drain', () => {
              removeInFlight();
              cb();
            });
          }
        } catch (e) {
          removeInFlight();
          return cb(e);
        }
      }
    })
  );

  transforms.push(
    new Transform({
      objectMode: true,
      async transform(batch, enc, cb) {
        summary.records += batch.length;
        summary.recordsWithPersonIds += batch.filter((o) => o.person_id).length;
        reportLoadPeopleProgress(batch.slice(0, 2));
        batch.forEach((o) => {
          const id = o.sourceRecordId;
          delete o.sourceRecordId;
          if (summary.samples[id]) {
            summary.samples[id].output.push(o);
          }
          delete o.identifiers;
          this.push(o);
        });
        cb();
      }
    })
  );

  if (outputStreams.length > 0) {
    transforms.push(...outputStreams);
  } else {
    transforms.push(
      new Writable({
        objectMode: true,
        write(o, enc, cb) {
          cb();
        }
      })
    );
  }

  try {
    await pipeline(transforms);
  } finally {
    clearInterval(pipelineIdleTimer);
    batchStallWatcher.clearAll?.();
    progress(`${formatLoadPeopleProgressMessage()} (complete)`);
    (compiledPipeline.newStreams || []).forEach((s) => s.push(null));
    await Promise.all(compiledPipeline.promises || []);
    summary.files = compiledPipeline.files || [];
    summary.executionStats = executionStats;
    summary.pluginId = pluginId;
    summary.samples = Object.values(summary.samples);
  }

  return summary;
}
