/*
  Plugin registry.

  Plugins are every `index.js` directory and `*.plugin.js` file inside the
  packages listed in package.json `engine9.pluginPackages`. How they are
  loaded depends on the runtime:

    Cloudflare  compiled into the bundle at deploy (wrangler runs
                `e9core build-plugins`, which writes a module of literal
                imports; this file never touches the filesystem).
    Node        imported from node_modules when the process starts
                (@engine9/core/plugins/node). Packages listed in
                `engine9.dynamicPluginPackages` are re-read from disk on
                every use instead. Node only.

  This module has no filesystem dependency, so it runs on workerd. It defines
  the registry interface, the error codes, and the static registry that a
  generated module (or any entries object) plugs into.

  Registry shape (all methods async unless noted):
    name              label for error messages
    packages()        npm packages this registry answers for
    paths()           plugin identities available right now
    has(path)         whether a plugin is available
    load(path)        { path, index, schema, settings, console } or null
    hint(path)        (sync) one sentence on why a path might be missing

  Error codes (PluginLoadError.code):
    PLUGIN_CONFIG_INVALID        package.json lists a package that is not installed,
                                 lists it twice, or no registry is configured
    PLUGIN_PACKAGE_NOT_DECLARED  the path's package is not in any list
    PLUGIN_NOT_FOUND             package declared, no such plugin
    PLUGIN_IMPORT_FAILED         plugin found, importing it threw (see .cause)
*/
import { normalizePluginInstallPath, packageNameOf } from './pluginPaths.js';

const PLUGIN_CONFIG_INVALID = 'PLUGIN_CONFIG_INVALID';
const PLUGIN_PACKAGE_NOT_DECLARED = 'PLUGIN_PACKAGE_NOT_DECLARED';
const PLUGIN_NOT_FOUND = 'PLUGIN_NOT_FOUND';
const PLUGIN_IMPORT_FAILED = 'PLUGIN_IMPORT_FAILED';

class PluginLoadError extends Error {
  constructor(code, message, { pluginPath, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PluginLoadError';
    this.code = code;
    if (pluginPath) this.pluginPath = pluginPath;
  }
}

const CONFIG_KEYS = '"engine9.pluginPackages" or "engine9.dynamicPluginPackages"';

async function readPart(entry, key) {
  const value = entry?.[key];
  if (value == null) return null;
  return typeof value === 'function' ? value() : value;
}

/** Up to `limit` identities in the same package, closest first. */
function nearestIdentities(pluginPath, candidates, limit = 5) {
  const want = pluginPath.toLowerCase();
  const wantLast = want.split('/').pop();
  const score = (p) => {
    const have = p.toLowerCase();
    let common = 0;
    while (common < want.length && common < have.length && want[common] === have[common]) common += 1;
    return common + (have.includes(wantLast) ? want.length : 0);
  };
  return [...candidates]
    .map((p) => [score(p), p])
    .sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, p]) => p);
}

/**
 * Static registry over a fixed entries object: identity → { index, schema,
 * settings, console }, each a value or a thunk returning one. The module
 * `e9core build-plugins` writes exports exactly this shape.
 *
 * @param {Record<string, object>} entries
 * @param {{ name?: string, packages?: string[], hint?: string }} [opts]
 *   packages defaults to the packages the identities belong to.
 */
function createPluginRegistry(entries = {}, { name = 'build', packages, hint } = {}) {
  const table = new Map();
  for (const [key, entry] of Object.entries(entries || {})) {
    table.set(normalizePluginInstallPath(key), entry);
  }
  const declared = [...new Set(packages || [...table.keys()].map(packageNameOf))].sort();
  const missingHint =
    hint || 'Plugins are compiled into this build when it is deployed. Add the plugin and redeploy.';
  const loaded = new Map();
  return {
    name,
    async packages() {
      return declared;
    },
    async paths() {
      return [...table.keys()].sort();
    },
    async has(pluginPath) {
      return table.has(normalizePluginInstallPath(pluginPath));
    },
    async load(pluginPath) {
      const key = normalizePluginInstallPath(pluginPath);
      const entry = table.get(key);
      if (!entry) return null;
      if (!loaded.has(key)) {
        const pending = (async () => ({
          path: key,
          index: await readPart(entry, 'index'),
          schema: await readPart(entry, 'schema'),
          settings: await readPart(entry, 'settings'),
          console: await readPart(entry, 'console'),
          ...(entry.resolvedFsEntry ? { resolvedFsEntry: entry.resolvedFsEntry } : {})
        }))();
        pending.catch(() => loaded.delete(key));
        loaded.set(key, pending);
      }
      return loaded.get(key);
    },
    hint() {
      return missingHint;
    }
  };
}

function isPluginRegistry(value) {
  return Boolean(value) && typeof value.load === 'function' && typeof value.paths === 'function';
}

const wrapped = new WeakMap();
/** Accept a registry or the plain entries object a generated module exports. */
function asPluginRegistry(value) {
  if (!value) return null;
  if (isPluginRegistry(value)) return value;
  if (typeof value !== 'object') throw new Error('plugins must be a plugin registry or an entries object');
  if (!wrapped.has(value)) wrapped.set(value, createPluginRegistry(value));
  return wrapped.get(value);
}

/** One registry over several. The first registry that has a plugin wins. */
function composePluginRegistries(...registries) {
  const list = registries.map(asPluginRegistry).filter(Boolean);
  const ownerOf = async (pluginPath) => {
    const pkg = packageNameOf(pluginPath);
    for (const r of list) {
      if (((await r.packages?.()) || []).includes(pkg)) return r;
    }
    return null;
  };
  return {
    name: list.map((r) => r.name).join('+'),
    async packages() {
      const all = await Promise.all(list.map((r) => r.packages?.() || []));
      return [...new Set(all.flat())].sort();
    },
    async paths() {
      const all = await Promise.all(list.map((r) => r.paths()));
      return [...new Set(all.flat())].sort();
    },
    async has(pluginPath) {
      for (const r of list) if (await r.has(pluginPath)) return true;
      return false;
    },
    async load(pluginPath) {
      for (const r of list) {
        const entry = await r.load(pluginPath);
        if (entry) return entry;
      }
      return null;
    },
    hint(pluginPath) {
      return list.map((r) => r.hint?.(pluginPath)).filter(Boolean).join(' ');
    },
    ownerOf
  };
}

let defaultRegistry = null;

function setDefaultPluginRegistry(registry) {
  defaultRegistry = asPluginRegistry(registry);
  return defaultRegistry;
}

function getDefaultPluginRegistry() {
  return defaultRegistry;
}

/** The registry a worker uses: its own `plugins`, else the process default. */
function pluginRegistryFor(worker) {
  return asPluginRegistry(worker?.plugins) || defaultRegistry;
}

/** Throw the precise reason a plugin could not be loaded from `registry`. */
async function throwPluginMissing(registry, pluginPath) {
  const pkg = packageNameOf(pluginPath);
  const packages = (await registry.packages?.()) || [];
  if (!packages.includes(pkg)) {
    throw new PluginLoadError(
      PLUGIN_PACKAGE_NOT_DECLARED,
      `Plugin ${pluginPath}: package "${pkg}" is not declared in package.json ${CONFIG_KEYS} ` +
        `(registry: ${registry.name}; declared: ${packages.join(', ') || 'none'}).`,
      { pluginPath }
    );
  }
  const owner = (await registry.ownerOf?.(pluginPath)) || registry;
  const near = nearestIdentities(pluginPath, (await owner.paths()).filter((p) => packageNameOf(p) === pkg));
  const hint = owner.hint?.(pluginPath) || '';
  throw new PluginLoadError(
    PLUGIN_NOT_FOUND,
    `Plugin ${pluginPath} was not found in package "${pkg}" (registry: ${owner.name}). ${hint}` +
      (near.length ? ` Known plugins nearby: ${near.join(', ')}.` : ''),
    { pluginPath }
  );
}

async function loadRegistryEntry(registry, pluginPath) {
  const packagePath = normalizePluginInstallPath(pluginPath);
  if (!registry) {
    throw new PluginLoadError(
      PLUGIN_CONFIG_INVALID,
      `Plugin ${packagePath} cannot load: no plugin registry is configured. ` +
        'Node: pass { plugins } to the worker or call setDefaultPluginRegistry(createNodePluginRegistry()). ' +
        'Cloudflare: alias @engine9/core/plugins/site to the module wrangler builds with `e9core build-plugins`.',
      { pluginPath: packagePath }
    );
  }
  let entry;
  try {
    entry = await registry.load(packagePath);
  } catch (e) {
    if (e instanceof PluginLoadError) throw e;
    throw new PluginLoadError(
      PLUGIN_IMPORT_FAILED,
      `Plugin ${packagePath} failed to import${e?.file ? ` (${e.file})` : ''}: ${e?.message || e}`,
      { pluginPath: packagePath, cause: e }
    );
  }
  if (!entry?.index) await throwPluginMissing(registry, packagePath);
  return entry;
}

/**
 * Compiled plugin object from the registry: the module's default export with
 * `path` set, transform paths stamped, and `settings` attached.
 */
async function compileRegistryPlugin(registry, pluginPath) {
  const entry = await loadRegistryEntry(registry, pluginPath);
  const mod = entry.index;
  const plugin = Object.assign({}, mod.default || mod);
  plugin.path = entry.path;
  if (entry.resolvedFsEntry) plugin.resolvedFsEntry = entry.resolvedFsEntry;
  []
    .concat(Object.values(plugin.transforms || {}))
    .filter(Boolean)
    .forEach((f) => {
      f.path = entry.path;
    });
  if (plugin.settings == null) {
    const settings =
      mod.settings ?? entry.settings?.settings ?? entry.settings?.default?.settings ?? null;
    if (settings != null) plugin.settings = settings;
  }
  return plugin;
}

/** Schema object for a plugin in the registry (schema.js, else index `schema`). */
async function loadRegistrySchema(registry, pluginPath) {
  const entry = await loadRegistryEntry(registry, pluginPath);
  const schema = entry.schema?.default || entry.schema || entry.index?.default?.schema || entry.index?.schema;
  if (!schema || typeof schema !== 'object') {
    throw new Error(`Plugin ${entry.path} has no schema`);
  }
  return Object.assign({}, schema);
}

/** Parsed ui.console.json5 for a plugin, or null. */
async function loadRegistryConsole(registry, pluginPath) {
  if (!registry) return null;
  const entry = await registry.load(normalizePluginInstallPath(pluginPath));
  return entry?.console || null;
}

export {
  PLUGIN_CONFIG_INVALID,
  PLUGIN_PACKAGE_NOT_DECLARED,
  PLUGIN_NOT_FOUND,
  PLUGIN_IMPORT_FAILED,
  PluginLoadError,
  createPluginRegistry,
  asPluginRegistry,
  isPluginRegistry,
  composePluginRegistries,
  setDefaultPluginRegistry,
  getDefaultPluginRegistry,
  pluginRegistryFor,
  compileRegistryPlugin,
  loadRegistrySchema,
  loadRegistryConsole
};
