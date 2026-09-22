/*
  Resolve a plugin package identity to a filesystem entry for import.

  plugin.path is identity only (@engine9/interfaces/person). Load source is
  chosen here — never encoded as a local$ path prefix.

  Order:
    1. Explicit source (absolute dir / file / file: URL)
    2. Node package resolve (node_modules / npm link)
    3. Monorepo sibling checkout (../interfaces, ../plugins)
*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePluginInstallPath } from './pluginPaths.js';

const fsp = fs.promises;
const requireResolve = createRequire(import.meta.url).resolve;

/** @engine9/core package root. Monorepo siblings sit next to it. */
const CORE_DIR = path.resolve(import.meta.dirname, '..');
const MONOREPO_ROOT = path.resolve(CORE_DIR, '..');

async function entryFromFsPath(fsPathAbsolute) {
  const st = await fsp.stat(fsPathAbsolute);
  const resolvedFsEntry = st.isDirectory() ? path.join(fsPathAbsolute, 'index.js') : fsPathAbsolute;
  await fsp.access(resolvedFsEntry, fs.constants.R_OK);
  return resolvedFsEntry;
}

function siblingPathForPackage(packagePath) {
  if (packagePath.startsWith('@engine9/interfaces/')) {
    const rel = packagePath.slice('@engine9/interfaces/'.length);
    return path.join(MONOREPO_ROOT, 'interfaces', rel);
  }
  if (packagePath.startsWith('@engine9/plugins/')) {
    const rel = packagePath.slice('@engine9/plugins/'.length);
    return path.join(MONOREPO_ROOT, 'plugins', rel);
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.path
 * @param {string} [opts.source]
 * @param {'index'|'schema'|'ui.console'} [opts.entry='index']
 */
export async function resolvePluginModule({ path: pluginPath, source, entry = 'index' } = {}) {
  if (!pluginPath && !source) {
    throw new Error('resolvePluginModule: path or source is required');
  }

  const packagePath = pluginPath ? normalizePluginInstallPath(pluginPath) : null;

  if (source) {
    let fsPathAbsolute;
    if (typeof source === 'string' && source.startsWith('file:')) {
      fsPathAbsolute = path.normalize(fileURLToPath(source));
    } else if (path.isAbsolute(source)) {
      fsPathAbsolute = path.normalize(source);
    } else {
      throw new Error(`resolvePluginModule: source must be absolute or file: URL, got ${source}`);
    }
    let resolvedFsEntry = await entryFromFsPath(fsPathAbsolute);
    if (entry !== 'index' && (await fsp.stat(fsPathAbsolute)).isDirectory()) {
      const named =
        entry === 'schema'
          ? path.join(fsPathAbsolute, 'schema.js')
          : path.join(fsPathAbsolute, 'ui.console.json5');
      await fsp.access(named, fs.constants.R_OK);
      resolvedFsEntry = named;
    }
    return {
      packagePath: packagePath || fsPathAbsolute,
      resolvedFsEntry,
      href: pathToFileURL(resolvedFsEntry).href
    };
  }

  if (!packagePath) {
    throw new Error('resolvePluginModule: path is required when source is omitted');
  }

  if (packagePath.startsWith('file:') || path.isAbsolute(packagePath)) {
    const fsPathAbsolute = packagePath.startsWith('file:')
      ? path.normalize(fileURLToPath(packagePath))
      : path.normalize(packagePath);
    const resolvedFsEntry = await entryFromFsPath(fsPathAbsolute);
    return {
      packagePath,
      resolvedFsEntry,
      href: pathToFileURL(resolvedFsEntry).href
    };
  }

  if (packagePath.startsWith('engine9-accounts/')) {
    const abs = path.join(MONOREPO_ROOT, packagePath);
    const resolvedFsEntry = await entryFromFsPath(abs.endsWith('.js') ? abs : path.join(abs, 'index.js'));
    return { packagePath, resolvedFsEntry, href: pathToFileURL(resolvedFsEntry).href };
  }

  const fileName =
    entry === 'schema' ? 'schema.js' : entry === 'ui.console' ? 'ui.console.json5' : 'index.js';

  if (packagePath.startsWith('@')) {
    try {
      const resolved = requireResolve(packagePath);
      if (entry === 'index') {
        return {
          packagePath,
          resolvedFsEntry: resolved,
          href: pathToFileURL(resolved).href
        };
      }
      const dir = path.dirname(resolved);
      const named = path.join(dir, fileName);
      await fsp.access(named, fs.constants.R_OK);
      return { packagePath, resolvedFsEntry: named, href: pathToFileURL(named).href };
    } catch (e) {
      if (e?.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  const sibling = siblingPathForPackage(packagePath);
  if (sibling) {
    const candidate = path.join(sibling, fileName);
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return {
        packagePath,
        resolvedFsEntry: candidate,
        href: pathToFileURL(candidate).href
      };
    } catch {
      if (entry === 'index' && packagePath.endsWith('.js')) {
        const rel = packagePath.startsWith('@engine9/interfaces/')
          ? packagePath.slice('@engine9/interfaces/'.length)
          : packagePath.slice('@engine9/plugins/'.length);
        const abs = path.join(
          MONOREPO_ROOT,
          packagePath.startsWith('@engine9/interfaces/') ? 'interfaces' : 'plugins',
          rel
        );
        await fsp.access(abs, fs.constants.R_OK);
        return { packagePath, resolvedFsEntry: abs, href: pathToFileURL(abs).href };
      }
    }
  }

  throw new Error(
    `Cannot resolve plugin module ${pluginPath || packagePath}: not in node_modules and no monorepo sibling at ${sibling || '(n/a)'}`
  );
}

export { CORE_DIR, MONOREPO_ROOT };
