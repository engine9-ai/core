import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changedFields,
  createPluginTransformResolver,
  describeBatchChange,
  normalizeTransformStep,
  parseTransformPath,
  prepareTransformChain,
  runTransformChain
} from '../lib/transformChain.js';

const plugin = {
  default: {
    transforms: {
      keepNeighbors: {
        options: { contains: 'Neighbors' },
        transform: ({ batch, options }) => ({
          batch: batch.filter((row) => String(row.form).includes(options.contains))
        })
      },
      upper: ({ batch }) => {
        for (const row of batch) row.name = String(row.name).toUpperCase();
      },
      explode: () => {
        throw new Error('bad row');
      },
      needsLookup: {
        bindings: { people: { path: 'sql.query', options: { table: 'person', lookup: ['email'] } } },
        transform: ({ batch }) => ({ batch })
      },
      queue: {
        bindings: { tablesToUpsert: { path: 'sql.tables.upsert' } },
        transform: ({ batch, tablesToUpsert }) => {
          tablesToUpsert.thing = (tablesToUpsert.thing || []).concat(batch.map((r) => ({ id: r.id })));
        }
      }
    }
  }
};
const PATH = 'accounts/x/thing.plugin.js';
const resolveTransform = createPluginTransformResolver({ [PATH]: plugin });
const rows = () => [
  { id: 1, form: 'Neighbors EN', name: 'ada' },
  { id: 2, form: 'Other', name: 'bob' },
  { id: 3, form: 'Neighbors ES', name: 'cy' }
];

test('a transform path names a plugin and a transform', () => {
  assert.deepEqual(parseTransformPath('@engine9/thing:transforms:normalize'), { pluginPath: '@engine9/thing', name: 'normalize' });
  assert.deepEqual(parseTransformPath(`${PATH}:transforms:upper`), { pluginPath: PATH, name: 'upper' });
  assert.equal(parseTransformPath('person.appendPersonId'), null);
  assert.equal(parseTransformPath(':transforms:x'), null);
  assert.deepEqual(normalizeTransformStep(' a:transforms:b '), { path: 'a:transforms:b', options: {} });
  assert.throws(() => normalizeTransformStep({ options: {} }), /path string/);
});

test('the chain filters and edits rows, with step options over the plugin defaults', async () => {
  const input = rows();
  const { rows: out } = await runTransformChain({
    steps: [`${PATH}:transforms:keepNeighbors`, { path: `${PATH}:transforms:upper` }],
    rows: input,
    resolveTransform
  });
  assert.deepEqual(out.map((r) => [r.id, r.name]), [[1, 'ADA'], [3, 'CY']]);
  const { rows: es } = await runTransformChain({
    steps: [{ path: `${PATH}:transforms:keepNeighbors`, options: { contains: 'ES' } }],
    rows: rows(),
    resolveTransform
  });
  assert.deepEqual(es.map((r) => r.id), [3]);
});

test('a trace says what each step did and leaves the caller\'s rows alone', async () => {
  const input = rows();
  const result = await runTransformChain({
    steps: [`${PATH}:transforms:keepNeighbors`, `${PATH}:transforms:upper`],
    rows: input,
    resolveTransform,
    trace: true
  });
  assert.equal(input[0].name, 'ada');
  assert.deepEqual(result.steps.map((s) => [s.status, s.rows_in, s.rows_out]), [['ok', 3, 2], ['ok', 2, 2]]);
  assert.deepEqual(result.steps[0].changes, [{ index: 1, type: 'removed', record: { id: 2, form: 'Other', name: 'bob' } }]);
  assert.deepEqual(result.steps[1].changes[0], { index: 0, type: 'changed', fields: { name: { from: 'ada', to: 'ADA' } } });
  assert.deepEqual(result.output, {
    row_count: 2,
    rows: [
      { id: 1, form: 'Neighbors EN', name: 'ADA' },
      { id: 3, form: 'Neighbors ES', name: 'CY' }
    ],
    truncated: false
  });
});

test('a traced step that throws stops the chain; untraced, it throws', async () => {
  const steps = [`${PATH}:transforms:upper`, `${PATH}:transforms:explode`, `${PATH}:transforms:keepNeighbors`];
  const result = await runTransformChain({ steps, rows: rows(), resolveTransform, trace: true });
  assert.deepEqual(result.steps.map((s) => s.status), ['ok', 'error', 'skipped']);
  assert.equal(result.steps[1].error.message, 'bad row');
  assert.equal(result.output.row_count, 3);
  assert.equal(result.rows[0].name, 'ADA');
  await assert.rejects(runTransformChain({ steps, rows: rows(), resolveTransform }), /bad row/);
});

test('an unknown plugin or transform is a step error that names what exists', async () => {
  const missing = await runTransformChain({ steps: ['nope.plugin.js:transforms:x'], rows: rows(), resolveTransform, trace: true });
  assert.match(missing.steps[0].error.message, /nope\.plugin\.js is not loaded/);
  const unknown = await runTransformChain({ steps: [`${PATH}:transforms:zzz`], rows: rows(), resolveTransform, trace: true });
  assert.match(unknown.steps[0].error.message, /has no transform zzz \(it has: keepNeighbors, upper/);
});

test('without a bindings resolver a data binding is refused and the upsert queue is reported, not written', async () => {
  const lookup = await runTransformChain({ steps: [`${PATH}:transforms:needsLookup`], rows: rows(), resolveTransform, trace: true });
  assert.equal(lookup.steps[0].status, 'error');
  assert.match(lookup.steps[0].error.message, /needs people \(sql\.query\)/);
  const queued = await runTransformChain({ steps: [`${PATH}:transforms:queue`], rows: rows(), resolveTransform, trace: true });
  assert.deepEqual(queued.steps[0].writes, [
    { binding: 'sql.tables.upsert', table: 'thing', row_count: 3, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }
  ]);
  assert.match(queued.warnings[0], /thing=3/);
});

test('a server passes its own bindings resolver, and a fallback for paths that are not these plugins', async () => {
  const seen = [];
  const resolver = createPluginTransformResolver(
    { [PATH]: plugin },
    { fallback: async (config) => ({ path: config.path, options: {}, bindings: {}, transform: ({ batch }) => ({ batch: batch.slice(0, 1) }) }) }
  );
  const { rows: out } = await runTransformChain({
    steps: [`${PATH}:transforms:needsLookup`, 'person.somethingBuiltIn'],
    rows: rows(),
    resolveTransform: resolver,
    resolveBindings: async ({ bindings, path }) => {
      seen.push([path, Object.keys(bindings)]);
      return { boundItems: { people: [] } };
    }
  });
  assert.equal(out.length, 1);
  assert.deepEqual(seen, [[`${PATH}:transforms:needsLookup`, ['people']]]);
});

test('a prepared chain resolves once and runs batch after batch', async () => {
  let resolves = 0;
  const chain = await prepareTransformChain({
    steps: [`${PATH}:transforms:keepNeighbors`],
    resolveTransform: (step) => {
      resolves += 1;
      return resolveTransform(step);
    }
  });
  assert.equal((await chain.runBatch(rows())).length, 2);
  assert.equal((await chain.runBatch(rows().slice(1, 2))).length, 0);
  assert.equal(resolves, 1);
});

test('rows replaced by new objects are compared by position', () => {
  const before = [{ a: 1 }, { a: 2 }];
  const after = [{ a: 1, b: 'x' }];
  assert.deepEqual(describeBatchChange(before.map((r) => ({ ...r })), before, after), [
    { index: 0, type: 'changed', fields: { b: { from: null, to: 'x' } } },
    { index: 1, type: 'removed', record: { a: 2 } }
  ]);
  assert.deepEqual(changedFields({ a: 1 }, { a: 1 }), {});
});
