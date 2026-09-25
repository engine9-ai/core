/*
  Build-time plugin registry.

  Core runs only plugins that were compiled into the build. It does not find,
  read, or import plugin code from disk at runtime. `e9core build-plugins`
  writes a module that imports each plugin (index.js, schema.js, settings.js)
  and inlines ui.console.json5. Pass that module to a worker as `{ plugins }`,
  or call setDefaultPluginRegistry() once at startup.

  This is a deliberate trade. It lets core run in pre-compiled runtimes such
  as Cloudflare workerd, and it gives up loading or recompiling plugin code
  without a rebuild. The weaver still decides, per account, which installed
  plugins run; it just looks them up here instead of loading them.

  Registry shape (all methods async):
    name              label for error messages
    paths()           plugin identities in the build
    has(path)         whether a plugin is in the build
    load(path, opts)  { path, index, schema, settings, console } or null

  The private server keeps runtime compilation as a separate deployment that
  supplies its own registry (server/runtime-plugins).
*/
import { normalizePluginInstallPath } from './pluginPaths.js';

const PLUGIN_NOT_IN_BUILD = 'PLUGIN_NOT_IN_BUILD';

class PluginNotInBuildError extends Error {
  constructor(pluginPath, registryName) {
    super(
      registryName
        ? `Plugin ${pluginPath} is not in this build (registry: ${registryName}). ` +
            'Add it to "engine9.plugins" in package.json and run `npx e9core build-plugins`.'
        : `Plugin ${pluginPath} cannot load: no plugin registry is configured. ` +
            'Pass { plugins } to the worker or call setDefaultPluginRegistry(). See `npx e9core build-plugins`.'
    );
    this.name = 'PluginNotInBuildError';
    this.code = PLUGIN_NOT_IN_BUILD;
    this.pluginPath = pluginPath;
  }
}

async function readPart(entry, key) {
  const value = entry?.[key];
  if (value == null) return null;
  return typeof value === 'function' ? value() : value;
}

/**
 * @param {Record<string, { index?: object|Function, schema?: object|Function, settings?: object|Function, console?: object|Function }>} entries
 * @param {{ name?: string }} [opts]
 */
function createPluginRegistry(entries = {}, { name = 'build' } = {}) {
  const table = new Map();
  for (const [key, entry] of Object.entries(entries || {})) {
    table.set(normalizePluginInstallPath(key), entry);
  }
  const loaded = new Map();
  return {
    name,
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
          console: await readPart(entry, 'console')
        }))();
        pending.catch(() => loaded.delete(key));
        loaded.set(key, pending);
      }
      return loaded.get(key);
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

/** First registry that has the plugin wins. */
function composePluginRegistries(...registries) {
  const list = registries.map(asPluginRegistry).filter(Boolean);
  return {
    name: list.map((r) => r.name).join('+'),
    supportsSource: list.some((r) => r.supportsSource),
    async paths() {
      const all = await Promise.all(list.map((r) => r.paths()));
      return [...new Set(all.flat())].sort();
    },
    async has(pluginPath) {
      for (const r of list) if (await r.has(pluginPath)) return true;
      return false;
    },
    async load(pluginPath, opts) {
      for (const r of list) {
        if (opts?.source && !r.supportsSource) continue;
        const entry = await r.load(pluginPath, opts);
        if (entry) return entry;
      }
      return null;
    }
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

async function loadRegistryEntry(registry, pluginPath, { source } = {}) {
  const packagePath = normalizePluginInstallPath(pluginPath);
  if (!registry) throw new PluginNotInBuildError(packagePath, null);
  if (source && !registry.supportsSource) {
    throw new Error(
      `Cannot load ${packagePath} from source ${source}: this build only runs pre-compiled plugins. ` +
        'Loading plugin code from a directory needs the server runtime-plugins deployment.'
    );
  }
  const entry = await registry.load(packagePath, { source });
  if (!entry?.index) throw new PluginNotInBuildError(packagePath, registry.name);
  return entry;
}

/**
 * Compiled plugin object from the registry: the module's default export with
 * `path` set, transform paths stamped, and `settings` attached.
 */
async function compileRegistryPlugin(registry, pluginPath, { source } = {}) {
  const entry = await loadRegistryEntry(registry, pluginPath, { source });
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
    throw new Error(`Plugin ${entry.path} has no schema in this build`);
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
  PLUGIN_NOT_IN_BUILD,
  PluginNotInBuildError,
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
