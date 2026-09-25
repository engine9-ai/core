/**
 * Cloudflare-only KV cache helpers.
 *
 * These namespaces exist only on Cloudflare-style deployments of @engine9/core
 * (Workers + D1 + KV). Generic Node / MySQL deployments do not use them —
 * they read `person_id_delegate` and `person_segment` directly from SQL.
 *
 * Pass the Worker `env` as `kvEnv` to `createApi` so Identity Token
 * requests can cache Domain UNID → person_id (`PERSON_ID_DELEGATE_KV`) at the edge.
 * Import helpers from `@engine9/core/cloudflare/kv`.
 */

export {
  setDelegatePersonId,
  getPersonIdByDomainUnid,
  getDomainUnidByPersonId,
  deleteDelegatePersonId,
} from './personIdDelegate.js';

export {
  addToSegment,
  removeFromSegment,
  isInSegment,
  listSegmentMembers,
} from './personSegment.js';
