/**
 * Cloudflare Durable Object class for compact person identifier lookups.
 *
 * DO storage is a string-keyed KV map (not SQL columns), so keys stay text:
 *   `{id_type}:{u128hex}` → person_id (number)
 * First-wins on put.
 *
 * Bind in wrangler, e.g.:
 *   [[durable_objects.bindings]]
 *   name = "PERSON_IDS"
 *   class_name = "PersonIdentifierDO"
 */
import { durableObjectStorageKey } from './hash.js';

export class PersonIdentifierDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'POST' && path === '/find') {
      const body = await request.json();
      const keys = body.keys || [];
      if (keys.length === 0) return Response.json({ entries: [] });
      const map = await this.state.storage.get(keys);
      const entries = [];
      for (const key of keys) {
        const personId = map.get(key);
        if (personId == null) continue;
        entries.push({ key, person_id: Number(personId) });
      }
      return Response.json({ entries });
    }

    if (request.method === 'POST' && path === '/put') {
      const body = await request.json();
      const puts = body.entries || [];
      let written = 0;
      let skipped = 0;
      await this.state.storage.transaction(async (txn) => {
        for (const { key, person_id } of puts) {
          if (!key || person_id == null) continue;
          const existing = await txn.get(key);
          if (existing != null) {
            skipped += 1;
            continue;
          }
          await txn.put(key, Number(person_id));
          written += 1;
        }
      });
      return Response.json({ written, skipped });
    }

    return new Response('Not found', { status: 404 });
  }
}

/** Build a DO storage key from id_type + already-hashed hex (exported for tests/helpers). */
export { durableObjectStorageKey };
