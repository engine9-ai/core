/*
  A short fingerprint of a plugin's schema as written (before a dialect
  standardizes it) and its table prefix. Install records it; status compares
  it with the deployed code to tell whether the code changed since the last
  install.
*/
import crypto from 'node:crypto';
import { stableStringify } from './utilities.js';

/** 16 hex characters; null for a plugin with no schema. */
export function schemaHash(schema, prefix = '') {
  if (!schema || typeof schema !== 'object') return null;
  return crypto
    .createHash('sha256')
    .update(stableStringify({ schema, prefix: prefix || '' }))
    .digest('hex')
    .slice(0, 16);
}
