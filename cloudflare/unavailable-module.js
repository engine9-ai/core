/*
  Alias target for node-only optional dependencies (knex, mysql2,
  better-sqlite3) when bundling for Cloudflare Workers. These are only loaded
  by SQLWorker's non-D1 connection modes, which are never used on Workers.
  A proxy throws a clear error if something does touch them at runtime.
*/
function unavailable() {
  throw new Error('This module is not available in the Cloudflare Workers build; use the D1 connection mode');
}
export default new Proxy(unavailable, {
  get: (target, prop) => (prop === 'then' ? undefined : unavailable),
  apply: unavailable,
  construct: unavailable,
});
