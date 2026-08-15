/*
  Shared plugin-path vocabulary for core and server.

  Plugin rows, stack include/exclude lists, and account `stacks[]` store
  package identity only: `@engine9/interfaces/person`. Load source
  (node_modules, monorepo sibling, explicit `source`) is chosen at compile
  time — never encoded in the path.

  Legacy `local$@engine9/...` strings are still accepted as an input alias
  and normalized by stripping `local$`. This module is the canonical matcher:

    - normalize / equivalent paths (`local$` stripped or added for reads)
    - membership tests for include/exclude lists
    - parse include/exclude arrays from stack metadata

  It lives in @engine9/core because it has no filesystem, compile, or database
  dependency. PluginWorker (install, stacks, deps) and sqlite-ddl --stack
  both need the same rules.
*/

function normalizePluginInstallPath(pluginPath) {
  return String(pluginPath || '').replace(/^local\$/, '');
}

function equivalentPluginPaths(pluginPath) {
  const packagePath = normalizePluginInstallPath(pluginPath);
  return [...new Set([pluginPath, packagePath, packagePath ? `local$${packagePath}` : null].filter(Boolean))];
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

const AVAILABLE_NAMESPACE_PREFIXES = ['@engine9/interfaces/', '@engine9/plugins/'];

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
  normalizePluginInstallPath,
  equivalentPluginPaths,
  pluginPathMatches,
  pluginPathInList,
  asPluginPathList,
  getPluginIncludeExclude,
  resolveAvailablePluginPath
};
