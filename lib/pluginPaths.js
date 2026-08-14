/*
  Shared plugin-path vocabulary for core and server.

  Plugin rows, stack include/exclude lists, and account `stacks[]` store
  package identity only: `@engine9/interfaces/person`. Load source
  (node_modules, monorepo sibling, explicit `source`) is chosen by the
  server resolver — never encoded in the path.

  Legacy `local$@engine9/...` strings are still accepted as an input alias
  and normalized by stripping `local$`. This module is the canonical matcher:

    - normalize / equivalent paths (`local$` stripped or added for reads)
    - membership tests for include/exclude lists
    - parse include/exclude arrays from stack metadata

  It lives in @engine9/core because it has no filesystem, compile, or database
  dependency — both the server PluginWorker (install, stacks, deps) and core
  (sqlite-ddl --stack, reading plugin.path) need the same rules. Schema
  deploy and plugin install themselves are server-only.
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

export {
  normalizePluginInstallPath,
  equivalentPluginPaths,
  pluginPathMatches,
  pluginPathInList,
  asPluginPathList,
  getPluginIncludeExclude
};
