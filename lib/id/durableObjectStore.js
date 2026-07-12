/**
 * Client for Cloudflare Durable Object person identifier storage.
 * One DO instance per account (idFromName(accountId)).
 */
import { hashIdValueToU128Hex, durableObjectStorageKey } from './hash.js';

function normalizePersonId(raw) {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function getStub(namespace, accountId) {
  const id = namespace.idFromName(String(accountId));
  return namespace.get(id);
}

export function createDurableObjectIdentifierStore({ namespace, accountId }) {
  if (!namespace) throw new Error('createDurableObjectIdentifierStore requires a Durable Object namespace binding');
  if (!accountId) throw new Error('createDurableObjectIdentifierStore requires accountId');

  return {
    async findByIdentifiers(entries) {
      if (!entries?.length) return [];
      const keyed = [];
      for (const e of entries) {
        if (!e?.id_type || e.id_value == null || e.id_value === '') continue;
        const hex = hashIdValueToU128Hex(e.id_value);
        const key = durableObjectStorageKey(e.id_type, hex);
        keyed.push({ ...e, key });
      }
      if (keyed.length === 0) return [];

      const stub = getStub(namespace, accountId);
      const res = await stub.fetch('https://person-ids/find', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: keyed.map((k) => k.key) })
      });
      if (!res.ok) {
        throw new Error(`PersonIdentifierDO find failed: ${res.status} ${await res.text()}`);
      }
      const { entries: found } = await res.json();
      const byKey = new Map((found || []).map((f) => [f.key, f.person_id]));
      const results = [];
      for (const k of keyed) {
        const personId = normalizePersonId(byKey.get(k.key));
        if (personId == null) continue;
        results.push({
          id_type: k.id_type,
          id_value: k.id_value,
          person_id: personId
        });
      }
      return results;
    },

    async insertIdentifiers(rows) {
      if (!rows?.length) return;
      const puts = [];
      for (const row of rows) {
        if (!row?.id_type || row.id_value == null || row.id_value === '') continue;
        const personId = normalizePersonId(row.person_id);
        if (personId == null) continue;
        const hex = hashIdValueToU128Hex(row.id_value);
        puts.push({
          key: durableObjectStorageKey(row.id_type, hex),
          person_id: personId
        });
      }
      if (puts.length === 0) return;

      const stub = getStub(namespace, accountId);
      const res = await stub.fetch('https://person-ids/put', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: puts })
      });
      if (!res.ok) {
        throw new Error(`PersonIdentifierDO put failed: ${res.status} ${await res.text()}`);
      }
    }
  };
}
