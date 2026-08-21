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
    assert.ok(
      liveMessages.every((m) => !m.includes('stage: pipeline-configured')),
      `expected no pipeline-configured zeros snapshot, got: ${JSON.stringify(liveMessages)}`
    );
  });

  it('includes records_offset in progress so idFiles batches do not reset to zero', async () => {
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
      Array.from({ length: 200 }, (_, i) => ({ id: i })),
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
      transformConfigArray: [{ path: 'sql.tables.upsert' }],
      pluginId: 'test-plugin',
      opts: {
        batchSize: 200,
        batch_stall_timeout_ms: 0,
        progress_heartbeat_ms: 30,
        records_offset: 300,
        progress_started_at: Date.now() - 1000
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
      liveMessages.some((m) => m.includes('300 records completed') && m.includes('500 sourced')),
      `expected offset progress (300 completed / 500 sourced) during upsert, got: ${JSON.stringify(liveMessages)}`
    );
    assert.ok(
      liveMessages.every((m) => !/^loadPeople: 0 records completed/.test(m)),
      `expected no reset to zero records completed, got: ${JSON.stringify(liveMessages)}`
    );
    assert.ok(
      liveMessages.some((m) => {
        const match = String(m).match(/300 records completed \(([0-9.]+)\/s\)/);
        return match && Number(match[1]) > 0;
      }),
      `expected a non-zero completed rate across parquet batches, got: ${JSON.stringify(liveMessages)}`
    );
    const complete = progressMessages.find((m) => String(m).includes('(complete)'));
    assert.match(String(complete), /500 records completed/);
  });

  it('keeps job-level records/s at a new parquet batch instead of 0/s and 100000/s', async () => {
    const progressMessages = [];
    let pushed = 0;
    const sourceStream = new Readable({
      objectMode: true,
      read() {
        while (pushed < 100) {
          const ok = this.push({ id: pushed });
          pushed += 1;
          if (!ok) return;
        }
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

    const jobStartedAt = Date.now() - 60_000;
    const run = runLoadPeopleStream({
      worker,
      sourceStream,
      transformConfigArray: [{ path: 'test.identity' }],
      pluginId: 'test-plugin',
      opts: {
        batchSize: 300,
        batch_stall_timeout_ms: 0,
        progress_heartbeat_ms: 30,
        records_offset: 6_066_000,
        progress_started_at: jobStartedAt
      },
      hooks: {
        progress: (message) => progressMessages.push(message)
      }
    });

    try {
      const deadline = Date.now() + 500;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = progressMessages.find(
          (m) => String(m).includes('6066000 records completed') && !String(m).includes('(complete)')
        );
        if (snapshot) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(snapshot, `expected offset completed count, got: ${JSON.stringify(progressMessages)}`);
      assert.match(String(snapshot), /100 pending/);
      assert.match(String(snapshot), /6066100 sourced/);
      assert.match(String(snapshot), /stage: source-(record|batch-buffer)/);

      const completedRate = Number(String(snapshot).match(/6066000 records completed \(([0-9.]+)\/s\)/)?.[1]);
      const sourceRate = Number(String(snapshot).match(/6066100 sourced \(([0-9.]+)\/s\)/)?.[1]);
      assert.ok(
        completedRate > 1000 && completedRate < 500_000,
        `expected job-level completed rate, got ${completedRate} from ${snapshot}`
      );
      assert.ok(
        sourceRate > 1000 && sourceRate < 500_000 && sourceRate !== 100000,
        `expected job-level source rate (not 0 or 100000.0 from a 1ms clamp), got ${sourceRate} from ${snapshot}`
      );
    } finally {
      sourceStream.push(null);
      await run;
    }
  });
});
