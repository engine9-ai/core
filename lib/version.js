/*
  This package's version, for install records and status reports. A Worker
  bundle cannot read package.json at run time. test/version.test.js keeps the
  two equal.
*/
export const CORE_VERSION = '1.17.0';

/*
  The upgrade window: the oldest @engine9/core a database can have last been
  upgraded with for this release to upgrade it directly (lib/upgrades/window.js).
  Raise it when core drops code that kept older databases working.
*/
export const CORE_UPGRADE_FROM = '1.9.0';

/* The first release that records each install on its plugin row. A database with no record predates it. */
export const INSTALL_RECORDS_SINCE = '1.17.0';
