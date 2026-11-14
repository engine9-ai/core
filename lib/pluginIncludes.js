/*
  The include and exclude lists of a plugin.

  Any plugin may list other plugins in `include` (installed with it, after
  it) or `exclude` (refused while it is installed). install, build-plugins,
  status, and the upgrade runner follow these lists the same way for every
  plugin; core treats no plugin as special because it has them.

  Reads the plugin from the build's plugin registry. A plugin that is not in
  the build has empty lists.
*/

import { getPluginIncludeExclude } from './pluginPaths.js';

function metadataFromDocument(doc) {
  const raw = doc?.metadata && typeof doc.metadata === 'object' ? { ...doc, ...doc.metadata } : doc || {};
  const { include, exclude } = getPluginIncludeExclude(raw);
  return {
    name: raw.name,
    description: raw.description,
    version: raw.version,
    include,
    exclude
  };
}

/** { name, description, version, include, exclude } for a plugin path, from a plugin registry. */
async function loadPluginIncludes(pluginPath, { registry } = {}) {
  const entry = registry ? await registry.load(pluginPath) : null;
  const mod = entry?.index;
  if (!mod) return metadataFromDocument({});
  return metadataFromDocument(mod.metadata || mod.default?.metadata || mod);
}

/**
 * Every plugin that installing `pluginPath` installs: the plugin, then its
 * includes and theirs, depth first. `load(path)` returns { include }.
 */
async function expandPluginIncludes(pluginPath, load, seen = new Set()) {
  if (seen.has(pluginPath)) return seen;
  seen.add(pluginPath);
  const { include = [] } = await load(pluginPath);
  for (const child of include) await expandPluginIncludes(child, load, seen);
  return seen;
}

export { loadPluginIncludes, expandPluginIncludes };
