/**
 * PERSON_ID_DELEGATE_KV — edge cache of the `person_id_delegate` lookup table.
 *
 * Cloudflare-style deployments only. Pass `{ PERSON_ID_DELEGATE_KV }` as
 * `kvEnv` to `createApi` so Bearer Identity Tokens can resolve person_id
 * from this cache before SQL (`getPersonIdByDomainUnid` / `setDelegatePersonId`).
 *
 * Source of truth remains D1/SQLite (`person_id_delegate` or
 * `person_identifier` with id_type `delegate`). This KV is a read-through /
 * write-through cache for that mapping. The cached id is the Domain UNID
 * (`domain:hex`, the Identity Token `sub`) — never the UNID.
 *
 * Key convention:
 *   delegate:<domain_unid>  -> "<person_id>"
 *   person:<person_id>      -> "<domain_unid>"   (reverse lookup)
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

/** Cache that a Domain UNID maps to `personId`. */
export async function setDelegatePersonId(env, domainUnid, personId) {
  const pid = String(personId);
  await Promise.all([
    env.PERSON_ID_DELEGATE_KV.put(delegateKey(domainUnid), pid),
    env.PERSON_ID_DELEGATE_KV.put(personKey(pid), domainUnid),
  ]);
}

/** Look up person_id for a Domain UNID. */
export async function getPersonIdByDomainUnid(env, domainUnid) {
  return env.PERSON_ID_DELEGATE_KV.get(delegateKey(domainUnid), 'text');
}

/** Reverse: the Domain UNID cached for this person_id. */
export async function getDomainUnidByPersonId(env, personId) {
  return env.PERSON_ID_DELEGATE_KV.get(personKey(String(personId)), 'text');
}

/** Drop the cached mapping for one Domain UNID (if present). */
export async function deleteDelegatePersonId(env, domainUnid) {
  const personId = await getPersonIdByDomainUnid(env, domainUnid);
  const deletes = [env.PERSON_ID_DELEGATE_KV.delete(delegateKey(domainUnid))];
  if (personId) deletes.push(env.PERSON_ID_DELEGATE_KV.delete(personKey(personId)));
  await Promise.all(deletes);
}
