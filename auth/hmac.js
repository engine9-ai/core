/*
  Shared HMAC helpers for Delegate-related signed tokens.

  Canonical copy for `encoded.sig` tokens (base64url payload + HMAC-SHA256).
  Used by core handoff bridge / local sessions; Engine9 API hosts use the same
  shape for session-bridge tokens (see @engine9/server oauthSessionBridge).
  Callers may import these instead of reimplementing crypto.
*/
import crypto from 'node:crypto';

/** Parse DELEGATE_SHARED_SECRET (comma-separated to allow rotation). */
export function parseSharedSecrets(config) {
  if (typeof config !== 'string' || !config.trim()) return [];
  return config.split(',').map((s) => s.trim()).filter(Boolean);
}

export function base64urlEncode(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function base64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/** HMAC-SHA256 over `encoded`, digest as base64url. */
export function signPayload(encoded, secret) {
  return crypto.createHmac('sha256', String(secret)).update(encoded).digest('base64url');
}

/**
 * Verify `encoded.sig` against one or more secrets (rotation).
 * Returns true when any secret matches.
 */
export function verifySignedPayload(encoded, signature, secrets) {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  if (!encoded || !signature || list.length === 0) return false;
  const sigBuf = Buffer.from(String(signature));
  for (const secret of list) {
    if (!secret) continue;
    const expected = signPayload(encoded, secret);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

/**
 * Split `encoded.sig` into parts. Returns null when malformed.
 */
export function splitSignedToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!encoded || !signature) return null;
  return { encoded, signature };
}

export default {
  parseSharedSecrets,
  base64urlEncode,
  base64urlDecode,
  signPayload,
  verifySignedPayload,
  splitSignedToken
};
