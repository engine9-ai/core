/*
  Page gate for a site's own Worker (or any fetch handler): is this browser
  signed in, and does it hold a role right now?

    import { requireRole } from '@engine9/core/auth/gate';

    const gate = await requireRole({ auth, request, role: 'admin' });
    if (!gate.ok) return gate.response;     // a redirect to sign in, or a 403
    // gate.session is the verified Core Session

  `auth` is a createDelegateAuth() object. When core's `createApi` builds it for
  you, it is `api.delegateAuth`. The session is the cookie `/api/auth/callback`
  sets (`e9_session`), so `GET /api/auth/start?returnTo=/` followed by this
  gate is a complete pre-launch lock: one link, no script.

  The role is read from `person_segment` now (`auth.rolesForSession`), never from
  the copy inside the cookie (PERMISSIONS.md PL-8), and the role's
  `requiredAuth` (Identity Level, two-factor) is enforced. Removing a person
  from the role ends their access on the next request.

  A signed-in person without the role is never sent to sign in again: that
  goes straight back through Delegate with the same address, and the person
  loops with nothing on screen. They get a 403 that says who they are signed
  in as and links to Delegate's share screen (`changeSignInUrl`, with
  `reason=access_denied`) to pick another address or account.

  A page load gets a redirect or an HTML page. `fetch()` from page code gets
  JSON with the same links (`signInUrl`, `changeUrl`), so a single-page app
  can show its own message. A site that wants its own 403 page builds it from
  the result's `reason`, `email`, `role`, and `changeUrl`.

  This is a server-side check. It does not turn a static page into a secret
  unless the Worker runs it before serving that page.
*/
import { meetsRequiredAuth } from './policy.js';
import { resolveRoleId } from './delegate.js';
import {
  DEFAULT_SESSION_COOKIE,
  DEFAULT_START_PATH,
  changeSignInUrl,
  isPageRequest,
  safeReturnPath,
  sessionTokenFromCookie,
  signInUrl
} from './signIn.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function redirectTo(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function forbiddenPage({ email, role, reason, changeUrl }) {
  const roleName = escapeHtml(role || 'people with access');
  const who = email
    ? `You are signed in as <strong>${escapeHtml(email)}</strong>.`
    : 'You are signed in, but without a confirmed email address.';
  const why =
    reason === 'auth_not_met'
      ? `This page needs a stronger sign-in for ${roleName} than this one, such as Google instead of an emailed link.`
      : `That sign-in does not have ${roleName} access to this page.`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not allowed</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>You don't have access to this page</h1><p>${who} ${why}</p><p><a href="${escapeHtml(changeUrl)}" style="display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:#1a73e8;color:#fff;font-weight:600;text-decoration:none">Use a different email or account</a></p><p style="color:#555;font-size:14px">What you see on this site follows the address you sign in with. If this is the right address, ask the site's administrator to give it access.</p></body></html>`;
  return new Response(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/** The verified Core Session in this request's cookie, or null. */
export async function sessionFromRequest({ auth, request, cookieName = DEFAULT_SESSION_COOKIE }) {
  const token = sessionTokenFromCookie(request.headers.get('cookie'), cookieName);
  if (!token) return null;
  return auth.verifySession(token);
}

/**
 * Require a signed-in browser, and a role when `role` is given.
 *
 * Returns `{ ok: true, session, roles }`, or
 * `{ ok: false, status, reason, response, signInUrl, changeUrl, email?, role? }`
 * where `response` is ready to return:
 *
 * - signed out (`reason: 'sign_in_required'`): a 302 to sign in for a page
 *   load (GET, HEAD), else a 401 JSON `{ error, reason, signInUrl }`;
 * - signed in without the role (`role_not_held`), or holding it below its
 *   `requiredAuth` (`auth_not_met`): a 403 page for a page load, else a 403
 *   JSON `{ error, reason, role, email, changeUrl }`. Never a redirect to
 *   sign in: that would loop.
 *
 * @param {object} opts
 * @param {object} opts.auth        createDelegateAuth() object (`api.delegateAuth`)
 * @param {Request} opts.request
 * @param {string|string[]} [opts.role]  role name or id from `auth.roleRegistry` (`'admin'`),
 *                                    or several: holding any one of them is enough
 * @param {string} [opts.cookieName]  default `e9_session`
 * @param {string} [opts.startPath]   sign-in route, default `/api/auth/start`
 * @param {boolean} [opts.page]       answer as a page load (redirect, HTML) or as `fetch()`
 *                                    (JSON). Default `isPageRequest(request)`
 */
export async function requireRole({
  auth,
  request,
  role,
  cookieName = DEFAULT_SESSION_COOKIE,
  startPath = DEFAULT_START_PATH,
  page
}) {
  if (!auth) throw new Error('requireRole requires auth (createDelegateAuth, or api.delegateAuth)');
  if (!request) throw new Error('requireRole requires request');
  const wanted = (Array.isArray(role) ? role : role ? [role] : []).map((name) => {
    const id = resolveRoleId(auth.roleRegistry, name);
    if (!id) {
      throw new Error(
        `requireRole: unknown role '${name}'. Configure it in createApi({ config: { roles } }), for example roles: 'standard'.`
      );
    }
    return id;
  });

  const url = new URL(request.url);
  const here = safeReturnPath(`${url.pathname}${url.search}`, { fallback: '/' });
  const startUrl = signInUrl(here, { startPath });
  const changeUrl = changeSignInUrl(here, { startPath, reason: 'access_denied' });
  const asPage = page ?? isPageRequest(request);

  const session = await sessionFromRequest({ auth, request, cookieName });
  if (!session) {
    const method = request.method.toUpperCase();
    const reason = 'sign_in_required';
    if (asPage && (method === 'GET' || method === 'HEAD')) {
      return { ok: false, status: 302, reason, signInUrl: startUrl, changeUrl, response: redirectTo(startUrl) };
    }
    return {
      ok: false,
      status: 401,
      reason,
      signInUrl: startUrl,
      changeUrl,
      response: jsonResponse(401, { error: 'sign in required', reason, signInUrl: startUrl })
    };
  }

  const roles = await auth.rolesForSession(session);
  if (wanted.length) {
    const credential = { level: session.level, twoFactor: Boolean(session.auth?.twoFactor) };
    const held = wanted.filter((id) => roles.includes(id));
    const allowed = held.some((id) => meetsRequiredAuth(auth.roleRegistry[id]?.requiredAuth, credential));
    if (!allowed) {
      const reason = held.length ? 'auth_not_met' : 'role_not_held';
      const roleName = (held.length ? held : wanted)
        .map((id) => auth.roleRegistry[id]?.name || id)
        .join(' or ');
      const email = session.email || null;
      return {
        ok: false,
        status: 403,
        reason,
        role: roleName,
        email,
        signInUrl: startUrl,
        changeUrl,
        response: asPage
          ? forbiddenPage({ email, role: roleName, reason, changeUrl })
          : jsonResponse(403, { error: 'not allowed', reason, role: roleName, email, changeUrl })
      };
    }
  }
  return { ok: true, session: { ...session, roles }, roles };
}

/** `requireRole` with `auth` and the cookie settings fixed once. */
export function createGate({ auth, cookieName, startPath } = {}) {
  return {
    requireRole: (request, role) => requireRole({ auth, request, role, cookieName, startPath }),
    session: (request) => sessionFromRequest({ auth, request, cookieName })
  };
}
