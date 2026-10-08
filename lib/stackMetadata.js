/*
  Read include/exclude metadata for a schema plugin or stack path.

  Used by PluginWorker.install. Reads the plugin from the build's plugin
  registry; a plugin that is not in the build has no include/exclude.
*/

import { getPluginIncludeExclude } from './pluginPaths.js';

const DEFAULT_STACK_PATH = '@engine9/schemas/stacks/standard';

/** Published schema plugins installed by installDefaultPlugins() when no stack is requested. */
const DEFAULT_CORE_SCHEMAS = [
  '@engine9/schemas/plugin',
  '@engine9/schemas/person',
  '@engine9/schemas/person_remote',
  '@engine9/schemas/segment',
  '@engine9/schemas/person_email',
  '@engine9/schemas/person_phone',
  '@engine9/schemas/person_address',
  '@engine9/schemas/source_code'
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
 * Load include/exclude metadata for a stack or schema plugin path from a plugin
 * registry. Plugins that are not in the build have empty include/exclude.
 */
async function loadStackMetadata(pluginPath, { registry } = {}) {
  const entry = registry ? await registry.load(pluginPath) : null;
  const mod = entry?.index;
  if (!mod) return metadataFromDocument({});
  return metadataFromDocument(mod.metadata || mod.default?.metadata || mod);
}

export { DEFAULT_STACK_PATH, DEFAULT_CORE_SCHEMAS, loadStackMetadata };
