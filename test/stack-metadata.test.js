import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStackMetadata, DEFAULT_STACK_PATH } from '../lib/stackMetadata.js';
import { getDefaultPluginRegistry } from '../lib/pluginRegistry.js';
import { include as standardInclude } from '@engine9/interfaces/stacks/standard/index.js';

const registry = getDefaultPluginRegistry();

test('loadStackMetadata reads the stack from the plugin registry', async () => {
  const metadata = await loadStackMetadata(DEFAULT_STACK_PATH, { registry });
  assert.deepEqual(metadata.include, standardInclude);
  assert.ok(metadata.include.includes('@engine9/interfaces/person_email'));
  assert.ok(!metadata.include.includes('@engine9/interfaces/person_hash'));
  assert.deepEqual(metadata.exclude, []);
});

test('loadStackMetadata is empty for a plugin that is not in the build', async () => {
  const metadata = await loadStackMetadata('@engine9/interfaces/stacks/not-a-real-stack', { registry });
  assert.deepEqual(metadata.include, []);
  assert.deepEqual(metadata.exclude, []);
});
