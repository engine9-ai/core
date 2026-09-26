/*
  `e9core build-plugins`: write the plugin registry module for a bundled build.

  Bundlers (wrangler, esbuild, Vite) include only what they can see as a
  literal import specifier, and workerd has no filesystem to discover plugins
  at run time. So for Cloudflare the discovery below runs at build time and its
  result is written as a module of literal imports. `e9core setup` puts this
  command in wrangler's build step; nobody runs it by hand.

  Node runtimes do not need the file: @engine9/core/plugins/node runs the same
  discovery when the process starts.

  package.json:
    "engine9": {
      "pluginPackages":        ["@engine9/interfaces", "@engine9/plugins"],
      "dynamicPluginPackages": ["engine9-accounts"],   // Node only; a bundle refuses it
      "plugins": ["@engine9/interfaces/event"]         // legacy: only these identities
                                                       // (plus core interfaces and
                                                       // stack includes)
    }

  With none of these, every plugin in @engine9/interfaces is included.

  A plugin is a directory with index.js (identity: <package>/<dir>) or a
  file named *.plugin.js (identity: <package>/<dir>/<file>). Next to index.js,
  schema.js and settings.js are imported and ui.console.json5 is inlined.
*/
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import JSON5 from 'json5';
import { DEFAULT_CORE_INTERFACES } from '../lib/stackMetadata.js';
import { normalizePluginInstallPath, packageNameOf } from '../lib/pluginPaths.js';
import { PLUGIN_CONFIG_INVALID, PluginLoadError } from '../lib/pluginRegistry.js';

const DEFAULT_OUT = 'engine9.plugins.js';
const DEFAULT_PACKAGES = ['@engine9/interfaces'];
const SKIP_DIRS = new Set(['node_modules', 'skills', 'test', 'tests']);

function asList(value, key) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new PluginLoadError(PLUGIN_CONFIG_INVALID, `package.json "engine9.${key}" must be an array of package names`);
  }
  return [...new Set(value.map((v) => v.trim()))];
}

/**
 * The "engine9" plugin configuration of the project at `cwd`.
 * @returns {{ plugins: string[]|null, pluginPackages: string[], dynamicPluginPackages: string[], configured: boolean }}
 */
export function readEngine9Config(cwd) {
  const file = path.join(cwd, 'package.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).engine9 || {} : {};
  const plugins = config.plugins ? asList(config.plugins, 'plugins') : null;
  const pluginPackages = asList(config.pluginPackages, 'pluginPackages');
  const dynamicPluginPackages = asList(config.dynamicPluginPackages, 'dynamicPluginPackages');
  const both = pluginPackages.filter((p) => dynamicPluginPackages.includes(p));
  if (both.length) {
    throw new PluginLoadError(
      PLUGIN_CONFIG_INVALID,
      `package.json "engine9": ${both.join(', ')} listed in both pluginPackages and dynamicPluginPackages. A package is one or the other.`
    );
  }
  return {
    plugins,
    pluginPackages,
    dynamicPluginPackages,
    configured: Boolean(plugins || pluginPackages.length || dynamicPluginPackages.length)
  };
}

/**
 * Absolute directory of an installed package, resolved from `cwd`.
 * With `peerFallback`, a package the project has not installed may still be
 * found next to @engine9/core (its peer dependency, e.g. @engine9/interfaces);
 * that is fine for Node, which imports by absolute path, but not for a bundle,
 * which resolves the literal specifier from the project root.
 */
export function packageRoot(cwd, name, { peerFallback = false } = {}) {
  const tryResolve = (from) => {
    try {
      return path.dirname(createRequire(from).resolve(`${name}/package.json`));
    } catch {
      return null;
    }
  };
  const found = tryResolve(path.join(cwd, 'package.json')) || (peerFallback ? tryResolve(import.meta.url) : null);
  if (found) return found;
  throw new PluginLoadError(
    PLUGIN_CONFIG_INVALID,
    `Plugin package "${name}" is listed in package.json "engine9" but is not installed in ${cwd} ` +
      `(looked for node_modules/${name}/package.json). Add it to dependencies and run npm install.`
  );
}

function entryFor(identity, fsPath, isFile) {
  if (isFile) return { identity, index: identity, files: { index: fsPath } };
  const entry = { identity, index: `${identity}/index.js`, files: { index: path.join(fsPath, 'index.js') } };
  const schema = path.join(fsPath, 'schema.js');
  if (existsSync(schema)) {
    entry.schema = `${identity}/schema.js`;
    entry.files.schema = schema;
  }
  const settings = path.join(fsPath, 'settings.js');
  if (existsSync(settings)) {
    entry.settings = `${identity}/settings.js`;
    entry.files.settings = settings;
  }
  const consoleFile = path.join(fsPath, 'ui.console.json5');
  if (existsSync(consoleFile)) entry.console = JSON5.parse(readFileSync(consoleFile, 'utf8'));
  const stackFile = path.join(fsPath, 'stack.json');
  if (existsSync(stackFile)) {
    const stack = JSON5.parse(readFileSync(stackFile, 'utf8'));
    entry.include = Array.isArray(stack.include) ? stack.include : [];
  }
  return entry;
}

function walk(root, name, rel, out) {
  const dir = rel ? path.join(root, rel) : root;
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isFile() && ent.name.endsWith('.plugin.js')) {
      out.push(entryFor(`${name}/${childRel}`, path.join(root, childRel), true));
      continue;
    }
    if (!ent.isDirectory() || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(root, childRel);
    if (existsSync(path.join(full, 'index.js'))) {
      out.push(entryFor(`${name}/${childRel}`, full, false));
    } else {
      walk(root, name, childRel, out);
    }
  }
  return out;
}

/** Every plugin entry point in one installed package. */
export function discoverPackagePlugins(cwd, name, resolveOptions) {
  return walk(packageRoot(cwd, name, resolveOptions), name, '', []);
}

function selectEntries(discovered, requested) {
  const byIdentity = new Map(discovered.map((e) => [e.identity, e]));
  const selected = new Map();
  const queue = requested.map(normalizePluginInstallPath);
  while (queue.length) {
    const identity = queue.shift();
    if (selected.has(identity)) continue;
    const entry = byIdentity.get(identity);
    if (!entry) {
      throw new PluginLoadError(
        PLUGIN_CONFIG_INVALID,
        `package.json "engine9.plugins": ${identity} is not in node_modules/${packageNameOf(identity)}`
      );
    }
    selected.set(identity, entry);
    for (const inc of entry.include || []) queue.push(inc);
  }
  return [...selected.values()];
}

/**
 * Plugins to load statically for the project at `cwd`. Reads
 * `engine9.plugins` / `engine9.pluginPackages`; ignores dynamicPluginPackages.
 * @param {{ cwd?: string, plugins?: string[], packages?: string[], peerFallback?: boolean }} options
 * @returns {{ entries: object[], packages: string[] }}
 */
export function collectPluginEntries(options = {}) {
  const cwd = options.cwd || process.cwd();
  const resolveOptions = { peerFallback: options.peerFallback === true };
  const config = readEngine9Config(cwd);
  const requested = options.plugins || config.plugins || null;
  if (requested) {
    const all = [...DEFAULT_CORE_INTERFACES, ...requested];
    const packages = [...new Set([...(options.packages || config.pluginPackages), ...all.map(packageNameOf)])];
    const discovered = packages.flatMap((name) => discoverPackagePlugins(cwd, name, resolveOptions));
    return { entries: selectEntries(discovered, all), packages };
  }
  const packages = options.packages || (config.configured ? config.pluginPackages : DEFAULT_PACKAGES);
  return { entries: packages.flatMap((name) => discoverPackagePlugins(cwd, name, resolveOptions)), packages };
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

/** Source text of the registry module. Deterministic for a given input. */
export function renderPluginRegistry(entries, { packages = [] } = {}) {
  const sorted = [...entries].sort((a, b) => a.identity.localeCompare(b.identity));
  const lines = [
    '// Generated by `e9core build-plugins` (wrangler runs it at build time). Do not edit.',
    `// Packages: ${packages.join(', ') || '(none)'}`,
    'export default {'
  ];
  sorted.forEach((e, i) => {
    const parts = [`    index: () => import(${JSON.stringify(e.index)})`];
    if (e.schema) parts.push(`    schema: () => import(${JSON.stringify(e.schema)})`);
    if (e.settings) parts.push(`    settings: () => import(${JSON.stringify(e.settings)})`);
    if (e.console) parts.push(`    console: ${indent(JSON.stringify(e.console, null, 2), 4)}`);
    lines.push(`  ${JSON.stringify(e.identity)}: {`);
    lines.push(parts.join(',\n'));
    lines.push(`  }${i < sorted.length - 1 ? ',' : ''}`);
  });
  lines.push('};', '');
  return lines.join('\n');
}

/**
 * Write (or with check, compare) the registry module.
 * @returns {{ out: string, count: number, changed: boolean }}
 */
export function buildPlugins(options = {}) {
  const cwd = options.cwd || process.cwd();
  const out = path.resolve(cwd, options.out || DEFAULT_OUT);
  const { dynamicPluginPackages } = readEngine9Config(cwd);
  if (dynamicPluginPackages.length && !options.packages && !options.plugins) {
    throw new PluginLoadError(
      PLUGIN_CONFIG_INVALID,
      `build-plugins compiles plugins into a bundle, and a bundle cannot read plugins from disk. ` +
        `Move ${dynamicPluginPackages.join(', ')} from "engine9.dynamicPluginPackages" to "engine9.pluginPackages", or remove them.`
    );
  }
  const { entries, packages } = collectPluginEntries({ ...options, cwd });
  const source = renderPluginRegistry(entries, { packages });
  const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
  const changed = current !== source;
  if (options.check) {
    if (changed) {
      throw new Error(`build-plugins: ${path.relative(cwd, out)} is out of date. Run npx e9core build-plugins.`);
    }
  } else if (changed) {
    writeFileSync(out, source);
  }
  return { out, count: entries.length, changed };
}

export { DEFAULT_OUT, DEFAULT_PACKAGES, SKIP_DIRS };
