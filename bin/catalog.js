/*
  `e9core catalog build` and `e9core catalog validate`: plugin catalog entries
  (docs/plugin-catalog.md).

  build reads the plugins from the project's registry (package.json
  "engine9"), the same way install does, and writes one entry per plugin.
  The version is the package's package.json version; the publisher is
  metadata.publisher, else the package's "author".
*/
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getStringArray } from '../lib/utilities.js';
import { packageNameOf } from '../lib/pluginPaths.js';
import { compileRegistryPlugin } from '../lib/pluginRegistry.js';
import {
  buildPluginCatalogEntry,
  bundlePluginCatalog,
  pluginCatalogFile,
  validatePluginCatalogEntry
} from '../lib/pluginCatalog.js';
import { packageRoot } from './buildPlugins.js';
import { ensureNodePluginRegistry } from './nodePluginRegistry.js';

export const CATALOG_HELP = `e9core catalog build (--plugin <path>[,<path>] | --package <name>) [--out <dir>]
    Build the catalog entry of each plugin from its code. --out writes
    <dir>/<plugin path>.json; without it the entries print as one JSON object
    keyed by path. Exits 1 when an entry does not meet the standard.

e9core catalog validate <file.json> [...]
    Check entries against the standard: a file holds one entry, or an object
    of entries keyed by path. Exits 1 on an error; warnings print to stderr.`;

function readPackageJson(cwd, name) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot(cwd, name, { peerFallback: true }), 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function report(label, result) {
  for (const warning of result.warnings) console.error(`${label}: warning: ${warning}`);
  for (const error of result.errors) console.error(`${label}: ${error}`);
  return result.ok;
}

function entriesIn(doc) {
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && typeof doc.path === 'string' && 'catalog_version' in doc) {
    return [doc];
  }
  if (Array.isArray(doc)) return doc;
  return Object.values(doc || {});
}

async function build(args, cwd) {
  const registry = ensureNodePluginRegistry({ cwd });
  let paths = args.plugin && args.plugin !== true ? getStringArray(String(args.plugin)) : [];
  if (!paths.length && args.package && args.package !== true) {
    const pkg = String(args.package);
    paths = (await registry.paths()).filter((p) => packageNameOf(p) === pkg).sort();
    if (!paths.length) throw new Error(`No plugins found in package ${pkg}`);
  }
  if (!paths.length) throw new Error('catalog build needs --plugin <path> or --package <name>');

  const entries = [];
  let ok = true;
  for (const pluginPath of paths) {
    const pkg = packageNameOf(pluginPath);
    const pkgJson = readPackageJson(cwd, pkg);
    const plugin = await compileRegistryPlugin(registry, pluginPath);
    const entry = buildPluginCatalogEntry({
      path: pluginPath,
      plugin,
      packageVersion: (await registry.packageVersion(pkg)) ?? pkgJson.version ?? null,
      publisher: pkgJson.author ?? null
    });
    ok = report(pluginPath, validatePluginCatalogEntry(entry)) && ok;
    entries.push(entry);
  }

  if (args.out && args.out !== true) {
    const dir = path.resolve(cwd, String(args.out));
    for (const entry of entries) {
      const file = path.join(dir, pluginCatalogFile(entry.path));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
      console.log(path.relative(cwd, file));
    }
  } else {
    console.log(JSON.stringify(bundlePluginCatalog(entries), null, 2));
  }
  return ok;
}

function validate(files, cwd) {
  if (!files.length) throw new Error('catalog validate needs one or more files');
  let ok = true;
  for (const file of files) {
    const doc = JSON.parse(readFileSync(path.resolve(cwd, file), 'utf8'));
    const entries = entriesIn(doc);
    if (!entries.length) {
      console.error(`${file}: no entries`);
      ok = false;
    }
    for (const entry of entries) {
      ok = report(`${file}: ${entry?.path ?? '(no path)'}`, validatePluginCatalogEntry(entry)) && ok;
    }
  }
  if (ok) console.log('ok');
  return ok;
}

export async function catalogCommand(args, { cwd = process.cwd() } = {}) {
  const [, sub, ...files] = args._;
  if (sub === 'build') return build(args, cwd);
  if (sub === 'validate') return validate(files, cwd);
  console.log(CATALOG_HELP);
  return args.help === true;
}
