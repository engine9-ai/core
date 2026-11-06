# Sign-in on a site: the recommended way

**This is the recommended way to sign people in on any site that uses
`@engine9/core` for authentication.** One session, the HttpOnly `e9_session`
cookie, set by core however the person signs in, and one gate,
`requireRole`, on the server. The site writes no sign-in route, keeps no
session of its own, and makes no access decision in the browser.

The reference implementation is
[`demo-festival`](https://github.com/engine9-ai/demo-festival). Copy it.

Core already handles the cases that are easy to get wrong. The worst of
those is a signed-in person who lacks access and is sent back to sign in.
Delegate remembers the address they shared, returns the same one at once,
and they go round with nothing on screen.

You may still build your own sign-in on top of core. If you do, follow
[If you build your own](#if-you-build-your-own).

## Who does what

| Layer | Owns | Never does |
| --- | --- | --- |
| **Delegate** | Who the person is: the provider sign-in, which address they share with your Domain (the Grant), the share screen. Signs the Identity Token | Know your people, roles, or pages |
| **`@engine9/core`** (your server) | Turning a sign-in into a `person_id` and roles. The session cookie (`e9_session`). Deciding access: signed out (401), signed in without access (403), allowed. The links that fix each one | Show your site's UI |
| **`@engine9/id`** (the browser) | UI: the Login widget, soft `data-e9-*` content by Identity Level, the "Change your Delegate information" button. With `core.session: 'cookie'`, it asks core to start and finish each sign-in | Decide access, or hold a session token. Anything it hides is layout, not security |
| **Your site** | Mounting core's routes, calling the gate before serving private pages and API routes, and rendering what the gate returns | Re-implement any row above |

The rule of thumb: **the server decides, the browser shows.** If a page or
an API route must be private, core's gate runs before it on the server. If
the browser needs to know whether to show an Admin link, it reads
`/api/auth/me`. It does not make the decision itself.

## The recommended setup

### 1. Mount core

Mount core under `/api` on the same host as your pages, with
`delegate: { sessionSecret }` (or your own `delegateAuth`), your roles
(`roles: 'standard'` gives you `admin`), and what Delegate should ask for in
`config.signIn`:

```js
createApi({
  worker,
  keyStore,
  delegate: { sessionSecret: env.SESSION_SECRET },
  config: {
    roles: 'standard',
    signIn: { minLevel: 1, fields: ['display_name', 'email'], brand: { name: 'My Site' } },
  },
});
```

That serves every route below. Nothing in this guide needs a route of your
own.

### 2. Add the Login button

**Do this first.** The `@engine9/id` Login widget is the default way to use
Delegate, and the button in `demo-festival`'s header. One button shows
**Login** or who is signed in; one dialog logs in, switches the email
address the site sees, changes role, and logs out. Put it in the header of
every page.

With a bundler (Vite, Astro, Next, and so on):

```js
import { createEngine9Id } from '@engine9/id';
import { loginWidget } from '@engine9/id/widget';

const id = createEngine9Id({
  core: { apiUrl: '/api', publicApiKey: 'e9publickey_…', session: 'cookie' },
});
loginWidget({
  id,
  siteName: 'My Site', // the name on the dialog and on Delegate's sign-in page
  async onLogin() {
    const { session } = await id.core.login(); // core sets e9_session
    return { email: session.email, level: session.level };
  },
  onLoggedOut() {
    location.reload(); // server-rendered pages follow the cookie
  },
});
```

The button goes in `<span data-e9-login-widget></span>` (or pass `target`).
On a plain HTML page, load
`https://unpkg.com/@engine9/id@1/dist/id.iife.js` and call the same two
functions as `engine9Id.createEngine9Id` and `engine9Id.loginWidget`. The
public key is `E9_PUBLIC_API_KEY` from `.env`.

`session: 'cookie'` is what makes this the recommended path. Without it, the
widget's session lives in the browser, and your server gate cannot see it.

To offer roles in the dialog, pass `roles` and an `onRoleChange` that calls
`id.core.changeRole(roleId)`. To brand Delegate's sign-in page, pass `brand`
to `createEngine9Id`. Both are in `demo-festival`'s
[`Layout.astro`](https://github.com/engine9-ai/demo-festival/blob/main/src/layouts/Layout.astro).

### 3. The link: a fallback, and where the gate sends people

```html
<a href="/api/auth/start?returnTo=/members">Log in</a>
```

`/api/auth/start` sends the browser to Delegate with a signed `e9_login`
cookie (state and nonce). `/api/auth/callback` checks both, sets
`e9_session`, and returns to `returnTo`. A failure comes back to `returnTo`
with `?login_error=<reason>`. Build the link with `signInUrl(path)` from
`@engine9/core/auth/signIn`.

It sets the same `e9_session` as the button, so the gate sees the person
whichever they used. Use it as the `href` behind the Login button for
browsers without JavaScript, and let the gate (step 4) send signed-out
visitors to it. Do not make it the site's only Login control: it gives the
person no way to see who they are signed in as, switch email, or log out.

### 4. Gate every private page and API route

```js
import { requireRole } from '@engine9/core/auth/gate';

// In your fetch handler, before serving /admin or /api/admin/*:
const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' });
if (!gate.ok) return gate.response;
// gate.session.personId, gate.session.email, gate.roles
```

`role` may be a list (`['VIP', 'admin']`): holding any one is enough.

`gate.response` is the right answer every time:

| Case | Page load | `fetch()` from page code |
| --- | --- | --- |
| Signed out | 302 to `/api/auth/start?returnTo=<this page>` | 401 `{ error, reason: 'sign_in_required', signInUrl }` |
| Signed in, not in the role | 403 page: "You are signed in as …", with **Use a different email or account** | 403 `{ error, reason: 'role_not_held', role, email, changeUrl }` |
| In the role, but signed in too weakly for it (`requiredAuth`) | 403 page that says so | 403 `{ …, reason: 'auth_not_met' }` |

The role is read from the database on each request, not from the cookie, so
removing someone takes effect at once. The gate tells a page load from
`fetch()` by `Sec-Fetch-Mode`. Pass `page: true` or `page: false` to
override it.

`changeUrl` on a 403 is
`/api/auth/start?returnTo=…&prompt=select&reason=access_denied`.
`reason=access_denied` makes Delegate show a notice, in its own words, that
your Domain did not let the person in with the address they shared. To use
your own look for the 403, render `gate.email`, `gate.role`, `gate.reason`,
and `gate.changeUrl` (demo-festival's `/denied` does).

### 5. Change email and log out: already in the Login button

Once someone is signed in, the Login button shows their email (and role),
and its dialog has **Switch email** and **Log out**. Do not add a separate
"signed in as", "Use a different email", or "Log out" to the header; that
row of text links is what a site ends up with when it skips step 2.

Switch email opens Delegate's share screen (`prompt=select`) so the person
can pick another address, add one, or use a different account. Without
JavaScript, the same thing is a link to `changeSignInUrl(path)`
(`/api/auth/start?returnTo=…&prompt=select`).

With `session: 'cookie'`, the widget's Log out (`id.logout()`) also ends
core's session: `POST /api/auth/logout` clears the cookie and revokes the
session when `sessionRevocations` is set. Reload or navigate in the widget's
`onLoggedOut`, which runs after every logout request has finished. Without
`@engine9/id`, call `POST /api/auth/logout` with the public key
(`X-API-Key: e9publickey_…`).

## How the widget sign-in is kept safe

Setting a cookie from a `fetch()` needs more care than setting one from a
redirect. With `core.session: 'cookie'`:

1. Before Delegate opens, `@engine9/id` calls `POST /api/auth/begin`. Core
   returns a fresh `state` and `nonce` and keeps them in the signed `e9_login`
   cookie. The popup opens empty inside the click and goes to Delegate once
   core answers, so popup blockers allow it.
2. Delegate signs an Identity Token carrying that nonce.
3. `id.core.login()` posts `{ delegate_token, state, cookie: true }` to
   `/api/auth/login`. Core refuses it unless:
   - `state` and the token's nonce match the `e9_login` cookie. A token from
     anywhere else (another browser, a log, an older attempt) cannot be
     exchanged for a session;
   - the request's `Origin` is this site's own. Another site cannot sign a
     visitor in as someone else (login CSRF).
4. Core sets `e9_session` and answers `{ session }`. The session token is
   never in the body, so injected script cannot carry it away.

`POST /api/auth/role` from a cookie session re-signs the cookie the same way.

## A single-page app

The same rules apply. A server route behind `requireRole` (for example the
`/api/admin/*` your admin screens call) answers `fetch()` with JSON. The app
does this with it:

- **401**: send the browser to `body.signInUrl`.
- **403**: show a message on the page, with `body.email` and a link to
  `body.changeUrl`. **Do not redirect to your login page.** That is the
  loop.
- Serve the app's HTML through the gate too when you can. Then a person
  without access gets the 403 page before any of your code runs.

To show "Signed in as …" and the Admin link, call `id.core.me()` (or
`GET /api/auth/me` with the public key; a same-origin `fetch()` sends the
cookie by itself). It returns `personId`, `roles`, `email`, and `level`, or
401 when no one is signed in. That is for display. The gate makes the
decision.

## Do not

These are the mistakes that turn a missing role into a silent loop or a
blank page. Each one has a core feature that replaces it.

| Do not | Use instead |
| --- | --- |
| Send a signed-in person who lacks access to `/login` or `/api/auth/start` | The gate's 403 and its `changeUrl` |
| Write your own `/auth/callback` | Core's `/api/auth/callback` |
| Write your own route that takes the widget's token and sets a session | `core: { session: 'cookie' }` and `id.core.login()` |
| Keep the session in `localStorage` or `sessionStorage` on a site whose server gates pages | `session: 'cookie'`. Your server cannot see browser storage, so the gate reads "signed out" |
| Have one route sign people in and a separate admin route check a different cookie | One session (`e9_session`) and `requireRole` everywhere |
| Read `session.roles` from the cookie for an access decision | `requireRole`, or `auth.rolesForSession(session)` |
| Answer every failure the same way | 401 for signed out, 403 for signed in without access |
| Hide the address the person is signed in with | Show `email`. The fix is usually another address |
| Build the header's sign-in from text links ("Log in", the email, "Use a different email", "Log out") | The Login button (step 2). It shows the email and has Switch email and Log out in its dialog |
| Navigate away in the widget's `onLogout` | `onLoggedOut`, after the logout requests finish |
| Auto-redirect `/login` to Delegate with no way to stop | Send people to `/api/auth/start` from a link or a gate. If `/login` auto-starts, show the change link once someone is signed in |

## `session: 'token'`: only without a server

`@engine9/id`'s default, `session: 'token'`, keeps the Core Session token in
browser storage and sends it as `X-Engine9-Session`. Use it only on a site
with no server routes of its own, where core's API is the only thing to
protect. Do not mix the two on one site: a session held in the browser is
invisible to a server gate.

## If you build your own

Core does not forbid it. If your site needs its own sign-in flow, a custom
session, or its own 403 page, keep these rules:

1. Start sign-in with `auth.beginLogin()` (a redirect) or
   `auth.beginLoginRequest()` (page JavaScript), and finish it with
   `auth.finishLogin()`. They bind the return to the browser that started it
   (state and nonce). Check the `Origin` before setting a cookie from a POST.
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
5. Keep the Login button (step 2) for the header even with your own flow; its
   Switch email and Log out cover this. Without it, put a change-email link
   (`changeSignInUrl(path)`) next to Log out.

Delegate stops a silent loop on its own: a browser that gets two silent
tokens for your Domain within two minutes sees the share screen on the
third request. That is a safety net, not a design. A person who reaches it
has already been sent round twice.
