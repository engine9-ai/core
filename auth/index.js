/*
  Engine9 client API key authentication.

  Deliberately isolated from the API handlers so the auth mechanism can be
  upgraded (e.g. to signed tokens) without touching endpoint code.  The API
  layer only depends on the `verify(request-or-key)` contract.

  Keys look like: e9k_<40 hex chars>.  Only the SHA-256 hash of the key is
  stored -- a leaked key store does not reveal usable keys.

  Two stores are provided:
    SqlApiKeyStore -- api_key table managed by the client's SchemaWorker
    KVApiKeyStore  -- Cloudflare Workers KV namespace binding
*/
import crypto from 'node:crypto';

export const API_KEY_PREFIX = 'e9k_';

export function generateApiKey() {
  return `${API_KEY_PREFIX}${crypto.randomBytes(20).toString('hex')}`;
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

/* Extract a key from an incoming request-like object (Fetch API Request,
   Express req, or a plain string). Accepts either
   `Authorization: Bearer e9k_...` or `X-API-Key: e9k_...` */
export function extractApiKey(request) {
  if (!request) return null;
  if (typeof request === 'string') return request;
  const getHeader = (name) => {
    if (typeof request.headers?.get === 'function') return request.headers.get(name);
    // express-style lowercased header object
    return request.headers?.[name.toLowerCase()];
  };
  const auth = getHeader('Authorization') || getHeader('authorization');
  if (auth && auth.indexOf('Bearer ') === 0) return auth.slice('Bearer '.length).trim();
  const headerKey = getHeader('X-API-Key');
  if (headerKey) return headerKey.trim();
  return null;
}

export const API_KEY_SCHEMA = {
  tables: [
    {
      name: 'api_key',
      columns: {
        id: 'id_uuid',
        name: { type: 'string', nullable: false, default_value: '' },
        key_hash: 'hash',
        // JSON array of scope strings, e.g. ["people:write","tables:write","data:read"]
        scopes: 'json',
        active: { type: 'boolean', nullable: false, default_value: true },
        expires_at: 'datetime',
        created_at: 'created_at',
        modified_at: 'modified_at'
      },
      indexes: [
        { columns: 'id', primary: true },
        { columns: 'key_hash', unique: true }
      ]
    }
  ]
};

function normalizeRecord(record) {
  if (!record) return null;
  let scopes = record.scopes;
  if (typeof scopes === 'string') {
    try {
      scopes = JSON.parse(scopes);
    } catch {
      scopes = [];
    }
  }
  return { ...record, scopes: scopes || [] };
}

function checkUsable(record) {
  if (!record) return { valid: false, reason: 'unknown_key' };
  const active = record.active === true || record.active === 1 || record.active === '1';
  if (!active) return { valid: false, reason: 'inactive_key' };
  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return { valid: false, reason: 'expired_key' };
  }
  return { valid: true, key: record };
}

/* SQL-backed store.  `worker` is any client SQLWorker/SchemaWorker. */
export class SqlApiKeyStore {
  constructor({ worker }) {
    if (!worker) throw new Error('SqlApiKeyStore requires a worker');
    this.worker = worker;
  }
  /* Creates the api_key table if needed (client SchemaWorker required) */
  async deploy() {
    if (typeof this.worker.deploy !== 'function') {
      throw new Error('deploy() requires a SchemaWorker instance');
    }
    return this.worker.deploy({ schema: API_KEY_SCHEMA });
  }
  async create({ name = '', scopes = [], expiresAt = null } = {}) {
    const key = generateApiKey();
    const record = {
      id: crypto.randomUUID(),
      name,
      key_hash: hashApiKey(key),
      scopes: JSON.stringify(scopes),
      active: true,
      expires_at: expiresAt
    };
    await this.worker.insertArray({ table: 'api_key', array: [record] });
    // the plaintext key is only available here -- it is never stored
    return { key, id: record.id, name, scopes };
  }
  async lookup(key) {
    const { data } = await this.worker.query({
      sql: 'select id,name,key_hash,scopes,active,expires_at from api_key where key_hash=?',
      values: [hashApiKey(key)]
    });
    return normalizeRecord(data[0]);
  }
  async revoke({ id }) {
    return this.worker.query({ sql: 'update api_key set active=0 where id=?', values: [id] });
  }
  async verify(requestOrKey) {
    const key = extractApiKey(requestOrKey);
    if (!key) return { valid: false, reason: 'missing_key' };
    return checkUsable(await this.lookup(key));
  }
}

/* Cloudflare KV-backed store.  `kv` is a KVNamespace binding.
   Stored under key `apikey:<sha256>` with a JSON record. */
export class KVApiKeyStore {
  constructor({ kv }) {
    if (!kv) throw new Error('KVApiKeyStore requires a kv namespace binding');
    this.kv = kv;
  }
  async create({ name = '', scopes = [], expiresAt = null } = {}) {
    const key = generateApiKey();
    const id = crypto.randomUUID();
    const record = { id, name, scopes, active: true, expires_at: expiresAt };
    await this.kv.put(`apikey:${hashApiKey(key)}`, JSON.stringify(record));
    return { key, id, name, scopes };
  }
  async lookup(key) {
    const raw = await this.kv.get(`apikey:${hashApiKey(key)}`);
    if (!raw) return null;
    return normalizeRecord(JSON.parse(raw));
  }
  async revoke({ keyHash }) {
    const raw = await this.kv.get(`apikey:${keyHash}`);
    if (!raw) return null;
    const record = JSON.parse(raw);
    record.active = false;
    await this.kv.put(`apikey:${keyHash}`, JSON.stringify(record));
    return record;
  }
  async verify(requestOrKey) {
    const key = extractApiKey(requestOrKey);
    if (!key) return { valid: false, reason: 'missing_key' };
    return checkUsable(await this.lookup(key));
  }
}

export default {
  API_KEY_PREFIX,
  API_KEY_SCHEMA,
  generateApiKey,
  hashApiKey,
  extractApiKey,
  SqlApiKeyStore,
  KVApiKeyStore
};
