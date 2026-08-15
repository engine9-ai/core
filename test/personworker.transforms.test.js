import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';

test('getInboundTransforms paths resolve through resolveTransform (including delegate)', async () => {
  const worker = new PersonWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    const transforms = await worker.getInboundTransforms({ pluginId: 'test-plugin' });
    assert.ok(
      transforms.some((t) => t.path === 'person.extractDelegateIdentifiers'),
      'core chain includes extractDelegateIdentifiers'
    );
    for (const config of transforms) {
      const resolved = await worker.resolveTransform(config);
      assert.equal(typeof resolved.transform, 'function', `failed to resolve ${config.path}`);
    }
  } finally {
    await worker.destroy();
  }
});
