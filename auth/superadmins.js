/*
  Superadmins: people engine9 recognizes as admin of every account a process
  serves, listed by verified email in a file instead of in any database.

  admin       a member of the account's `admin` role segment (person_segment
              in that account's own database). One account only.
  superadmin  an email on this list. Never stored in a database. On a core
              site it acts as that site's `admin` role; on the engine9
              server it opens every catalog account.

  The file is JSON:

      { "superadmins": ["chris@example.com"] }

  This module is pure (no disk, no network) so the Cloudflare bundle can
  import it. Reading the file is bin/superadminsFile.js
  (`@engine9/core/superadmins/node`).

  A match needs a verified email (session.email is set only for verified
  emails) and an Identity Level of at least SUPERADMIN_MIN_LEVEL.
*/

/** Lowest Identity Level at which a listed email is a superadmin. */
export const SUPERADMIN_MIN_LEVEL = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeSuperadminEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email && EMAIL_RE.test(email) ? email : '';
}

/**
 * Normalize a list of emails, or a `{ superadmins: [...] }` document, to a
 * sorted, de-duplicated array of lowercase emails. Throws on a value that is
 * not an email so a typo in the file is loud, not a silent lockout.
 */
export function normalizeSuperadmins(input) {
  let list = input;
  if (input == null) return [];
  if (!Array.isArray(input)) {
    if (typeof input !== 'object') throw new Error('superadmins must be an array or { superadmins: [...] }');
    list = input.superadmins ?? [];
  }
  if (!Array.isArray(list)) throw new Error('superadmins must be an array of email addresses');
  const out = new Set();
  for (const raw of list) {
    if (typeof raw === 'string' && !raw.trim()) continue;
    const email = normalizeSuperadminEmail(raw);
    if (!email) throw new Error(`superadmins: not an email address: ${raw}`);
    out.add(email);
  }
  return [...out].sort();
}

/** Comma, semicolon, or whitespace separated emails (the `E9_SUPERADMINS` variable). */
export function superadminsFromText(text) {
  const tokens = String(text || '')
    .split(/[\s,;]+/)
    .filter(Boolean);
  return normalizeSuperadmins(tokens);
}

/** The list now: an array, or a function returning one (read on each call). */
export function currentSuperadmins(source) {
  const value = typeof source === 'function' ? source() : source;
  return normalizeSuperadmins(value);
}

/**
 * True when `email` is on the list and the credential is at least
 * `minLevel`. `list` may be an array, a document, or a function.
 */
export function isSuperadmin(list, email, level, { minLevel = SUPERADMIN_MIN_LEVEL } = {}) {
  const mail = normalizeSuperadminEmail(email);
  if (!mail) return false;
  const n = Number(level);
  if (!Number.isFinite(n) || n < minLevel) return false;
  return currentSuperadmins(list).includes(mail);
}

export default {
  SUPERADMIN_MIN_LEVEL,
  normalizeSuperadminEmail,
  normalizeSuperadmins,
  superadminsFromText,
  currentSuperadmins,
  isSuperadmin
};
