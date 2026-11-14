import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginIncludes, expandPluginIncludes } from '../lib/pluginIncludes.js';
import { getDefaultPluginRegistry } from '../lib/pluginRegistry.js';
import { include as contactInclude } from '@engine9/schemas/editions/contact/index.js';

const registry = getDefaultPluginRegistry();
const CONTACT_EDITION = '@engine9/schemas/editions/contact';

test('loadPluginIncludes reads a plugin\'s include list from the plugin registry', async () => {
  const metadata = await loadPluginIncludes(CONTACT_EDITION, { registry });
  assert.deepEqual(metadata.include, contactInclude);
  assert.ok(metadata.include.includes('@engine9/schemas/person_email'));
  assert.ok(!metadata.include.includes('@engine9/schemas/person_hash'));
  assert.deepEqual(metadata.exclude, []);
});

test('loadPluginIncludes is empty for a plugin without lists, or not in the build', async () => {
  for (const path of ['@engine9/schemas/person', '@engine9/schemas/editions/not-a-real-edition']) {
    const metadata = await loadPluginIncludes(path, { registry });
    assert.deepEqual(metadata.include, []);
    assert.deepEqual(metadata.exclude, []);
  }
});

test('expandPluginIncludes follows include lists depth first, once each', async () => {
  const lists = { a: ['b', 'c'], b: ['c', 'd'], c: [], d: ['a'] };
  const all = await expandPluginIncludes('a', async (p) => ({ include: lists[p] || [] }));
  assert.deepEqual([...all], ['a', 'b', 'c', 'd']);
  const contact = await expandPluginIncludes(CONTACT_EDITION, (p) => loadPluginIncludes(p, { registry }));
  assert.deepEqual([...contact], [CONTACT_EDITION, ...contactInclude]);
});
