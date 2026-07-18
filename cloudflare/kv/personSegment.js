/**
 * PERSON_SEGMENT_VK — edge cache of the `person_segment` membership table.
 *
 * Cloudflare-style deployments only. Not wired into PersonWorker / the API
 * yet; this module is the cache access layer for a future edge path that
 * mirrors `person_segment` without hitting D1.
 *
 * Source of truth remains D1/SQLite (`person_segment`). This KV is a
 * read-through / write-through cache for membership checks.
 *
 * Key convention:
 *   seg:<segment_id>:<person_id>  -> "<joinedAt ISO>"   (existence = member)
 */

function segKey(segmentId, personId) {
  return `seg:${segmentId}:${personId}`;
}

/** Record that `personId` is a member of `segmentId`. */
export async function addToSegment(env, segmentId, personId) {
  await env.PERSON_SEGMENT_VK.put(
    segKey(segmentId, String(personId)),
    new Date().toISOString(),
  );
}

/** Remove membership. */
export async function removeFromSegment(env, segmentId, personId) {
  await env.PERSON_SEGMENT_VK.delete(segKey(segmentId, String(personId)));
}

/** True when `personId` is a member of `segmentId`. */
export async function isInSegment(env, segmentId, personId) {
  return (
    (await env.PERSON_SEGMENT_VK.get(segKey(segmentId, String(personId)))) !== null
  );
}

/** List person_ids that belong to a segment. */
export async function listSegmentMembers(env, segmentId) {
  const prefix = `seg:${segmentId}:`;
  const out = [];
  let cursor;
  do {
    const page = await env.PERSON_SEGMENT_VK.list({ prefix, cursor });
    for (const key of page.keys) out.push(key.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
