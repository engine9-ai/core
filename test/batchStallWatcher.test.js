import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchStallWatcher, resolveBatchStallTimeoutMs } from '../lib/batchStallWatcher.js';

describe('batchStallWatcher', () => {
  let originalTimeout;

  beforeEach(() => {
    originalTimeout = process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS;
    delete process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS;
    } else {
      process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS = originalTimeout;
    }
  });

  it('resolveBatchStallTimeoutMs prefers explicit options', () => {
    assert.equal(resolveBatchStallTimeoutMs({ batch_stall_timeout_ms: 45000 }), 45000);
    assert.equal(resolveBatchStallTimeoutMs({ batchStallTimeoutMs: '90000' }), 90000);
  });

  it('resolveBatchStallTimeoutMs falls back to env then default', () => {
    process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS = '15000';
    assert.equal(resolveBatchStallTimeoutMs({}), 15000);
    delete process.env.ENGINE9_BATCH_STALL_TIMEOUT_MS;
    assert.equal(resolveBatchStallTimeoutMs({}), 60000);
  });

  it('rejects stalled batches after the timeout window', async () => {
    const stalls = [];
    const watcher = createBatchStallWatcher({
      timeoutMs: 25,
      onStall: (context) => {
        stalls.push(context);
        throw new Error(`stalled in ${context.path}`);
      }
    });

    const stallPromise = watcher.start({
      path: 'person.appendPersonId',
      batchIndex: 1,
      batch: [{ person_id: 1 }, { person_id: 2 }],
      recordsCompleted: 140700
    });

    await assert.rejects(stallPromise, /stalled in person\.appendPersonId/);
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].recordsCompleted, 140700);
    assert.equal(stalls[0].batch.length, 2);
    assert.ok(stalls[0].elapsedMs >= 25);
  });

  it('does not reject when the batch completes in time', async () => {
    const stalls = [];
    const watcher = createBatchStallWatcher({
      timeoutMs: 50,
      onStall: (context) => stalls.push(context)
    });

    watcher.start({
      path: 'sql.tables.upsert',
      batchIndex: 1,
      batch: [{ person_id: 3 }],
      recordsCompleted: 10
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    watcher.clear({ path: 'sql.tables.upsert', batchIndex: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(stalls.length, 0);
  });

  it('tracks each in-flight batch independently', async () => {
    const stalls = [];
    const watcher = createBatchStallWatcher({
      timeoutMs: 40,
      onStall: (context) => {
        stalls.push(context);
        throw new Error(`stalled in ${context.path}`);
      }
    });

    const first = watcher.start({
      path: 'person.appendEntryTypeId',
      batchIndex: 1,
      batch: [{ person_id: 1 }],
      recordsCompleted: 0
    });
    const second = watcher.start({
      path: 'person.appendPersonId',
      batchIndex: 32,
      batch: [{ person_id: 2 }],
      recordsCompleted: 0
    });

    await assert.rejects(first, /stalled in person\.appendEntryTypeId/);
    await assert.rejects(second, /stalled in person\.appendPersonId/);
    assert.equal(stalls.length, 2);
    assert.equal(stalls[0].path, 'person.appendEntryTypeId');
    assert.equal(stalls[0].batchIndex, 1);
  });
});
