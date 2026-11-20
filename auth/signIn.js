/*
  Server-side sign-in helpers shared by the API routes (`GET /auth/start`,
  `GET /auth/callback`, api/index.js) and the page gate (auth/gate.js).

  No secrets and no database here: cookie names, same-origin return paths,
  and the Core Session cookie.
*/
import { createSessionCookieHeaders, readCookie } from './delegate.js';
import { LOGIN_MIN_LEVEL } from './logins.js';

/**
 * The Identity Level core asks Delegate for: `config.signIn.minLevel`, never
 * below 2. People who do not sign in are never sent to Delegate.
 */
export function signInMinLevel(signIn = {}) {
  const asked = Number(signIn?.minLevel);
  return Number.isFinite(asked) && asked > LOGIN_MIN_LEVEL ? asked : LOGIN_MIN_LEVEL;
}

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

/** The route `createApi` serves that starts a sign-in (`GET /auth/start` under `/api`). */
export const DEFAULT_START_PATH = '/api/auth/start';

function startLink(startPath, params) {
  const url = new URL(startPath || DEFAULT_START_PATH, 'http://site.invalid');
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.origin === 'http://site.invalid' ? `${url.pathname}${url.search}` : url.toString();
}

/**
 * Link that signs this browser in and comes back to `returnTo`, a path on
 * this site (`/api/auth/start?returnTo=/members`).
 */
export function signInUrl(returnTo, { startPath = DEFAULT_START_PATH } = {}) {
  return startLink(startPath, { returnTo: safeReturnPath(returnTo) });
}

/**
 * Link that lets a signed-in person sign in with another address or
 * account, then comes back to `returnTo`. Delegate shows its share screen
 * (`prompt=select`) instead of returning the address it remembered.
 *
 * Pass `reason: 'access_denied'` from an access-denied page: Delegate then
 * tells the person, in its own words, that this site did not let them in
 * with the address they shared. Leave it out on an ordinary "Change your
 * login email" link.
 */
export function changeSignInUrl(returnTo, { startPath = DEFAULT_START_PATH, reason } = {}) {
  return startLink(startPath, {
    returnTo: safeReturnPath(returnTo),
    prompt: 'select',
    reason: reason === 'access_denied' ? reason : undefined
  });
}

/**
 * True when a person is loading a page (a link, a form, the address bar),
 * false for page code calling `fetch()`. A page gets a redirect or an HTML
 * page. `fetch()` gets JSON it can act on: a redirect to Delegate inside
 * `fetch()` fails as a CORS error the visitor never sees.
 */
export function isPageRequest(request) {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  return !accept.includes('application/json');
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The sign-in stops (auth/logins.js) and what the Login button says for each. */
export const LOGIN_STOP_TEXT = {
  login_reassigned: {
    title: 'Ask the site\'s administrator',
    text: "This address signs in to an account here through a different Delegate account. Ask the site's administrator."
  },
  login_locked: {
    title: 'This sign-in is turned off',
    text: "This sign-in is turned off. Ask the site's administrator."
  },
  // The database has no @engine9/schemas/login. For the site's owner, not the visitor.
  sign_in_off: {
    title: 'This site does not have sign-in yet',
    text: "This site does not have sign-in yet. If you run this site, add the login plugin: npx e9core upgrade --plugin @engine9/schemas/login"
  }
};

/**
 * The no-JavaScript fallback of the Login button's stop dialog, served by
 * core's /api/auth/callback. Same words and choices as the button; a site
 * adds no page or link of its own for these.
 */
export function loginStopPage({ reason, differentUrl }) {
  const text = LOGIN_STOP_TEXT[reason] || LOGIN_STOP_TEXT.login_locked;
  const button = (href, label, primary) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;margin:.25rem .5rem .25rem 0;padding:.6rem 1rem;border-radius:.5rem;${primary ? 'background:#1a73e8;color:#fff' : 'border:1px solid #1a73e8;color:#1a73e8'};font-weight:600;text-decoration:none">${escapeHtml(label)}</a>`;
  const body = `<p>${escapeHtml(text.text)}</p>${differentUrl ? `<p>${button(differentUrl, 'Use a different email or account', false)}</p>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(text.title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(text.title)}</h1>${body}</body></html>`;
}

function plainPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

/**
 * The page a sign-in link opens (GET /api/auth/link). Opening it changes
 * nothing: email scanners open every link, so signing in takes the button,
 * a POST from this page.
 */
export function signInLinkPage({ email, action, token }) {
  return plainPage(
    'Sign in',
    `<p>Sign in as <strong>${escapeHtml(email)}</strong>.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit" style="padding:.6rem 1rem;border:0;border-radius:.5rem;background:#1a73e8;color:#fff;font:inherit;font-weight:600;cursor:pointer">Sign in</button></form>`
  );
}

/** A sign-in link that cannot be used: the reason in words, and no address. */
export function signInLinkProblemPage(message) {
  return plainPage('This link cannot sign you in', `<p>${escapeHtml(message)}</p>`);
}
