import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  runLoadPeopleStream,
  VERBOSE_PEOPLE_BATCH_LOG_RECORDS
} from '../lib/peoplePipeline/loadPeopleStream.js';

function identityWorker() {
  return {
    resolveTransform: async (transformConfig) => ({
      path: transformConfig.path || transformConfig,
      bindings: {},
      options: {},
      transform: ({ batch }) => ({ batch })
    }),
    resolveBindings: async () => ({ boundItems: {} })
  };
}

function collectInfo(runOpts) {
  const infoMessages = [];
  return {
    infoMessages,
    run: () =>
      runLoadPeopleStream({
        worker: identityWorker(),
        transformConfigArray: [{ path: 'test.one' }, { path: 'test.two' }],
        pluginId: 'test-plugin',
        hooks: {
          info: (message) => infoMessages.push(String(message))
        },
        ...runOpts
      })
  };
}

describe('runLoadPeopleStream batch info logging', () => {
  it('logs per-step start/done for the first few thousand records, then only batch sizes', async () => {
    const batchSize = 300;
    const total = VERBOSE_PEOPLE_BATCH_LOG_RECORDS + batchSize * 2;
    const verboseBatches = VERBOSE_PEOPLE_BATCH_LOG_RECORDS / batchSize;
    const totalBatches = total / batchSize;
    const { infoMessages, run } = collectInfo({
      sourceStream: Readable.from(
        Array.from({ length: total }, (_, i) => ({ id: i })),
        { objectMode: true }
      ),
      opts: { batchSize, batch_stall_timeout_ms: 0, progress_heartbeat_ms: 0 }
    });

    await run();

    const stepLogs = infoMessages.filter(
      (m) => m.startsWith('loadPeople batch start ') || m.startsWith('loadPeople batch done ')
    );
    const pipelineStarts = infoMessages.filter((m) => m.startsWith('loadPeople pipeline batch start'));
    const sqlBatches = infoMessages.filter((m) => m.startsWith('loadPeople sql batch formed'));

    assert.equal(sqlBatches.length, totalBatches);
    assert.equal(pipelineStarts.length, verboseBatches);
    // 2 transforms × start+done × verbose batches
    assert.equal(stepLogs.length, verboseBatches * 2 * 2);
    assert.ok(
      sqlBatches.slice(verboseBatches).every((m) => /size=\d+/.test(m)),
      `quiet sql batch logs should include size, got: ${JSON.stringify(sqlBatches.slice(verboseBatches))}`
    );
    assert.ok(
      stepLogs.every((m) => {
        const match = m.match(/#(\d+)/);
        return match && Number(match[1]) <= verboseBatches;
      }),
      'per-step logs should stop after the verbose window'
    );
  });

  it('skips per-step logs when records_offset is already past the verbose window', async () => {
    const { infoMessages, run } = collectInfo({
      sourceStream: Readable.from(
        Array.from({ length: 300 }, (_, i) => ({ id: i })),
        { objectMode: true }
      ),
      opts: {
        batchSize: 300,
        batch_stall_timeout_ms: 0,
        progress_heartbeat_ms: 0,
        records_offset: VERBOSE_PEOPLE_BATCH_LOG_RECORDS
      }
    });

    await run();

    assert.equal(
      infoMessages.filter((m) => m.startsWith('loadPeople batch start ') || m.startsWith('loadPeople batch done '))
        .length,
      0
    );
    assert.equal(infoMessages.filter((m) => m.startsWith('loadPeople pipeline batch start')).length, 0);
    assert.ok(infoMessages.some((m) => m.startsWith('loadPeople sql batch formed') && m.includes('size=300')));
  });
});
