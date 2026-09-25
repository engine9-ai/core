/*
  Read include/exclude metadata for an interface/stack path.

  Used by PluginWorker.install. Reads the plugin from the build's plugin
  registry; a plugin that is not in the build has no include/exclude.
*/

import { normalizePluginInstallPath, getPluginIncludeExclude } from './pluginPaths.js';

const DEFAULT_STACK_PATH = '@engine9/interfaces/stacks/standard';

/** Published interfaces installed by installStandard() when no stack is requested. */
const DEFAULT_CORE_INTERFACES = [
  '@engine9/interfaces/plugin',
  '@engine9/interfaces/person',
  '@engine9/interfaces/person_remote',
  '@engine9/interfaces/segment',
  '@engine9/interfaces/person_email',
  '@engine9/interfaces/person_phone',
  '@engine9/interfaces/person_address'
];

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

/**
 * Load include/exclude metadata for a stack or interface path from a plugin
 * registry. Plugins that are not in the build have empty include/exclude.
 */
async function loadStackMetadata(pluginPath, { registry } = {}) {
  const normalized = normalizePluginInstallPath(pluginPath);
  const entry = registry ? await registry.load(normalized) : null;
  const mod = entry?.index;
  if (!mod) return metadataFromDocument({});
  return metadataFromDocument(mod.metadata || mod.default?.metadata || mod);
}

export { DEFAULT_STACK_PATH, DEFAULT_CORE_INTERFACES, loadStackMetadata };
