/*
  Engine9 client API key authentication (auth layer 1).

  Every core API request requires a valid API key. Keys enable/disable access,
  must carry a non-empty scopes list (ceiling), and may set default_role_id
  (layer 2). Use scope `admin` for full access, `public` for inbound/forms.
  Rate limiting / volume checks are extension points keyed by apiKey.id —
  not implemented here; callers can wrap verify() or createApi handle().

  One key system, two prefixes chosen from scopes:
    e9key_<40 hex>        — normal keys (tasks, people, admin, …)
    e9publickey_<40 hex>  — keys with the `public` scope (inbound cache)
  Only the SHA-256 hash is stored in api_key — a leaked store does not reveal
  usable keys.

  Two stores are provided:
    SqlApiKeyStore -- api_key table (created via SQLWorker.createTable or migrations)
    KVApiKeyStore  -- Cloudflare Workers KV namespace binding

  Policy helpers (resolveAuthContext, hasScope, ADMIN_SCOPE) live in ./policy.js.
  HMAC helpers for Delegate tokens live in ./hmac.js.
*/
import crypto from 'node:crypto';
import {
  resolveAuthContext,
  hasScope,
  intersectScopes,
  meetsRequiredAuth,
  assertValidKeyScopes,
  ADMIN_SCOPE,
  PUBLIC_SCOPE
} from './policy.js';
import {
  parseSharedSecrets,
  base64urlEncode,
  base64urlDecode,
  signPayload,
  verifySignedPayload,
  splitSignedToken
} from './hmac.js';

export {
  resolveAuthContext,
  hasScope,
  intersectScopes,
  meetsRequiredAuth,
  assertValidKeyScopes,
  ADMIN_SCOPE,
  PUBLIC_SCOPE
};
export {
  parseSharedSecrets,
  base64urlEncode,
  base64urlDecode,
  signPayload,
  verifySignedPayload,
  splitSignedToken
};

/** Standard API keys (non-public scopes). */
export const API_KEY_PREFIX = 'e9key_';
/** Inbound / public-form keys (`public` scope). Same api_key table. */
export const PUBLIC_API_KEY_PREFIX = 'e9publickey_';

export function isEngine9ApiKeyToken(token) {
  const t = String(token || '');
  return t.indexOf(API_KEY_PREFIX) === 0 || t.indexOf(PUBLIC_API_KEY_PREFIX) === 0;
}

/**
 * Generate a plaintext API key. Prefix follows scopes: `public` → e9publickey_,
 * otherwise e9key_.
 */
export function generateApiKey({ scopes = [] } = {}) {
  const list = Array.isArray(scopes) ? scopes : [];
  const prefix = list.includes(PUBLIC_SCOPE) ? PUBLIC_API_KEY_PREFIX : API_KEY_PREFIX;
  return `${prefix}${crypto.randomBytes(20).toString('hex')}`;
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

const API_KEY_PUBLIC_COLUMNS =
  'id,name,scopes,default_role_id,active,expires_at,created_at,modified_at';
const API_KEY_LOOKUP_COLUMNS = `${API_KEY_PUBLIC_COLUMNS},key_hash`;

/**
 * Known scopes for management UIs and MCP `apiKey` `command: catalog`.
 * Prefix is chosen at create/rotate time from scopes (`public` → e9publickey_).
 */
export const API_KEY_SCOPE_CATALOG = [
  {
    id: 'people:write',
    constant: 'PEOPLE_WRITE',
    surface: 'core',
    allows: 'Inbound people pipeline',
    route: 'POST /people'
  },
  {
    id: 'tables:write',
    constant: 'TABLES_WRITE',
    surface: 'core',
    allows: 'Allowlisted table upserts',
    route: 'POST /upsert/:table'
  },
  {
    id: 'data:read',
    constant: 'DATA_READ',
    surface: 'core',
    allows: 'Configured reads',
    route: 'GET /read/:name'
  },
  {
    id: 'tasks:read',
    constant: 'TASKS_READ',
    surface: 'task',
    allows: 'List and read flows and run status',
    route: 'GET /flows, POST /task_runs/filter, GET /task_runs/:id'
  },
  {
    id: 'tasks:schedule',
    constant: 'TASKS_SCHEDULE',
    surface: 'task',
    allows: 'Schedule and control work',
    route: 'POST /tasks/schedule, POST /flow_runs/, retry/pause/resume/stop'
  },
  {
    id: ADMIN_SCOPE,
    constant: 'ADMIN',
    surface: 'any',
    allows: 'All scopes (full access)',
    route: null
  },
  {
    id: PUBLIC_SCOPE,
    constant: 'PUBLIC',
    surface: 'inbound',
    allows: 'Public ingest / forms',
    route: null
  }
];

function prefixForScopes(scopes = []) {
  const list = Array.isArray(scopes) ? scopes : [];
  return list.includes(PUBLIC_SCOPE) ? PUBLIC_API_KEY_PREFIX : API_KEY_PREFIX;
}

/** Static catalog for key-management UIs. Does not read the database. */
export function getApiKeyCatalog() {
  return {
    prefixes: {
      standard: API_KEY_PREFIX,
      public: PUBLIC_API_KEY_PREFIX
    },
    default_prefix: API_KEY_PREFIX,
    scopes: API_KEY_SCOPE_CATALOG.map((scope) => ({
      ...scope,
      prefix: prefixForScopes([scope.id])
    })),
    fields: [
      { name: 'id', type: 'id_uuid', create: false, update: false },
      { name: 'name', type: 'string', create: true, update: true },
      {
        name: 'scopes',
        type: 'string[]',
        create: true,
        update: true,
        required_on_create: true
      },
      { name: 'default_role_id', type: 'id_uuid', create: true, update: true, nullable: true },
      { name: 'expires_at', type: 'datetime', create: true, update: true, nullable: true },
      { name: 'active', type: 'boolean', create: false, update: true },
      { name: 'created_at', type: 'datetime', create: false, update: false },
      { name: 'modified_at', type: 'datetime', create: false, update: false }
    ],
    plaintext: {
      shown_on: ['create', 'rotate'],
      stored: false,
      note: 'The plaintext key is returned once and never stored. Only the SHA-256 hash is retained.'
    },
    commands: ['catalog', 'list', 'get', 'create', 'update', 'revoke', 'rotate']
  };
}

/* Extract a key from an incoming request-like object (Fetch API Request,
   Express req, or a plain string). Accepts either
   `Authorization: Bearer e9key_…|e9publickey_…` or `X-API-Key`. */
export function extractApiKey(request) {
  if (!request) return null;
  if (typeof request === 'string') return request;
  const getHeader = (name) => {
    if (typeof request.headers?.get === 'function') return request.headers.get(name);
    // express-style lowercased header object
    return request.headers?.[name.toLowerCase()];
  };
  const auth = getHeader('Authorization') || getHeader('authorization');
  if (auth && auth.indexOf('Bearer ') === 0) {
    const token = auth.slice('Bearer '.length).trim();
    // Only treat as API key for Engine9 prefixes — other Bearers
    // (session tokens, Firebase) are left for layer 3 handlers.
    if (isEngine9ApiKeyToken(token)) return token;
    return null;
  }
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
        // JSON array of scope strings (required, non-empty), e.g. ["people:write"] or ["admin"]
        scopes: 'json',
        // Default role_id (segment UUID) when no role is specified on the request/session
        default_role_id: { type: 'id_uuid', nullable: true },
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

function isActiveFlag(value) {
  return value === true || value === 1 || value === '1';
}

function toStoredActive(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw new Error('active must be a boolean');
}

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
  return {
    ...record,
    scopes: scopes || [],
    default_role_id: record.default_role_id || null,
    active: isActiveFlag(record.active)
  };
}

/** Management view — never includes plaintext or key_hash. */
export function toPublicApiKeyRecord(record) {
  const n = normalizeRecord(record);
  if (!n) return null;
  return {
    id: n.id,
    name: n.name || '',
    scopes: n.scopes,
    default_role_id: n.default_role_id,
    active: n.active,
    expires_at: n.expires_at || null,
    created_at: n.created_at || null,
    modified_at: n.modified_at || null
  };
}

function checkUsable(record) {
  if (!record) return { valid: false, reason: 'unknown_key' };
  const active = isActiveFlag(record.active);
  if (!active) return { valid: false, reason: 'inactive_key' };
  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return { valid: false, reason: 'expired_key' };
  }
  return { valid: true, key: record };
}

function createResult(key, record) {
  return {
    key,
    id: record.id,
    name: record.name,
    scopes: typeof record.scopes === 'string' ? JSON.parse(record.scopes) : record.scopes || [],
    default_role_id: record.default_role_id || null
  };
}

/* SQL-backed store.  `worker` is any client SQLWorker. */
export class SqlApiKeyStore {
  constructor({ worker }) {
    if (!worker) throw new Error('SqlApiKeyStore requires a worker');
    this.worker = worker;
  }
  /* Creates the api_key table if needed (SQLWorker.createTable). */
  async deploy() {
    if (typeof this.worker.createTable !== 'function') {
      throw new Error('deploy() requires a SQLWorker instance');
    }
    try {
      await this.worker.describe({ table: 'api_key' });
      return { no_changes: true };
    } catch (e) {
      if (e?.code !== 'DOES_NOT_EXIST') throw e;
    }
    const table = API_KEY_SCHEMA.tables[0];
    const columns = Object.entries(table.columns).map(([name, c]) => {
      const col = typeof c === 'string' ? { type: c } : { ...c };
      return { ...col, name };
    });
    return this.worker.createTable({ table: table.name, columns, indexes: table.indexes });
  }
  async create({ name = '', scopes = [], defaultRoleId = null, expiresAt = null, key: existingKey = null } = {}) {
    const normalizedScopes = assertValidKeyScopes(scopes);
    const key = existingKey || generateApiKey({ scopes: normalizedScopes });
    if (existingKey && !isEngine9ApiKeyToken(existingKey)) {
      throw new Error(`API key must start with ${API_KEY_PREFIX} or ${PUBLIC_API_KEY_PREFIX}`);
    }
    const record = {
      id: crypto.randomUUID(),
      name,
      key_hash: hashApiKey(key),
      scopes: JSON.stringify(normalizedScopes),
      default_role_id: defaultRoleId,
      active: true,
      expires_at: expiresAt
    };
    await this.worker.insertArray({ table: 'api_key', array: [record] });
    // the plaintext key is only available here -- it is never stored
    return createResult(key, record);
  }
  async lookup(key) {
    const { data } = await this.worker.query({
      sql: `select ${API_KEY_LOOKUP_COLUMNS} from api_key where key_hash=?`,
      values: [hashApiKey(key)]
    });
    return normalizeRecord(data[0]);
  }
  async lookupById(id) {
    const { data } = await this.worker.query({
      sql: `select ${API_KEY_LOOKUP_COLUMNS} from api_key where id=?`,
      values: [id]
    });
    return normalizeRecord(data[0]);
  }
  /**
   * List keys for a management UI. Never returns plaintext or key_hash.
   * @param {{ includeInactive?: boolean, name?: string, id?: string, active?: boolean }} [opts]
   */
  async list({ includeInactive = true, name = null, id = null, active } = {}) {
    const where = [];
    const values = [];
    if (id) {
      where.push('id=?');
      values.push(id);
    }
    if (name) {
      where.push('name=?');
      values.push(name);
    }
    if (active !== undefined) {
      where.push('active=?');
      values.push(toStoredActive(active));
    } else if (!includeInactive) {
      where.push('active=?');
      values.push(1);
    }
    const sql = `select ${API_KEY_PUBLIC_COLUMNS} from api_key${
      where.length ? ` where ${where.join(' and ')}` : ''
    } order by name, id`;
    const { data } = await this.worker.query({ sql, values });
    return (data || []).map((row) => toPublicApiKeyRecord(row));
  }
  async get({ id } = {}) {
    if (!id) throw new Error('SqlApiKeyStore.get requires id');
    const record = await this.lookupById(id);
    if (!record) throw new Error(`SqlApiKeyStore.get: unknown key id ${id}`);
    return toPublicApiKeyRecord(record);
  }
  /**
   * Update metadata / permissions without rotating the secret.
   * Changing scopes does not change an existing key's prefix.
   */
  async update({ id, name, scopes, defaultRoleId, expiresAt, active } = {}) {
    if (!id) throw new Error('SqlApiKeyStore.update requires id');
    const old = await this.lookupById(id);
    if (!old) throw new Error(`SqlApiKeyStore.update: unknown key id ${id}`);
    const nextName = name !== undefined ? name : old.name;
    const nextScopes = scopes !== undefined ? assertValidKeyScopes(scopes) : old.scopes;
    const nextRole = defaultRoleId !== undefined ? defaultRoleId || null : old.default_role_id;
    const nextExpires = expiresAt !== undefined ? expiresAt || null : old.expires_at || null;
    const nextActive = active !== undefined ? toStoredActive(active) : toStoredActive(old.active);
    await this.worker.query({
      sql: 'update api_key set name=?, scopes=?, default_role_id=?, expires_at=?, active=? where id=?',
      values: [nextName, JSON.stringify(nextScopes), nextRole, nextExpires, nextActive, id]
    });
    return this.get({ id });
  }
  async revoke({ id }) {
    if (!id) throw new Error('SqlApiKeyStore.revoke requires id');
    const old = await this.lookupById(id);
    if (!old) throw new Error(`SqlApiKeyStore.revoke: unknown key id ${id}`);
    await this.worker.query({ sql: 'update api_key set active=0 where id=?', values: [id] });
    return toPublicApiKeyRecord({ ...old, active: false });
  }
  /**
   * Cycle a key: create a new key (copying metadata from the old when omitted),
   * then revoke the old one. Returns the new plaintext key once.
   */
  async rotate({ id, name, scopes, defaultRoleId, expiresAt } = {}) {
    if (!id) throw new Error('SqlApiKeyStore.rotate requires id of the key to revoke');
    const old = await this.lookupById(id);
    if (!old) throw new Error(`SqlApiKeyStore.rotate: unknown key id ${id}`);
    const created = await this.create({
      name: name !== undefined ? name : old.name,
      scopes: scopes !== undefined ? scopes : old.scopes,
      defaultRoleId: defaultRoleId !== undefined ? defaultRoleId : old.default_role_id,
      expiresAt: expiresAt !== undefined ? expiresAt : old.expires_at || null
    });
    await this.revoke({ id });
    return { ...created, revokedId: id };
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
  async create({ name = '', scopes = [], defaultRoleId = null, expiresAt = null, key: existingKey = null } = {}) {
    const normalizedScopes = assertValidKeyScopes(scopes);
    const key = existingKey || generateApiKey({ scopes: normalizedScopes });
    if (existingKey && !isEngine9ApiKeyToken(existingKey)) {
      throw new Error(`API key must start with ${API_KEY_PREFIX} or ${PUBLIC_API_KEY_PREFIX}`);
    }
    const id = crypto.randomUUID();
    const record = {
      id,
      name,
      scopes: normalizedScopes,
      default_role_id: defaultRoleId,
      active: true,
      expires_at: expiresAt
    };
    await this.kv.put(`apikey:${hashApiKey(key)}`, JSON.stringify(record));
    return createResult(key, record);
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
  /**
   * Cycle a key: create a new key, then revoke the old by keyHash.
   * Pass prior metadata explicitly, or they default to empty.
   */
  async rotate({ keyHash, name, scopes, defaultRoleId, expiresAt } = {}) {
    if (!keyHash) throw new Error('KVApiKeyStore.rotate requires keyHash of the key to revoke');
    const raw = await this.kv.get(`apikey:${keyHash}`);
    const old = raw ? normalizeRecord(JSON.parse(raw)) : null;
    const created = await this.create({
      name: name !== undefined ? name : old?.name || '',
      scopes: scopes !== undefined ? scopes : old?.scopes || [],
      defaultRoleId: defaultRoleId !== undefined ? defaultRoleId : old?.default_role_id || null,
      expiresAt: expiresAt !== undefined ? expiresAt : old?.expires_at || null
    });
    await this.revoke({ keyHash });
    return { ...created, revokedKeyHash: keyHash };
  }
  async verify(requestOrKey) {
    const key = extractApiKey(requestOrKey);
    if (!key) return { valid: false, reason: 'missing_key' };
    return checkUsable(await this.lookup(key));
  }
}

export default {
  API_KEY_PREFIX,
  PUBLIC_API_KEY_PREFIX,
  API_KEY_SCHEMA,
  API_KEY_SCOPE_CATALOG,
  getApiKeyCatalog,
  toPublicApiKeyRecord,
  generateApiKey,
  hashApiKey,
  extractApiKey,
  isEngine9ApiKeyToken,
  SqlApiKeyStore,
  KVApiKeyStore,
  resolveAuthContext,
  hasScope,
  intersectScopes,
  meetsRequiredAuth,
  ADMIN_SCOPE,
  PUBLIC_SCOPE,
  parseSharedSecrets,
  signPayload,
  verifySignedPayload
};
