/**
 * Cloudflare-only KV cache helpers.
 *
 * These namespaces exist only on Cloudflare-style deployments of @engine9/core
 * (Workers + D1 + KV). Generic Node / MySQL deployments do not use them —
 * they read `person_id_delegate` and `person_segment` directly from SQL.
 *
 * Not wired into the API or PersonWorker yet; import from
 * `@engine9/core/cloudflare/kv` when adding edge cache paths.
 */

export {
  setDelegatePersonId,
  getPersonIdByUnid,
  getUnidByPersonId,
  deleteDelegatePersonId,
} from './personIdDelegate.js';

export {
  addToSegment,
  removeFromSegment,
  isInSegment,
  listSegmentMembers,
} from './personSegment.js';
