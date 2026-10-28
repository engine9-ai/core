/*
  A plugin's metadata.dependencies: { '<plugin path>': '<semver range>' }. Each
  dependency must be installed, and the build's copy of its package must
  satisfy the range. Install refuses on a failure; status reports it.
*/
import semver from 'semver';
import { pluginRegistryFor } from './pluginRegistry.js';
import { packageNameOf } from './pluginPaths.js';

/** Unmet dependencies as sentences; empty when all are met. */
export async function pluginDependencyFailures(worker, { dependencies = {} } = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Object.keys(dependencies).length === 0) return [];
  const registry = pluginRegistryFor(worker);
  const failures = [];
  for (const [dependencyPath, range] of Object.entries(dependencies)) {
    if (!semver.validRange(range)) {
      failures.push(`${dependencyPath} declares invalid version range ${range}`);
      continue;
    }
    const { data: installed } = await worker.query({
      sql: 'select path from plugin where path=?',
      values: [dependencyPath]
    });
    if (!installed.length) {
      failures.push(`${dependencyPath}@${range} is not installed`);
      continue;
    }
    const depPackage = packageNameOf(dependencyPath);
    const hostVersion =
      typeof registry?.packageVersion === 'function' ? await registry.packageVersion(depPackage) : null;
    if (!semver.valid(hostVersion) || !semver.satisfies(hostVersion, range)) {
      failures.push(
        `${dependencyPath}@${range} is not satisfied by host ${depPackage}@${hostVersion || 'unversioned'}`
      );
    }
  }
  return failures;
}
