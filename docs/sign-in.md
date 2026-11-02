# Sign-in on a site: use what core ships

A site that uses `@engine9/core` for authentication should not write its own
sign-in routes, session storage, or access checks. Core already has them,
and they handle the cases that are easy to get wrong. The worst of those is
a signed-in person who lacks access and is sent back to sign in. Delegate
remembers the address they shared, so it returns the same one at once, and
they go round with nothing on screen.

You may still build your own sign-in on top of core. If you do, follow
[If you build your own](#if-you-build-your-own).

## Who does what

| Layer | Owns | Never does |
| --- | --- | --- |
| **Delegate** | Who the person is: the provider sign-in, which address they share with your Domain (the Grant), the share screen. Signs the Identity Token | Know your people, roles, or pages |
| **`@engine9/core`** (your server) | Turning a sign-in into a `person_id` and roles. The session cookie (`e9_session`). Deciding access: signed out (401), signed in without access (403), allowed. The links that fix each one | Show your site's UI |
| **`@engine9/id`** (the browser) | UI: the Login widget, soft `data-e9-*` content by Identity Level, the "Change your Delegate information" button | Decide access. Anything it hides is layout, not security |
| **Your site** | Mounting core's routes, calling the gate before serving private pages and API routes, and rendering what the gate returns | Re-implement any row above |

The rule of thumb: **the server decides, the browser shows.** If a page or
an API route must be private, core's gate runs before it on the server. If
the browser needs to know whether to show an Admin link, it reads
`/api/auth/me`. It does not make the decision itself.

## The default: link, cookie, gate

This needs no JavaScript for sign-in at all.

1. **Mount core** under `/api` with `delegate: { sessionSecret }` and your
   roles (`roles: 'standard'` gives you `admin`). That serves
   `GET /api/auth/start`, `GET /api/auth/callback`, `GET /api/auth/me`, and
   `POST /api/auth/logout`.
2. **Log in** is a link:
   `<a href="/api/auth/start?returnTo=/members">Log in</a>`. The callback
   sets the `e9_session` cookie (HttpOnly) and returns to `returnTo`.
3. **Gate every private page and API route** on the server with
   `requireRole`:

   ```js
   import { requireRole } from '@engine9/core/auth/gate';

   // In your fetch handler, before serving /admin or /api/admin/*:
   const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' });
   if (!gate.ok) return gate.response;
   // gate.session.personId, gate.session.email, gate.roles
   ```

   `gate.response` is the right answer every time:

   | Case | Page load | `fetch()` from page code |
   | --- | --- | --- |
   | Signed out | 302 to `/api/auth/start?returnTo=<this page>` | 401 `{ error, reason: 'sign_in_required', signInUrl }` |
   | Signed in, not in the role | 403 page: "You are signed in as …", with **Use a different email or account** | 403 `{ error, reason: 'role_not_held', role, email, changeUrl }` |
   | In the role, but signed in too weakly for it (`requiredAuth`) | 403 page that says so | 403 `{ …, reason: 'auth_not_met' }` |

   The role is read from the database on each request, not from the
   cookie, so removing someone takes effect at once. The gate tells a page
   load from `fetch()` by `Sec-Fetch-Mode`. Pass `page: true` or
   `page: false` to override it.
4. **Change email** in your header, next to Log out, is a link to
   `changeSignInUrl(location.pathname)` from `@engine9/core/auth/signIn`
   (`/api/auth/start?returnTo=…&prompt=select`). Delegate shows its share
   screen so the person can pick another address, add one, or use a
   different account.
5. **Log out** is `POST /api/auth/logout` with the public key
   (`X-API-Key: e9publickey_…`). It clears the cookie, and revokes the
   session when `sessionRevocations` is set.

`changeUrl` on a 403 is `/api/auth/start?returnTo=…&prompt=select&reason=access_denied`.
`reason=access_denied` makes Delegate show a notice, in its own words, that
your Domain did not let the person in with the address they shared.

### A single-page app

The same rules apply. A server route behind `requireRole` (for example the
`/api/admin/*` your admin screens call) answers `fetch()` with JSON. The app
does this with it:

- **401**: send the browser to `body.signInUrl`.
- **403**: show a message on the page, with `body.email` and a link to
  `body.changeUrl`. **Do not redirect to your login page.** That is the
  loop.
- Serve the app's HTML through the gate too when you can. Then a person
  without access gets core's 403 page before any of your code runs.

To show "Signed in as …" and the Admin link, call `GET /api/auth/me` with the
public key (`X-API-Key: e9publickey_…`). A same-origin `fetch()` sends the
cookie by itself. It returns `personId`, `roles`, `email`, and `level`, or
401 when no one is signed in. That is for display. The gate makes the
decision.

## Do not

These are the mistakes that turn a missing role into a silent loop or a
blank page. Each one has a core feature that replaces it.

| Do not | Use instead |
| --- | --- |
| Send a signed-in person who lacks access to `/login` or `/api/auth/start` | The gate's 403 and its `changeUrl` |
| Write your own `/auth/callback`, or forward the token to a page that posts it to `/api/auth/login` | Core's `/api/auth/callback` |
| Keep the session in `localStorage` or `sessionStorage` on a site whose server gates pages | The `e9_session` cookie. Your server cannot see browser storage, so the gate reads "signed out" |
| Have one route sign people in and a separate admin route check a different cookie | One session (`e9_session`) and `requireRole` everywhere |
| Read `session.roles` from the cookie for an access decision | `requireRole`, or `auth.rolesForSession(session)` |
| Answer every failure the same way | 401 for signed out, 403 for signed in without access |
| Hide the address the person is signed in with | Show `email`. The fix is usually another address |
| Auto-redirect `/login` to Delegate with no way to stop | Send people to `/api/auth/start` from a link or a gate. If `/login` auto-starts, show the change link once someone is signed in |

## `@engine9/id` with core

Use `@engine9/id` for UI: the Login widget, soft content by Level, and the
change-address button. On a site with its own server, sign-in and access
still go through the cookie and the gate above.

`id.core.login()` posts the Identity Token to `/api/auth/login`. The Core
Session comes back to the browser, which sends it as `X-Engine9-Session`.
That suits a static site with no server routes of its own, where core's API
is the only thing to protect. Do not mix the two on one site: a session held
in the browser is invisible to a server gate.

On an access-denied message in the browser, use
`id.changeDelegateInfo({ reason: 'access_denied' })` or
`<button data-e9-change-delegate data-e9-reason="access_denied">`.

## If you build your own

Core does not forbid it. If your site needs its own sign-in flow, a custom
session, or its own 403 page, keep these rules:

1. Start sign-in with `auth.beginLogin()` and finish it with
   `auth.finishLogin()`. They bind the return to the browser that started
   it (state and nonce).
2. Decide access on the server with `requireRole`, or with
   `auth.rolesForSession(session)` and `meetsRequiredAuth`. Do not use the
   roles copied into a token.
3. Tell signed out (401) from signed in without access (403). Never answer a
   403 with a sign-in redirect.
4. On every access-denied message, show who the person is signed in as and
   link to `changeSignInUrl(path, { reason: 'access_denied' })`, or call
   `auth.identityUrl({ …, prompt: 'select', reason: 'access_denied' })`.
   `requireRole` returns `reason`, `email`, `role`, and `changeUrl`, so a
   custom 403 page only has to render them.
5. Put a change-email link (`changeSignInUrl(path)`) next to Log out.

Delegate stops a silent loop on its own: a browser that gets two silent
tokens for your Domain within two minutes sees the share screen on the
third request. That is a safety net, not a design. A person who reaches it
has already been sent round twice.
