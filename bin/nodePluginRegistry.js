/*
  Node plugin registry (`@engine9/core/plugins/node`).

  Plugins are every index.js directory and *.plugin.js file inside the
  packages listed in package.json "engine9":

    pluginPackages         discovered under node_modules when the process
                           starts and imported on first use. Restart after
                           adding or editing a plugin; `npm install` after
                           adding a package.
    dynamicPluginPackages  re-read from disk on every use. A new file is found
                           on the next call; an edited plugin (or a file it
                           imports from its own directory) is imported fresh.
                           Old module instances are never freed, so this is
                           for small, stateless account plugins, not shared
                           interfaces.

  Node only: it reads the filesystem. Cloudflare runtimes get the same
  discovery serialized by `e9core build-plugins` instead.

  Boot validation: every listed package must resolve under node_modules or
  the constructor throws PLUGIN_CONFIG_INVALID naming the package and path.
*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSON5 from 'json5';
import { normalizePluginInstallPath, packageNameOf } from '../lib/pluginPaths.js';
import {
  composePluginRegistries,
  createPluginRegistry,
  getDefaultPluginRegistry,
  setDefaultPluginRegistry
} from '../lib/pluginRegistry.js';
import { SKIP_DIRS, collectPluginEntries, discoverPackagePlugins, packageRoot, readEngine9Config } from './buildPlugins.js';

const VERSION_PARAM = 'e9v';
const STATIC_HINT =
  'Plugins in "engine9.pluginPackages" are read when the process starts; restart after adding one.';

/*
  Carry ?e9v=<version> from a dynamic plugin module to the files it imports
  from inside a dynamic package, so an edited transform.js next to the plugin
  reloads with it. Everything outside those packages stays shared.
*/
const dynamicRoots = new Set();
let hooksInstalled = false;
function installVersionHooks() {
  if (hooksInstalled || typeof registerHooks !== 'function') return;
  hooksInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (!parent || !parent.includes(`${VERSION_PARAM}=`) || !result.url.startsWith('file:')) return result;
      if (result.url.includes(`${VERSION_PARAM}=`)) return result;
      const file = fileURLToPath(result.url);
      if (![...dynamicRoots].some((root) => file.startsWith(root + path.sep))) return result;
      const version = new URL(parent).searchParams.get(VERSION_PARAM);
      return { ...result, url: `${result.url}?${VERSION_PARAM}=${version}` };
    }
  });
}

function withFile(file, fn) {
  return fn().catch((e) => {
    if (e && typeof e === 'object' && !e.file) e.file = file;
    throw e;
  });
}

/** Newest mtime (ms, integer) of any source file in `dir`, recursively. */
function newestMtime(dir) {
  let newest = 0;
  const visit = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (/\.(m?js|json5?)$/.test(ent.name)) {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      }
    }
  };
  visit(dir);
  return Math.floor(newest);
}

/** Static half: `pluginPackages`, walked once. */
function createStaticNodeRegistry({ cwd, packages, name }) {
  const { entries } = collectPluginEntries({ cwd, packages, peerFallback: true });
  const table = {};
  for (const e of entries) {
    const thunk = (file) => () => withFile(file, () => import(pathToFileURL(file).href));
    table[e.identity] = {
      index: thunk(e.files.index),
      ...(e.files.schema ? { schema: thunk(e.files.schema) } : {}),
      ...(e.files.settings ? { settings: thunk(e.files.settings) } : {}),
      ...(e.console ? { console: e.console } : {}),
      resolvedFsEntry: e.files.index
    };
  }
  return createPluginRegistry(table, { name, packages, hint: STATIC_HINT });
}

/** Dynamic half: `dynamicPluginPackages`, resolved on every call. */
function createDynamicNodeRegistry({ cwd, packages, name }) {
  installVersionHooks();
  const roots = new Map(packages.map((p) => [p, fs.realpathSync(packageRoot(cwd, p))]));
  for (const root of roots.values()) dynamicRoots.add(root);
  const cache = new Map();

  function resolve(pluginPath) {
    const identity = normalizePluginInstallPath(pluginPath);
    const pkg = packageNameOf(identity);
    const root = roots.get(pkg);
    if (!root) return null;
    const rest = identity.slice(pkg.length).replace(/^\//, '');
    const abs = path.join(root, rest);
    if (!abs.startsWith(root + path.sep) && abs !== root) return null; // no escaping the package
    const isFile = identity.endsWith('.js');
    if (isFile && !identity.endsWith('.plugin.js')) return null; // a plugin file is *.plugin.js
    return { identity, file: isFile ? abs : path.join(abs, 'index.js'), dir: isFile ? path.dirname(abs) : abs, isFile };
  }

  async function importVersioned(file, version) {
    return withFile(file, () => import(`${pathToFileURL(file).href}?${VERSION_PARAM}=${version}`));
  }

  return {
    name,
    async packages() {
      return [...packages].sort();
    },
    async paths() {
      return packages
        .flatMap((p) => discoverPackagePlugins(cwd, p))
        .map((e) => e.identity)
        .sort();
    },
    async has(pluginPath) {
      const r = resolve(pluginPath);
      return Boolean(r && fs.existsSync(r.file));
    },
    async load(pluginPath) {
      const r = resolve(pluginPath);
      if (!r || !fs.existsSync(r.file)) return null;
      const version = newestMtime(r.dir);
      const hit = cache.get(r.identity);
      if (hit && hit.version === version) return hit.entry;
      const entry = { path: r.identity, index: await importVersioned(r.file, version), resolvedFsEntry: r.file };
      entry.schema = null;
      entry.settings = null;
      entry.console = null;
      if (!r.isFile) {
        const schema = path.join(r.dir, 'schema.js');
        const settings = path.join(r.dir, 'settings.js');
        const consoleFile = path.join(r.dir, 'ui.console.json5');
        if (fs.existsSync(schema)) entry.schema = await importVersioned(schema, version);
        if (fs.existsSync(settings)) entry.settings = await importVersioned(settings, version);
        if (fs.existsSync(consoleFile)) entry.console = JSON5.parse(fs.readFileSync(consoleFile, 'utf8'));
      }
      cache.set(r.identity, { version, entry });
      return entry;
    },
    hint(pluginPath) {
      const r = resolve(pluginPath);
      return r
        ? `Looked for ${r.file}; this package is dynamic, so files are read on every use.`
        : 'This package is dynamic (read on every use); a plugin is a directory with index.js or a *.plugin.js file.';
    }
  };
}

/**
 * The registry for the Node project at `cwd` (its package.json "engine9").
 * Throws PLUGIN_CONFIG_INVALID when a listed package is not installed.
 *
 * @param {{ cwd?: string, name?: string }} [options]
 */
export function createNodePluginRegistry({ cwd = process.cwd(), name = 'node' } = {}) {
  const config = readEngine9Config(cwd);
  // Boot validation: every listed package must be installed. Static packages
  // may also sit next to @engine9/core (peer dependency); dynamic ones may not.
  for (const p of config.pluginPackages) packageRoot(cwd, p, { peerFallback: true });
  for (const p of config.dynamicPluginPackages) packageRoot(cwd, p);
  const statics = createStaticNodeRegistry({
    cwd,
    packages: config.configured && !config.plugins ? config.pluginPackages : undefined,
    name
  });
  if (!config.dynamicPluginPackages.length) return statics;
  const dynamic = createDynamicNodeRegistry({ cwd, packages: config.dynamicPluginPackages, name: `${name}-dynamic` });
  return composePluginRegistries(statics, dynamic);
}

/** Install the Node registry as the process default unless one is already set. */
export function ensureNodePluginRegistry(options) {
  return getDefaultPluginRegistry() || setDefaultPluginRegistry(createNodePluginRegistry(options));
}

/** One line for a boot log. */
export async function describePluginRegistry(registry, { cwd = process.cwd() } = {}) {
  const { pluginPackages, dynamicPluginPackages } = readEngine9Config(cwd);
  const count = (await registry.paths()).length;
  const parts = [`plugins: ${count} from node_modules`];
  if (pluginPackages.length) parts.push(`static: ${pluginPackages.join(', ')}`);
  if (dynamicPluginPackages.length) parts.push(`dynamic: ${dynamicPluginPackages.join(', ')}`);
  return parts.join('; ');
}
