/*
  `e9core build-plugins`: write the plugin registry module for this project.

  Runs in Node at build or install time. It reads the project's package.json,
  finds plugin entry points in the listed packages under node_modules, and
  writes a module that imports each one with a literal specifier, so any
  bundler (wrangler, Vite, esbuild) can include them. Nothing in that module
  touches the filesystem when it runs.

  package.json:
    "engine9": {
      "plugins": ["@engine9/interfaces/event"],          // only these (plus
                                                         // core interfaces and
                                                         // stack includes)
      "pluginPackages": ["@engine9/interfaces"]          // or: every plugin in
                                                         // these packages
    }

  With neither, every plugin in @engine9/interfaces is included.

  A plugin is a directory with index.js (identity: <package>/<dir>) or a
  file named *.plugin.js (identity: <package>/<dir>/<file>). Next to index.js,
  schema.js and settings.js are imported and ui.console.json5 is inlined.
*/
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import JSON5 from 'json5';
import { DEFAULT_CORE_INTERFACES } from '../lib/stackMetadata.js';
import { normalizePluginInstallPath } from '../lib/pluginPaths.js';

const DEFAULT_OUT = 'engine9.plugins.js';
const DEFAULT_PACKAGES = ['@engine9/interfaces'];
const SKIP_DIRS = new Set(['node_modules', 'skills', 'test', 'tests']);

function readPackageJson(cwd) {
  const file = path.join(cwd, 'package.json');
  if (!existsSync(file)) throw new Error(`build-plugins: no package.json in ${cwd}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function packageNameOf(pluginPath) {
  const parts = pluginPath.split('/');
  return pluginPath.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function packageRoot(cwd, name) {
  const req = createRequire(path.join(cwd, 'package.json'));
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    throw new Error(
      `build-plugins: package ${name} is not installed in ${cwd}. Add it to dependencies (e.g. "file:../${name.split('/').pop()}") and run npm install.`
    );
  }
}

function entryFor(identity, fsPath, isFile) {
  if (isFile) return { identity, index: identity };
  const entry = { identity, index: `${identity}/index.js` };
  if (existsSync(path.join(fsPath, 'schema.js'))) entry.schema = `${identity}/schema.js`;
  if (existsSync(path.join(fsPath, 'settings.js'))) entry.settings = `${identity}/settings.js`;
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
function discoverPackagePlugins(cwd, name) {
  return walk(packageRoot(cwd, name), name, '', []);
}

function selectEntries(discovered, requested) {
  const byIdentity = new Map(discovered.map((e) => [e.identity, e]));
  const selected = new Map();
  const queue = requested.map(normalizePluginInstallPath);
  while (queue.length) {
    const identity = queue.shift();
    if (selected.has(identity)) continue;
    const entry = byIdentity.get(identity);
    if (!entry) throw new Error(`build-plugins: ${identity} is not in node_modules/${packageNameOf(identity)}`);
    selected.set(identity, entry);
    for (const inc of entry.include || []) queue.push(inc);
  }
  return [...selected.values()];
}

/**
 * @param {{ cwd?: string, plugins?: string[], packages?: string[] }} options
 * @returns {{ entries: object[], packages: string[] }}
 */
export function collectPluginEntries(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = readPackageJson(cwd).engine9 || {};
  const requested = options.plugins || config.plugins || null;
  if (requested) {
    const all = [...DEFAULT_CORE_INTERFACES, ...requested];
    const packages = [...new Set([...(options.packages || config.pluginPackages || []), ...all.map(packageNameOf)])];
    const discovered = packages.flatMap((name) => discoverPackagePlugins(cwd, name));
    return { entries: selectEntries(discovered, all), packages };
  }
  const packages = options.packages || config.pluginPackages || DEFAULT_PACKAGES;
  return { entries: packages.flatMap((name) => discoverPackagePlugins(cwd, name)), packages };
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
    '// Generated by `npx e9core build-plugins`. Do not edit.',
    `// Packages: ${packages.join(', ') || '(none)'}`,
    '// Regenerate after changing plugin dependencies or "engine9" in package.json.',
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

export { DEFAULT_OUT };
