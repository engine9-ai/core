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

  This is a server-side check. It does not turn a static page into a secret
  unless the Worker runs it before serving that page.
*/
import { meetsRequiredAuth } from './policy.js';
import { resolveRoleId } from './delegate.js';
import { DEFAULT_SESSION_COOKIE, safeReturnPath, sessionTokenFromCookie } from './signIn.js';

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

function forbiddenPage({ email, role, startUrl }) {
  const who = email ? ` as ${escapeHtml(email)}` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not allowed</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Not allowed</h1><p>You are signed in${who}, but this page is only for ${escapeHtml(role || 'people with access')}.</p><p><a href="${escapeHtml(startUrl)}">Sign in again</a></p></body></html>`;
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
 * Returns `{ ok: true, session, roles }`, or `{ ok: false, status, response }`
 * where `response` is ready to return: a 302 to sign in for a signed-out page
 * request (GET, HEAD), a 401 JSON for any other signed-out request, or a 403
 * page for a signed-in person without the role.
 *
 * @param {object} opts
 * @param {object} opts.auth        createDelegateAuth() object (`api.delegateAuth`)
 * @param {Request} opts.request
 * @param {string} [opts.role]      role name or id from `auth.roleRegistry` (`'admin'`)
 * @param {string} [opts.cookieName]  default `e9_session`
 * @param {string} [opts.startPath]   sign-in route, default `/api/auth/start`
 */
export async function requireRole({
  auth,
  request,
  role,
  cookieName = DEFAULT_SESSION_COOKIE,
  startPath = '/api/auth/start'
}) {
  if (!auth) throw new Error('requireRole requires auth (createDelegateAuth, or api.delegateAuth)');
  if (!request) throw new Error('requireRole requires request');
  let roleId = null;
  if (role) {
    roleId = resolveRoleId(auth.roleRegistry, role);
    if (!roleId) {
      throw new Error(
        `requireRole: unknown role '${role}'. Configure it in createApi({ config: { roles } }), for example roles: 'standard'.`
      );
    }
  }

  const url = new URL(request.url);
  const here = safeReturnPath(`${url.pathname}${url.search}`, { fallback: '/' });
  const startUrl = `${startPath}?returnTo=${encodeURIComponent(here)}`;
  // From the 403 page: prompt=select lets the person choose another account.
  const switchUrl = `${startUrl}&prompt=select`;

  const session = await sessionFromRequest({ auth, request, cookieName });
  if (!session) {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      return { ok: false, status: 302, response: redirectTo(startUrl) };
    }
    return {
      ok: false,
      status: 401,
      response: new Response(JSON.stringify({ error: 'sign in required' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      })
    };
  }

  const roles = await auth.rolesForSession(session);
  if (roleId) {
    const config = auth.roleRegistry[roleId];
    const allowed =
      roles.includes(roleId) &&
      meetsRequiredAuth(config?.requiredAuth, {
        level: session.level,
        twoFactor: Boolean(session.auth?.twoFactor)
      });
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        response: forbiddenPage({ email: session.email, role: config?.name || role, startUrl: switchUrl })
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
