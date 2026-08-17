/*
  Read include/exclude metadata for an interface/stack path.

  Used by PluginWorker.install. Prefers a local @engine9/interfaces package,
  then GitHub {base}/{short}/stack.json.
*/

import JSON5 from 'json5';
import { normalizePluginInstallPath, getPluginIncludeExclude } from './pluginPaths.js';

const DEFAULT_STACK_PATH = '@engine9/interfaces/stacks/standard';
const DEFAULT_GITHUB_INTERFACES_BASE = 'https://raw.githubusercontent.com/engine9-io/interfaces/main';

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

function githubStackJsonUrl(pluginPath, githubInterfacesBase = DEFAULT_GITHUB_INTERFACES_BASE) {
  const normalized = normalizePluginInstallPath(pluginPath);
  const shortName = normalized.startsWith('@engine9/interfaces/')
    ? normalized.slice('@engine9/interfaces/'.length)
    : normalized;
  return `${String(githubInterfacesBase).replace(/\/$/, '')}/${shortName}/stack.json`;
}

/**
 * Load include/exclude metadata for a stack or interface path. Prefers a local
 * `@engine9/interfaces/...` import, then GitHub `{base}/{short}/stack.json`.
 * Unknown plugins have empty include/exclude.
 */
async function loadStackMetadata(
  pluginPath,
  { githubInterfacesBase = DEFAULT_GITHUB_INTERFACES_BASE, fetch: fetchFn = globalThis.fetch } = {}
) {
  const normalized = normalizePluginInstallPath(pluginPath);
  if (!normalized.startsWith('@engine9/interfaces/')) {
    return metadataFromDocument({});
  }
  const shortName = normalized.slice('@engine9/interfaces/'.length);
  try {
    const mod = await import(`@engine9/interfaces/${shortName}/index.js`);
    return metadataFromDocument(mod.metadata || mod.default?.metadata || mod);
  } catch {
    // bundled runtimes may not have the package; try GitHub
  }
  const githubUrl = githubStackJsonUrl(normalized, githubInterfacesBase);
  try {
    const response = await fetchFn(githubUrl);
    if (response.ok) {
      const text = await response.text();
      return metadataFromDocument(JSON5.parse(text));
    }
  } catch {
    // empty metadata
  }
  return metadataFromDocument({});
}

export {
  DEFAULT_STACK_PATH,
  DEFAULT_GITHUB_INTERFACES_BASE,
  githubStackJsonUrl,
  loadStackMetadata
};
