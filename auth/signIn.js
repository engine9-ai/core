/*
  Server-side sign-in helpers shared by the API routes (`GET /auth/start`,
  `GET /auth/callback`, api/index.js) and the page gate (auth/gate.js).

  No secrets and no database here: cookie names, same-origin return paths,
  and the Core Session cookie.
*/
import { createSessionCookieHeaders, readCookie } from './delegate.js';

/** Cookie the Core Session is delivered in by /auth/callback. */
export const DEFAULT_SESSION_COOKIE = 'e9_session';

const MAX_RETURN_PATH = 2000;

/**
 * A path on this site, or `fallback`. Only a path (`/members?x=1#top`) is
 * accepted: no other host, no `//host`, no backslash tricks, no control
 * characters. A full URL on `origin` is reduced to its path. This is what
 * keeps `returnTo` from being an open redirect.
 */
export function safeReturnPath(value, { origin, fallback = '/' } = {}) {
  if (typeof value !== 'string' || !value) return fallback;
  let candidate = value.trim();
  if (origin && /^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.origin !== origin) return fallback;
      candidate = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return fallback;
    }
  }
  if (candidate.length > MAX_RETURN_PATH) return fallback;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  return candidate;
}

/** `path` with one more query parameter, keeping its hash. */
export function withQueryParam(path, name, value) {
  const url = new URL(path, 'http://site.invalid');
  url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An address-shaped `login_hint`, or undefined. */
export function plausibleEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/** The Core Session token from a Cookie request header, or null. */
export function sessionTokenFromCookie(cookieHeader, cookieName = DEFAULT_SESSION_COOKIE) {
  const raw = readCookie(cookieHeader, cookieName);
  return raw || null;
}

/** Set-Cookie value that delivers a Core Session. HttpOnly, SameSite=Lax, Secure on https. */
export function sessionCookie(token, { cookieName = DEFAULT_SESSION_COOKIE, maxAge = 86400, secure } = {}) {
  return createSessionCookieHeaders(token, { cookieName, maxAge, secure: Boolean(secure) });
}

/** Set-Cookie value that removes the Core Session cookie. */
export function clearSessionCookie({ cookieName = DEFAULT_SESSION_COOKIE, secure } = {}) {
  return `${cookieName}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
}
