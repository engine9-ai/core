/**
 * PERSON_ID_DELEGATE_KV — edge cache of the `person_id_delegate` lookup table.
 *
 * Cloudflare-style deployments only. Pass `{ PERSON_ID_DELEGATE_KV }` as
 * `kvEnv` to `createApi` so Bearer Identity Tokens can resolve person_id
 * from this cache before SQL (`getPersonIdByUnid` / `setDelegatePersonId`).
 *
 * Source of truth remains D1/SQLite (`person_id_delegate` or
 * `person_identifier` with id_type `delegate`). This KV is a read-through /
 * write-through cache for that mapping. The cached id is the Domain
 * Pseudonym, and the Profile subject when one was shared — not the UNID.
 *
 * Key convention:
 *   delegate:<id>         -> "<person_id>"
 *   person:<person_id>    -> "<id>"            (reverse lookup, primary id)
 *
 * @typedef {object} DelegateIdEnv
 * @property {KVNamespace} PERSON_ID_DELEGATE_KV
 */

function delegateKey(id) {
  return `delegate:${id}`;
}

function personKey(personId) {
  return `person:${personId}`;
}

/** Cache that a Pseudonym or subject maps to `personId`. */
export async function setDelegatePersonId(env, id, personId, subject) {
  const pid = String(personId);
  const writes = [
    env.PERSON_ID_DELEGATE_KV.put(delegateKey(id), pid),
    env.PERSON_ID_DELEGATE_KV.put(personKey(pid), id),
  ];
  if (subject && subject !== id) {
    writes.push(env.PERSON_ID_DELEGATE_KV.put(delegateKey(subject), pid));
  }
  await Promise.all(writes);
}

/** Look up person_id for a Pseudonym or Profile subject. */
export async function getPersonIdByUnid(env, id) {
  return env.PERSON_ID_DELEGATE_KV.get(delegateKey(id), 'text');
}

/** Reverse: the primary delegate id cached for this person_id. */
export async function getUnidByPersonId(env, personId) {
  return env.PERSON_ID_DELEGATE_KV.get(personKey(String(personId)), 'text');
}

/** Drop the cached mapping for one delegate id (if present). */
export async function deleteDelegatePersonId(env, id) {
  const personId = await getPersonIdByUnid(env, id);
  const deletes = [env.PERSON_ID_DELEGATE_KV.delete(delegateKey(id))];
  if (personId) deletes.push(env.PERSON_ID_DELEGATE_KV.delete(personKey(personId)));
  await Promise.all(deletes);
}
