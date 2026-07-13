import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchStallWatcher } from '../lib/batchStallWatcher.js';
import { runPeopleTransformStep } from '../lib/peoplePipeline/runPeopleTransformStep.js';

describe('runPeopleTransformStep', () => {
  it('completes sync transforms that return undefined instead of waiting on stallPromise', async () => {
    const phases = [];
    const watcher = createBatchStallWatcher({
      timeoutMs: 200,
      onStall: () => {
        throw new Error('should not stall for sync undefined transform');
      }
    });
    const worker = {
      resolveTransform: async () => ({
        path: 'person.appendEntryTypeId',
        bindings: {},
        options: {},
        transform: () => undefined
      }),
      resolveBindings: async () => ({ boundItems: {} })
    };
    const batch = [{ person_id: 1 }];

    const result = await runPeopleTransformStep({
      worker,
      batch,
      transformConfig: { path: 'person.appendEntryTypeId' },
      pluginId: 'test',
      batchIndex: 1,
      batchStallWatcher: watcher,
      onPhase: (phase) => phases.push(phase)
    });

    assert.equal(result.path, 'person.appendEntryTypeId');
    assert.equal(result.outputRecords, 1);
    assert.deepEqual(phases, ['resolveTransform', 'bindings', 'transform']);
  });

  it('still rejects when an async transform exceeds the stall timeout', async () => {
    const watcher = createBatchStallWatcher({
      timeoutMs: 30,
      onStall: ({ path }) => {
        throw new Error(`stalled in ${path}`);
      }
    });
    const worker = {
      resolveTransform: async () => ({
        path: 'person.appendPersonId',
        bindings: {},
        options: {},
        transform: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {};
        }
      }),
      resolveBindings: async () => ({ boundItems: {} })
    };

    await assert.rejects(
      runPeopleTransformStep({
        worker,
        batch: [{ person_id: 1 }],
        transformConfig: { path: 'person.appendPersonId' },
        pluginId: 'test',
        batchIndex: 1,
        batchStallWatcher: watcher
      }),
      /stalled in person\.appendPersonId/
    );
  });
});
