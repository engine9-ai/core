import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runLoadPeopleStream } from '../lib/peoplePipeline/loadPeopleStream.js';

describe('runLoadPeopleStream idle stall', () => {
  it('fails when a partial batch is pending and the source never ends', async () => {
    // Emits one full batch + a partial, then hangs without ending — the failure
    // mode behind "stage: batch-done" with pending > 0 and inFlight=[].
    let pushed = 0;
    const totalToPush = 350; // batchSize 300 + 50 pending
    const sourceStream = new Readable({
      objectMode: true,
      read() {
        while (pushed < totalToPush) {
          const ok = this.push({ id: pushed });
          pushed += 1;
          if (!ok) return;
        }
        // Intentionally do not push(null) — source stalls open.
      }
    });

    const worker = {
      resolveTransform: async (transformConfig) => ({
        path: transformConfig.path || transformConfig,
        bindings: {},
        options: {},
        transform: ({ batch }) => ({ batch })
      }),
      resolveBindings: async () => ({ boundItems: {} })
    };

    await assert.rejects(
      () =>
        runLoadPeopleStream({
          worker,
          sourceStream,
          transformConfigArray: [{ path: 'test.identity' }],
          pluginId: 'test-plugin',
          opts: { batchSize: 300, batch_stall_timeout_ms: 80 }
        }),
      (err) => {
        assert.match(String(err?.message || err), /idle stall/i);
        assert.match(String(err?.message || err), /pending/i);
        return true;
      }
    );
  });

  it('heartbeats progress during a long transform step instead of staying at pipeline-configured zeros', async () => {
    const progressMessages = [];
    let releaseTransform;
    const transformStarted = new Promise((resolve) => {
      releaseTransform = resolve;
    });
    let holdTransform;
    const transformGate = new Promise((resolve) => {
      holdTransform = resolve;
    });

    const sourceStream = Readable.from(
      Array.from({ length: 300 }, (_, i) => ({ id: i })),
      { objectMode: true }
    );

    const worker = {
      resolveTransform: async (transformConfig) => ({
        path: transformConfig.path || transformConfig,
        bindings: {},
        options: {},
        transform: async ({ batch }) => {
          releaseTransform();
          await transformGate;
          return { batch };
        }
      }),
      resolveBindings: async () => ({ boundItems: {} })
    };

    const run = runLoadPeopleStream({
      worker,
      sourceStream,
      transformConfigArray: [{ path: 'test.slow' }],
      pluginId: 'test-plugin',
      opts: {
        batchSize: 300,
        batch_stall_timeout_ms: 0,
        progress_heartbeat_ms: 30
      },
      hooks: {
        progress: (message) => progressMessages.push(message)
      }
    });

    await transformStarted;
    await new Promise((resolve) => setTimeout(resolve, 80));
    holdTransform();
    await run;

    const liveMessages = progressMessages.filter((m) => !String(m).includes('(complete)'));
    assert.ok(
      liveMessages.some((m) => m.includes('slow#')),
      `expected in-flight progress to name the current step, got: ${JSON.stringify(liveMessages)}`
    );
    assert.ok(
      liveMessages.some((m) => /sql batches [1-9]/.test(m)),
      `expected progress to report formed sql batches, got: ${JSON.stringify(liveMessages)}`
    );
  });
});
