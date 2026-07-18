/**
 * PERSON_ID_DELEGATE_KV — edge cache of the `person_id_delegate` lookup table.
 *
 * Cloudflare-style deployments only. Not wired into PersonWorker / the API
 * yet; this module is the cache access layer for a future edge path that
 * mirrors `person_id_<id_type>` (id_type = `delegate`) without hitting D1.
 *
 * Source of truth remains D1/SQLite (`person_id_delegate` or
 * `person_identifier` with id_type `delegate`). This KV is a read-through /
 * write-through cache for that mapping.
 *
 * Key convention:
 *   unid:<unid>           -> "<person_id>"     (delegate UNID -> person)
 *   person:<person_id>    -> "<unid>"          (reverse lookup)
 *
 * @typedef {object} DelegateIdEnv
 * @property {KVNamespace} PERSON_ID_DELEGATE_KV
 */

function unidKey(unid) {
  return `unid:${unid}`;
}

function personKey(personId) {
  return `person:${personId}`;
}

/** Cache that `unid` maps to `personId` (writes both directions). */
export async function setDelegatePersonId(env, unid, personId) {
  const pid = String(personId);
  await Promise.all([
    env.PERSON_ID_DELEGATE_KV.put(unidKey(unid), pid),
    env.PERSON_ID_DELEGATE_KV.put(personKey(pid), unid),
  ]);
}

/** Look up person_id for a delegate UNID. */
export async function getPersonIdByUnid(env, unid) {
  return env.PERSON_ID_DELEGATE_KV.get(unidKey(unid), 'text');
}

/** Reverse: which UNID owns this person_id. */
export async function getUnidByPersonId(env, personId) {
  return env.PERSON_ID_DELEGATE_KV.get(personKey(String(personId)), 'text');
}

/** Drop both directions of a cached mapping (if present). */
export async function deleteDelegatePersonId(env, unid) {
  const personId = await getPersonIdByUnid(env, unid);
  const deletes = [env.PERSON_ID_DELEGATE_KV.delete(unidKey(unid))];
  if (personId) deletes.push(env.PERSON_ID_DELEGATE_KV.delete(personKey(personId)));
  await Promise.all(deletes);
}
