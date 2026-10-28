/*
  The upgrade window: how far behind a database may be for this build to
  upgrade it directly. An upgrade is deleted from its plugin once every
  supported database is past it, so a database older than the window would
  miss it. Both checks read install records (lib/installLedger.js), never
  people data.

    core     CORE_UPGRADE_FROM (lib/version.js) against the oldest
             `last_install.core` among the plugins `e9core upgrade`
             reinstalls (every upgrade reinstalls them, so the oldest is the
             last full upgrade). A plugin with no record was last installed
             before INSTALL_RECORDS_SINCE.
    plugin   a plugin's `upgradeFrom` (a version of its own package) against
             `last_install.version` on its row. No record: the core check
             covers it.
*/
import semver from 'semver';
import { lastInstallOf } from '../installLedger.js';
import { packageNameOf } from '../pluginPaths.js';
import { CORE_UPGRADE_FROM, INSTALL_RECORDS_SINCE } from '../version.js';

const BEFORE_RECORDS = `before ${INSTALL_RECORDS_SINCE}`;

function throughFix(pkg, from) {
  return `Upgrade with ${pkg}@${from} first (install, deploy, e9core upgrade), then with this release`;
}

/**
 * `refreshedRows`: the plugin rows `e9core upgrade` reinstalls.
 * { status: 'ok' | 'unrecorded' | 'too_old', from, last, reason?, fix? }
 */
export function coreWindow(refreshedRows, from = CORE_UPGRADE_FROM) {
  if (!refreshedRows.length) return { status: 'ok', from, last: null };
  const versions = refreshedRows.map((r) => lastInstallOf(r)?.core);
  if (versions.every((v) => semver.valid(v))) {
    const last = [...versions].sort(semver.compare)[0];
    if (semver.lt(last, from)) {
      return {
        status: 'too_old',
        from,
        last,
        reason: `This database was last upgraded with @engine9/core ${last}. This release upgrades databases from ${from}.`,
        fix: throughFix('@engine9/core', from)
      };
    }
    return { status: 'ok', from, last };
  }
  // A plugin without a record was last installed before core kept records.
  if (semver.lt(from, INSTALL_RECORDS_SINCE)) return { status: 'unrecorded', from, last: BEFORE_RECORDS };
  return {
    status: 'too_old',
    from,
    last: BEFORE_RECORDS,
    reason: `Plugins in this database were last installed by @engine9/core ${BEFORE_RECORDS}. This release upgrades databases from ${from}.`,
    fix: throughFix('@engine9/core', from)
  };
}

/** One plugin row against its plugin's `upgradeFrom`, or null when the plugin declares none. */
export function pluginWindow(row, compiled) {
  const from = compiled?.upgradeFrom;
  if (!from || !semver.valid(from)) return null;
  const last = lastInstallOf(row)?.version;
  if (!semver.valid(last)) return { status: 'unrecorded', from, last: null };
  const pkg = packageNameOf(row.path);
  if (semver.lt(last, from)) {
    return {
      status: 'too_old',
      from,
      last,
      reason: `${row.path} was last installed from ${pkg}@${last}. This build upgrades it from ${from}.`,
      fix: throughFix(pkg, from)
    };
  }
  return { status: 'ok', from, last };
}
