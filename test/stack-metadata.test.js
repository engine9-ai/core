import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadStackMetadata,
  githubStackJsonUrl,
  DEFAULT_STACK_PATH,
  DEFAULT_GITHUB_INTERFACES_BASE
} from '../lib/stackMetadata.js';
import { include as standardInclude } from '@engine9/interfaces/stacks/standard/index.js';

test('loadStackMetadata uses local interfaces package when present', async () => {
  const metadata = await loadStackMetadata(DEFAULT_STACK_PATH, {
    fetch: async () => {
      throw new Error('offline');
    }
  });
  assert.deepEqual(metadata.include, standardInclude);
  assert.ok(metadata.include.includes('@engine9/interfaces/person_email'));
  assert.ok(!metadata.include.includes('@engine9/interfaces/person_hash'));
  assert.deepEqual(metadata.exclude, []);
});

test('loadStackMetadata uses GitHub JSON when the local package is missing', async () => {
  const include = ['@engine9/interfaces/plugin', '@engine9/interfaces/person'];
  const pluginPath = '@engine9/interfaces/stacks/not-a-real-stack';
  const metadata = await loadStackMetadata(pluginPath, {
    githubInterfacesBase: DEFAULT_GITHUB_INTERFACES_BASE,
    fetch: async (url) => {
      assert.equal(url, githubStackJsonUrl(pluginPath));
      return {
        ok: true,
        text: async () => JSON.stringify({ include, exclude: [] })
      };
    }
  });
  assert.deepEqual(metadata.include, include);
});
