import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPeopleBatchPipeline } from '../lib/peoplePipeline/runPeopleBatchPipeline.js';

describe('runPeopleBatchPipeline', () => {
  it('mutates the same record object references (idFiles/loadPeople contract)', async () => {
    const record = { email: 'a@example.com' };
    const inputBatch = [record];
    const worker = {
      resolveTransform: async (transformConfig) => ({
        path: transformConfig.path,
        bindings: {},
        options: {},
        transform: ({ batch }) => {
          batch.forEach((row) => {
            row.person_id = 42;
          });
          return {};
        }
      }),
      resolveBindings: async () => ({ boundItems: {} })
    };

    const { batch } = await runPeopleBatchPipeline({
      worker,
      batch: inputBatch,
      transformConfigArray: [{ path: 'person.appendPersonId' }],
      pluginId: 'test'
    });

    assert.equal(record.person_id, 42, 'caller-held record must receive person_id in place');
    assert.equal(batch[0], record, 'pipeline must keep the original object reference');
    assert.equal(inputBatch[0].person_id, 42);
  });
});
