/*
  Shared plugin-path vocabulary for core and server.

  Plugin rows and stack include/exclude lists store package identity only:
  `@engine9/schemas/person`. Load source (node_modules, monorepo sibling,
  explicit `source`) is chosen at compile time — never encoded in the path.

  Two legacy spellings are accepted as input aliases and normalized:

    - `local$@engine9/...`: `local$` is stripped.
    - `@engine9/interfaces/...`: the package was renamed to `@engine9/schemas`.
      Rows, segment definitions, settings, flow files, and task history written
      before the rename still carry the old name.

  This module is the canonical matcher:

    - normalize / equivalent paths (aliases stripped or added for reads)
    - membership tests for include/exclude lists
    - parse include/exclude arrays from stack metadata

  It lives in @engine9/core because it has no filesystem, compile, or database
  dependency. PluginWorker (install, include/exclude, deps) needs the same rules.
*/

const SCHEMAS_PACKAGE = '@engine9/schemas';
const LEGACY_SCHEMAS_PACKAGE = '@engine9/interfaces';

/** `@engine9/interfaces` → `@engine9/schemas`; any other package name unchanged. */
function normalizePluginPackageName(name) {
  const n = String(name || '').trim();
  return n === LEGACY_SCHEMAS_PACKAGE ? SCHEMAS_PACKAGE : n;
}

function normalizePluginInstallPath(pluginPath) {
  const p = String(pluginPath || '').replace(/^local\$/, '');
  if (p === LEGACY_SCHEMAS_PACKAGE || p.startsWith(`${LEGACY_SCHEMAS_PACKAGE}/`)) {
    return SCHEMAS_PACKAGE + p.slice(LEGACY_SCHEMAS_PACKAGE.length);
  }
  return p;
}

/** npm package a plugin identity belongs to: `@engine9/schemas/person` → `@engine9/schemas`. */
function packageNameOf(pluginPath) {
  const p = normalizePluginInstallPath(pluginPath);
  const parts = p.split('/');
  return p.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every spelling a stored row may use for this path: canonical, legacy package name, and `local$` forms. */
function equivalentPluginPaths(pluginPath) {
  const packagePath = normalizePluginInstallPath(pluginPath);
  const legacyPath =
    packagePath === SCHEMAS_PACKAGE || packagePath.startsWith(`${SCHEMAS_PACKAGE}/`)
      ? LEGACY_SCHEMAS_PACKAGE + packagePath.slice(SCHEMAS_PACKAGE.length)
      : null;
  return [
    ...new Set(
      [
        pluginPath,
        packagePath,
        packagePath ? `local$${packagePath}` : null,
        legacyPath,
        legacyPath ? `local$${legacyPath}` : null
      ].filter(Boolean)
    )
  ];
}

function pluginPathMatches(pluginPath, candidate) {
  if (!pluginPath || !candidate) return false;
  const left = new Set(equivalentPluginPaths(pluginPath));
  return equivalentPluginPaths(candidate).some((p) => left.has(p));
}

function pluginPathInList(pluginPath, list = []) {
  return list.some((candidate) => pluginPathMatches(pluginPath, candidate));
}

function asPluginPathList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of plugin paths`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${label} entries must be non-empty plugin path strings`);
    }
    return normalizePluginInstallPath(entry);
  });
}

function getPluginIncludeExclude(metadata = {}) {
  return {
    include: asPluginPathList(metadata.include, 'metadata.include'),
    exclude: asPluginPathList(metadata.exclude, 'metadata.exclude')
  };
}

const AVAILABLE_NAMESPACE_PREFIXES = [`${SCHEMAS_PACKAGE}/`, '@engine9/plugins/'];

function suffixForAvailablePrefix(fullPath, prefix) {
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : null;
}

/**
 * Resolve a user or agent plugin path to a canonical install path from listAvailable().
 */
function resolveAvailablePluginPath(inputPath, availablePaths) {
  const pluginPath = String(inputPath ?? '').trim();
  if (!pluginPath) throw new Error('path is required');
  if (!Array.isArray(availablePaths) || availablePaths.length === 0) {
    throw new Error('No available plugins');
  }

  if (availablePaths.includes(pluginPath)) return pluginPath;

  if (pluginPath.startsWith('@')) {
    const normalized = normalizePluginInstallPath(pluginPath);
    if (availablePaths.includes(normalized)) return normalized;
    throw new Error(`Plugin not available: ${pluginPath}`);
  }

  const want = pluginPath.toLowerCase();
  const suffixMatches = [];
  const nameMatches = [];

  for (const full of availablePaths) {
    for (const prefix of AVAILABLE_NAMESPACE_PREFIXES) {
      const suffix = suffixForAvailablePrefix(full, prefix);
      if (suffix && suffix.toLowerCase() === want) {
        suffixMatches.push(full);
      }
    }
    const last = full.split('/').pop();
    if (last && last.toLowerCase() === want) {
      nameMatches.push(full);
    }
  }

  const candidates = [...new Set([...suffixMatches, ...nameMatches])];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`Ambiguous plugin path "${pluginPath}" (${candidates.join(', ')})`);
  }

  throw new Error(`No available plugin matches "${pluginPath}"`);
}

export {
  SCHEMAS_PACKAGE,
  LEGACY_SCHEMAS_PACKAGE,
  normalizePluginPackageName,
  normalizePluginInstallPath,
  packageNameOf,
  equivalentPluginPaths,
  pluginPathMatches,
  pluginPathInList,
  asPluginPathList,
  getPluginIncludeExclude,
  resolveAvailablePluginPath
};
