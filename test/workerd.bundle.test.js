/*
  Bundle the Worker entry the way workerd sees it: import.meta.url is missing,
  and Node-only packages are aliased. Importing the bundle must not throw.
  astro dev does not catch this — it renders in Node, where import.meta.url exists.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageJson = require(path.join(root, 'package.json'));

const unavailableModule = path.join(root, 'cloudflare/unavailable-module.js');
/*
  Package-root aliases only. Subpaths (checkUnicode.js, langs/en.json) stay on
  the real packages. Keep in sync with cloudflare/README.md and wrangler.toml.example.
*/
const rootAliases = {
  '@engine9/input-tools': path.join(root, 'cloudflare/input-tools-shim.js'),
  knex: unavailableModule,
  mysql2: unavailableModule,
  'mysql2/promise': unavailableModule,
  'better-sqlite3': unavailableModule,
  'i18n-iso-countries': require.resolve('i18n-iso-countries/index.js')
};

function resolveSelf(specifier) {
  if (specifier !== '@engine9/core' && !specifier.startsWith('@engine9/core/')) return null;
  const key = specifier === '@engine9/core' ? '.' : `.${specifier.slice('@engine9/core'.length)}`;
  const exp = packageJson.exports[key];
  if (!exp) return null;
  const target = typeof exp === 'string' ? exp : exp.workerd || exp.worker || exp.import || exp.default;
  if (typeof target !== 'string') return null;
  return path.join(root, target);
}

const selfPackage = {
  name: 'self-package',
  setup(build) {
    build.onResolve({ filter: /^@engine9\/core(\/|$)/ }, (args) => {
      const resolved = resolveSelf(args.path);
      if (!resolved) return { errors: [{ text: `No export for ${args.path}` }] };
      return { path: resolved };
    });
    for (const [specifier, target] of Object.entries(rootAliases)) {
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: target }));
    }
  }
};

async function bundleWorkerd(entry) {
  const dir = await mkdtemp(path.join(tmpdir(), 'e9-workerd-'));
  const outfile = path.join(dir, 'worker.cjs');
  const shared = {
    absWorkingDir: root,
    bundle: true,
    /*
      CJS so Node can evaluate debug's require("tty") inside the bundle.
      workerd provides that builtin; esbuild's ESM shim does not. import.meta.url
      is still rewritten to undefined below, which is the Workers failure mode.
    */
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    outfile,
    splitting: false,
    logLevel: 'silent',
    conditions: ['workerd', 'worker', 'import', 'default'],
    plugins: [selfPackage],
    define: {
      'import.meta.url': 'undefined',
      'import.meta.dirname': 'undefined'
    }
  };
  const result = await esbuild.build(
    entry.contents
      ? {
          ...shared,
          stdin: {
            contents: entry.contents,
            resolveDir: root,
            sourcefile: entry.sourcefile || 'entry.js'
          }
        }
      : { ...shared, entryPoints: [entry] }
  );
  if (result.errors?.length) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(result.errors.map((e) => e.text).join('\n'));
  }
  let source = await readFile(outfile, 'utf8');
  source = source.replaceAll('import.meta.url', 'undefined').replaceAll('import.meta.dirname', 'undefined');
  await writeFile(outfile, source);
  return { dir, href: pathToFileURL(outfile).href };
}

function exportOf(mod, name) {
  if (typeof mod[name] === 'function') return mod[name];
  if (mod.default && typeof mod.default[name] === 'function') return mod.default[name];
  return mod[name] || (mod.default && mod.default[name]);
}

test('Cloudflare worker entry evaluates with no import.meta.url', async () => {
  const built = await bundleWorkerd(path.join(root, 'cloudflare/worker.js'));
  try {
    const mod = await import(built.href);
    const fetch = exportOf(mod, 'fetch') || mod.default?.default?.fetch || mod.default?.fetch;
    assert.equal(typeof fetch, 'function');
    const db = {
      prepare() {
        const stmt = {
          bind() {
            return stmt;
          },
          async all() {
            return { results: [{ ok: 1 }] };
          }
        };
        return stmt;
      }
    };
    const response = await fetch(new Request('https://example.test/api/ok'), { DB: db });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await rm(built.dir, { recursive: true, force: true });
  }
});

test('package entry evaluates with no import.meta.url', async () => {
  const built = await bundleWorkerd({
    contents: "export { createApi, PersonWorker } from '@engine9/core';\n",
    sourcefile: 'barrel-entry.js'
  });
  try {
    const mod = await import(built.href);
    assert.equal(typeof exportOf(mod, 'createApi'), 'function');
    assert.equal(typeof exportOf(mod, 'PersonWorker'), 'function');
  } finally {
    await rm(built.dir, { recursive: true, force: true });
  }
});

test('bundled plugin registry compiles plugins, transforms, and schemas with no filesystem', async () => {
  const built = await bundleWorkerd({
    contents: `
      import PersonWorker from '@engine9/core/PersonWorker';
      import plugins from '@engine9/core/plugins/site';
      import { loadRegistrySchema, asPluginRegistry } from '@engine9/core/pluginRegistry';
      export async function run() {
        const worker = new PersonWorker({ accountId: 't', d1: { prepare() { throw new Error('no db'); } }, plugins });
        const person = await worker.compilePlugin({ path: '@engine9/interfaces/person' });
        const step = await worker.resolveTransform({ path: '@engine9/interfaces/person_email:transforms:extractEmailHashes' });
        const schema = await loadRegistrySchema(asPluginRegistry(plugins), '@engine9/interfaces/person_email');
        const errors = {};
        try { await worker.compilePlugin({ path: '@engine9/plugins/e9email' }); } catch (e) { errors.notInBuild = e.code; }
        try { await worker.compilePlugin({ path: '@engine9/interfaces/person', source: '/tmp/person' }); } catch (e) { errors.source = e.message; }
        return {
          personPath: person.path,
          inbound: person.metadata?.inbound,
          transform: typeof step.transform,
          tables: schema.tables.map((t) => t.name),
          paths: await worker.listAvailable(),
          errors
        };
      }
    `,
    sourcefile: 'registry-entry.js'
  });
  try {
    const mod = await import(built.href);
    const out = await exportOf(mod, 'run')();
    assert.equal(out.personPath, '@engine9/interfaces/person');
    assert.ok(out.inbound, 'person declares inbound steps');
    assert.equal(out.transform, 'function');
    assert.ok(out.tables.includes('person_email'));
    assert.ok(out.paths.includes('@engine9/interfaces/event'));
    assert.equal(out.errors.notInBuild, 'PLUGIN_NOT_IN_BUILD');
    assert.match(out.errors.source, /only runs pre-compiled plugins/);
  } finally {
    await rm(built.dir, { recursive: true, force: true });
  }
});
