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
import { DatabaseSync } from 'node:sqlite';
import esbuild from 'esbuild';
import { buildPlugins } from '../bin/buildPlugins.js';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { getPluginUUID } from '../lib/utilities.js';
import { ensurePluginRow } from './helpers/applySchemas.js';
import { makeLegacyPersonNames } from './helpers/legacyPersonNames.js';

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
  // Resolved from where @engine9/schemas resolves it (a sibling checkout keeps its own node_modules).
  'i18n-iso-countries': createRequire(require.resolve('@engine9/schemas/package.json')).resolve(
    'i18n-iso-countries/index.js'
  )
};

function resolveSelf(specifier, aliases = {}) {
  if (aliases[specifier]) return aliases[specifier];
  if (specifier !== '@engine9/core' && !specifier.startsWith('@engine9/core/')) return null;
  const key = specifier === '@engine9/core' ? '.' : `.${specifier.slice('@engine9/core'.length)}`;
  const exp = packageJson.exports[key];
  if (!exp) return null;
  const target = typeof exp === 'string' ? exp : exp.workerd || exp.worker || exp.import || exp.default;
  if (typeof target !== 'string') return null;
  return path.join(root, target);
}

/** @param {Record<string, string>} aliases extra specifier → absolute file (e.g. the site plugin registry) */
const selfPackage = (aliases = {}) => ({
  name: 'self-package',
  setup(build) {
    build.onResolve({ filter: /^@engine9\/core(\/|$)/ }, (args) => {
      const resolved = resolveSelf(args.path, aliases);
      if (!resolved) return { errors: [{ text: `No export for ${args.path}` }] };
      return { path: resolved };
    });
    for (const [specifier, target] of Object.entries(rootAliases)) {
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: target }));
    }
  }
});

async function bundleWorkerd(entry) {
  const dir = await mkdtemp(path.join(tmpdir(), 'e9-workerd-'));
  const outfile = path.join(dir, 'worker.cjs');
  const shared = {
    absWorkingDir: root,
    nodePaths: [path.join(root, 'node_modules')],
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
    plugins: [selfPackage(entry.aliases)],
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
  // What wrangler's build step produces for a site whose plugins are every schema plugin.
  const siteDir = await mkdtemp(path.join(tmpdir(), 'e9-site-registry-'));
  const registryFile = path.join(siteDir, 'engine9.plugins.js');
  buildPlugins({ cwd: root, packages: ['@engine9/schemas'], out: registryFile });
  const built = await bundleWorkerd({
    aliases: { '@engine9/core/plugins/site': registryFile },
    contents: `
      import PersonWorker from '@engine9/core/PersonWorker';
      import pluginEntries, { packageVersions } from '@engine9/core/plugins/site';
      import { createPluginRegistry, loadRegistrySchema } from '@engine9/core/pluginRegistry';
      export async function run() {
        const plugins = createPluginRegistry(pluginEntries, { packageVersions });
        const worker = new PersonWorker({ accountId: 't', d1: { prepare() { throw new Error('no db'); } }, plugins });
        const person = await worker.compilePlugin({ path: '@engine9/schemas/person' });
        const step = await worker.resolveTransform({ path: '@engine9/schemas/person_email:transforms:extractEmailHashes' });
        const schema = await loadRegistrySchema(plugins, '@engine9/schemas/person_email');
        const errors = {};
        try { await worker.compilePlugin({ path: '@engine9/plugins/e9email' }); } catch (e) { errors.notDeclared = e.code; }
        try { await worker.compilePlugin({ path: '@engine9/schemas/persn' }); } catch (e) { errors.notFound = e.message; }
        return {
          personPath: person.path,
          inbound: person.metadata?.inbound,
          transform: typeof step.transform,
          tables: schema.tables.map((t) => t.name),
          paths: await worker.listAvailable(),
          schemasVersion: await plugins.packageVersion('@engine9/schemas'),
          errors
        };
      }
    `,
    sourcefile: 'registry-entry.js'
  });
  try {
    const mod = await import(built.href);
    const out = await exportOf(mod, 'run')();
    assert.equal(out.personPath, '@engine9/schemas/person');
    assert.ok(out.inbound, 'person declares inbound steps');
    assert.equal(out.transform, 'function');
    assert.ok(out.tables.includes('person_email'));
    assert.ok(out.paths.includes('@engine9/schemas/event'));
    assert.ok(out.schemasVersion, 'baked packageVersions includes @engine9/schemas');
    assert.equal(out.errors.notDeclared, 'PLUGIN_PACKAGE_NOT_DECLARED');
    assert.match(out.errors.notFound, /compiled into this build.*nearby: @engine9\/schemas\/person/);
  } finally {
    await rm(built.dir, { recursive: true, force: true });
    await rm(siteDir, { recursive: true, force: true });
  }
});

/* A D1Database stand-in over a SQLite file: prepare / bind / all / run. */
function sqliteD1(file) {
  const db = new DatabaseSync(file);
  return {
    db,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...values) {
          args = values;
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        }
      };
      return stmt;
    }
  };
}

test('Cloudflare worker: POST /api/admin/upgrade moves person names on D1, then signups write person_name', async () => {
  const siteDir = await mkdtemp(path.join(tmpdir(), 'e9-site-upgrade-'));
  const registryFile = path.join(siteDir, 'engine9.plugins.js');
  const dbFile = path.join(siteDir, 'engine9.db');
  buildPlugins({ cwd: root, packages: ['@engine9/schemas'], out: registryFile });
  const accountId = 'cf-site';
  const pluginId = getPluginUUID(accountId, 'website');
  const setupWorker = new PersonWorker({ accountId, auth: { database_connection: `sqlite://${dbFile}` } });
  let adminKey;
  let publicKey;
  try {
    await makeLegacyPersonNames(setupWorker);
    await ensurePluginRow(setupWorker, { id: pluginId, path: 'website', name: 'Website' });
    const keyStore = new SqlApiKeyStore({ worker: setupWorker });
    await keyStore.deploy();
    adminKey = (await keyStore.create({ name: 'admin', scopes: ['admin'] })).key;
    publicKey = (await keyStore.create({ name: 'public', scopes: ['public'] })).key;
  } finally {
    await setupWorker.destroy();
  }
  const built = await bundleWorkerd({
    aliases: { '@engine9/core/plugins/site': registryFile },
    contents: "export { default } from '@engine9/core/cloudflare/worker';\n",
    sourcefile: 'site-worker.js'
  });
  const d1 = sqliteD1(dbFile);
  try {
    const mod = await import(built.href);
    const fetch = mod.default?.fetch || mod.default?.default?.fetch;
    const env = { DB: d1, E9_ACCOUNT_ID: accountId, E9_PLUGIN_ID: pluginId };
    const call = (route, key, body) =>
      fetch(
        new Request(`https://www.example.test/api${route}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }),
        env
      );

    const before = await call('/people', publicKey, { people: [{ email: 'ada@example.com', given_name: 'Ada', family_name: 'Lovelace' }] });
    assert.equal(before.status, 200, await before.clone().text());
    assert.equal(d1.db.prepare('select given_name from person').get().given_name, 'Ada', 'pre-upgrade signup still lands on person');

    const denied = await call('/admin/upgrade', publicKey, {});
    assert.equal(denied.status, 403);
    const upgraded = await call('/admin/upgrade', adminKey, {});
    const body = await upgraded.json();
    assert.equal(upgraded.status, 200, JSON.stringify(body));
    assert.equal(body.upgrades[0].copied, 1);
    assert.equal(body.upgrades[1].status, 'opt_in');

    const columns = () => d1.db.prepare('pragma table_info(person)').all().map((c) => c.name);
    assert.ok(columns().includes('given_name'), 'the default upgrade keeps the person columns');
    const after = await call('/people', publicKey, { people: [{ email: 'grace@example.com', given_name: 'Grace', family_name: 'Hopper' }] });
    assert.equal(after.status, 200, await after.clone().text());
    const names = d1.db.prepare('select given_name, family_name from person_name order by person_id').all();
    assert.deepEqual(names.map((n) => ({ ...n })), [
      { given_name: 'Ada', family_name: 'Lovelace' },
      { given_name: 'Grace', family_name: 'Hopper' }
    ]);

    const dropped = await (await call('/admin/upgrade', adminKey, { drop_name_columns: true })).json();
    assert.deepEqual(dropped.upgrades[1].dropped, ['person.given_name', 'person.family_name']);
    assert.deepEqual(columns(), ['id', 'created_at', 'modified_at']);
  } finally {
    d1.db.close();
    await rm(built.dir, { recursive: true, force: true });
    await rm(siteDir, { recursive: true, force: true });
  }
});
