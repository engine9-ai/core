/**
 * Compact person-identifier keys.
 *
 * Algorithm:
 *   1. UTF-8 encode the inbound id_value string
 *   2. SHA-256 digest (32 bytes)
 *   3. Truncate to the first 16 bytes (128 bits)
 *
 * Exact uniqueness is not guaranteed; callers accept rare collisions.
 * id_type is a separate namespace in the storage key, not mixed into the hash.
 *
 * Encoding by backend:
 *   - SQLite / D1 compact tables → raw 16-byte Buffer (BLOB)
 *   - Durable Object keys → 32-char lowercase hex (string map keys)
 *   - MySQL collision scan (server PersonWorker) → LOWER(LEFT(SHA2(id_value, 256), 32))
 */
import crypto from 'node:crypto';

const ID_VALUE_HASH_BYTES = 16; // 128 bits

/** @returns {Buffer} first 16 bytes of SHA-256(idValue) */
export function hashIdValueToU128(idValue) {
  return crypto.createHash('sha256').update(String(idValue), 'utf8').digest().subarray(0, ID_VALUE_HASH_BYTES);
}

/** @returns {string} 32-char lowercase hex of hashIdValueToU128(idValue) */
export function hashIdValueToU128Hex(idValue) {
  return hashIdValueToU128(idValue).toString('hex');
}

/** Durable Object storage key for an id_type namespace + hashed id_value. */
export function durableObjectStorageKey(idType, hex128) {
  return `${idType}:${hex128}`;
}

/** Composite map key so id_type namespaces stay distinct in assignPersonIds. */
export function identifierMapKey(idType, idValue) {
  return `${idType}\0${idValue}`;
}

/** Normalize a SQL BLOB / Buffer / hex string to lowercase hex for Map lookups. */
export function u128ToHexKey(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.toLowerCase();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('hex');
  }
  // Cloudflare D1 returns BLOB columns as plain arrays of byte values
  if (Array.isArray(value)) {
    return Buffer.from(value).toString('hex');
  }
  return String(value).toLowerCase();
}
