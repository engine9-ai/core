/*
  Shared HMAC helpers for Delegate-related signed tokens.

  Canonical copy for `encoded.sig` tokens (base64url payload + HMAC-SHA256).
  Used by local sessions; Engine9 API hosts use the same
  shape for session-bridge tokens (see @engine9/server oauthSessionBridge).
  Callers may import these instead of reimplementing crypto.
*/
import crypto from 'node:crypto';

/*
  Signing secrets (SESSION_SECRET, AGENT_CREDENTIALS_SECRET) are 32 random
  bytes written as 64 hex characters, which is what `e9core setup-keys` and
  `openssl rand -hex 32` produce. Anyone who signs in once holds a token
  signed with the secret and can test guesses against it offline, with no
  rate limit, so a value a person chose falls quickly. The shape check
  cannot prove a value is random; it refuses anything a person would type.
*/
const SIGNING_SECRET_SHAPE = /^[0-9a-f]{64}$/i;
// 64 random hex characters use fewer than 10 of the 16 digits about once in 10^12.
const SIGNING_SECRET_MIN_DISTINCT = 10;

/** A new signing secret: 32 random bytes as 64 hex characters. */
export function generateSigningSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** Why `value` cannot be a signing secret, or null when it can. */
export function signingSecretProblem(value) {
  if (typeof value !== 'string' || value === '') return 'is not set';
  if (!SIGNING_SECRET_SHAPE.test(value)) return 'is not 64 hex characters (32 random bytes)';
  if (new Set(value.toLowerCase()).size < SIGNING_SECRET_MIN_DISTINCT) return 'repeats too few characters to be random';
  return null;
}

/** The message for a bad signing secret named `name`, with the fix. */
export function signingSecretMessage(name, problem) {
  return `${name} ${problem}. Do not choose one: npx e9core setup-keys writes one to .env, and setup-keys --remote gives each Cloudflare environment its own. On your own servers, use the output of openssl rand -hex 32.`;
}

/** Parse a comma-separated secret list (rotation: current, then previous). */
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
