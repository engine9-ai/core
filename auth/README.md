# `@engine9/core/auth`

Module reference for authentication and authorization on the standard
endpoints `@engine9/core` serves. The same API-key scopes apply on any
engine9-capable database, including when the private server’s Task API is
in use. Product vocabulary: **User**, **Domain**, **Identity Token**. The JWT
claim is still `aud`.

Login uses an optional **identity provider**. Production defaults to delegate.
Provider-specific terms (UNID) are in
[docs/identityProviders/delegate.md](../docs/identityProviders/delegate.md).
`delegate.js` is the implementation of that default provider.

This is **not** OpenID Connect. Do not invent OIDC discovery, `id_token`
aliases, or extra OIDC claims. The default provider’s wire protocol is
`id` [protocol](https://github.com/engine9-ai/id/blob/main/docs/protocol.md).

## Layout

| File               | Role                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `index.js`         | API keys (`SqlApiKeyStore`, `KVApiKeyStore`, prefixes, catalog)                                                        |
| `policy.js`        | Scopes, `requiredAuth` (`minLevel`, `twoFactor`), `resolveAuthContext`                                                 |
| `hmac.js`          | `encoded.sig` HMAC helpers (Core Session + legacy bridge)                                                              |
| `delegate.js`      | Identity Tokens, person + role + session                                                                               |
| `delegate.d.ts`    | Types for `createDelegateAuth` and JWT verification                                                                    |
| `roles.js`         | Role segments: standard names, deterministic ids, add/remove people by email ([docs/segments.md](../docs/segments.md)) |
| `roleNames.js`     | `ROLE_NAMES`, `STANDARD_ROLES`                                                                                         |
| `superadmins.js`   | Superadmin list logic: `normalizeSuperadmins`, `isSuperadmin` (a file of verified emails; [docs/roles.md](../docs/roles.md#superadmins)) |
| `segmentAccess.js` | `canEditSegmentMembership` — join, leave, manager ([docs/segments.md](../docs/segments.md))                            |

The permission levels (visitor, site role, admin, superadmin), the numbered
requirements, and conversion steps are in
[PERMISSIONS.md](../PERMISSIONS.md). This page is the module reference.

## Authentication vs authorization

1. **API key** (layer 1) — enables the caller. Empty `scopes` deny. `admin`
   grants every scope. Prefix `e9key_` or `e9publickey_` (`public` scope).
2. **Role** (layer 2) — `role_id === segment_id`. Effective scopes =
   key ∩ role (`intersectScopes`). A request may name a `role_id` only when
   the role is in the registry and the caller holds it (it is on the session's
   `roles`, or it is the key's `default_role_id`). Any other `role_id` is a
   403 (`unknown_role` or `role_not_held`), never a fall back to the key's
   own scopes. Soft **declared roles** with the same
   `requiredAuth` shape (no `person_id`) are documented in
   `@engine9/id` [declared roles](https://github.com/engine9-ai/id/blob/main/docs/declared-roles.md)
   and demonstrated in `[demo-id](https://github.com/engine9-ai/demo-id)`.
3. **Identity Level** (layer 3) — `requiredAuth.minLevel` and
   `requiredAuth.twoFactor` against the session / Identity Token. Levels are
   not authorization.

## Permissions

### Where each piece lives

| What | Where | Changes when |
| --- | --- | --- |
| What a key may do | API key `scopes` | The key is created, edited, or rotated |
| Who holds a role | `person_segment` rows (`person_id`, `segment_id`) | Membership is granted or removed |
| What a role means | The role registry (`config.roles`): `scopes`, `requiredAuth` | You deploy |
| The roles a session shows | `roles` inside the Core Session token, copied from `person_segment` | A token is minted (login, `POST /auth/role`) |

`person_segment` is the only record of who holds a role. The `roles` in a
token are a copy made when the token was minted. Nothing updates that copy
afterwards.

### How core decides

- A request's scopes are the key's scopes intersected with the acting role's
  scopes. The acting role is the `role_id` the request names (it must be
  held), else the first role in the session, else the key's
  `default_role_id`. A role only narrows the key. A request with no role gets
  the key's scopes. So an out-of-date copy in a token can never give more API
  access than the key already allows.
- Membership changes (`POST /auth/role`, `POST /auth/segments`) and
  segment-gated reads (`GET /read/:name` with `segmentId`) read
  `person_segment` on the request itself.
- A Bearer Identity Token carries no roles, so core reads them on each such
  request.
- `requiredAuth` (Identity Level, two-factor) is checked against the session
  on every request.

### What host code should do

Use the session's `roles` to decide what to show: the Admin link, which page
to land on after login (`sessionHasRole`, `sessionPrimaryRole`). Reading the
session does not touch the database.

For a privileged decision, such as entering an admin page or performing an
admin action with the admin key, ask `person_segment` at that moment:

```js
const session = await auth.verifySession(token);
const roles = session ? await auth.rolesForPerson(session.personId) : [];
if (!roles.includes(ADMIN_ROLE_ID)) return redirect("/");
```

That is one indexed query, on those requests only. Check the role's
`requiredAuth` against the session too (`meetsRequiredAuth`).

Do not send a visitor's session with the admin key and rely on the role to
restrict it: a session with no role gets the key's scopes. If server code
must do that, give the key a `default_role_id` with only the scopes visitors
need.

### Removing someone

Remove their `person_segment` row (`auth.removePeople`, or
`POST /auth/segments`). Privileged checks see it on their next request. The
copy in a token they already hold goes away when it expires or they log in
again, so menus can show the old role until then. To end the session itself,
use logout with `sessionRevocations` (below), or rotate `SESSION_SECRET` to
end every session.

## Policy (`policy.js`)

- `hasScope(scopes, scope)` — empty list is false; `admin` matches any scope.
- `meetsRequiredAuth(requiredAuth, credentialLevel)` — if `minLevel` is a
  number, requires `credentialLevel.level >= minLevel`; still checks
  `twoFactor` when that flag is true.
- `resolveAuthContext({ apiKey, roleId, session, rolesRegistry })` sets
  `credentialLevel = { ...(session.auth || {}), level: session.level }` so
  `minLevel` reads `session.level`.

`requiredAuth` is **enforced** on `createApi` routes (`authSatisfied`).

## Identity Tokens (`delegate.js`)

Default provider implementation. Behavior and vocabulary:
[docs/identityProviders/delegate.md](../docs/identityProviders/delegate.md).

`verifyDelegateIdentityToken({ token, delegateUrl, domain, jwks?, issuer?, fetchImpl? })`
verifies the provider JWT and returns the provider user object.
`resolveDelegatePersonId` finds the person for it, by the rule in the next
section.

## Who is signing in: credential, identity, deduplication

A login involves three different things. Keep them apart.

| | What it is | Decided by | Stored in |
| --- | --- | --- | --- |
| **Credential** | The Identity Token. Delegate says: this browser's User controls this address, at this Identity Level, for this Domain | Delegate | The token, then the Core Session |
| **Identity** | The person: one `person` row and its `person_id` | core | `person`, `person_email`, `person_id_*` |
| **Deduplication** | Whether two identifiers (two addresses, an address and a CRM id) are one person | core's people pipeline, from core's own data | `person_id_*` |

Delegate issues credentials. It is not a deduplication mechanism. That one
Delegate User holds two addresses is not evidence to core that they are one
person.

### The names

| Name | Meaning |
| --- | --- |
| `sub` (Domain UNID) | Delegate's id for the Delegate User on this Domain, `domain:hex`. It is the same for every address that User holds. It names the holder of the credential, not a person in core. On the session as `domainUnid` |
| `fields.email`, `fields.email_verified` | The address the User chose to share with this Domain, and whether Delegate confirmed it |
| Confirmed email | `email_verified` is true, or the Identity Level is 2 or more. `delegateConfirmedEmail(delegateUser)` returns it, or undefined |
| Login record | The one row core sends through the people pipeline (`processPeople`) at login, exactly as an import would: `{ email }` with a confirmed email, else `{ delegate_id: sub }` (plus `delegate_merged_from`). Fields the site passes as `login(token, { person })` ride along |
| `person_id` | core's id for the person. Roles (`person_segment`) and every person table hang on it. On the session as `personId` |
| `session.email` | The confirmed address of this login. Undefined when there is none |

### The rule

1. **A confirmed email is the key.** core finds the person it knows by that
   address, or creates one, the same way an import of that address would.
   The Domain UNID is not stored on that person.
2. **With no confirmed email, the Domain UNID is the key**
   (`person_id_delegate`). This covers Level 0 visitors, an unconfirmed
   address (Facebook addresses are never confirmed), and a Grant that does not
   share `email`. `merged_from` links the browser's earlier Domain UNID to the
   same person.
3. **Only core joins people.** Two addresses are one person when core's data
   already says so: an import that gives both the same `person_id` or
   `remote_person_id`, or a merge an operator made. Never because Delegate
   holds both for one User.

Why:

- Roles and superadmins are granted by address (`addPeople({ emails })`, the
  superadmin list). Grant `pat@work.example` a role, and whoever signs in with
  that confirmed address holds it, whatever address they used before.
- One Delegate User is not always one person. A family or a team shares an
  inbox, and many people keep work and home apart on purpose.
- If the Domain UNID stuck to the first person, every later address that User
  picked would sign in as that first person, and the site's records for the
  new address would never be found.

### Use cases

| The person… | Signs in with | They are |
| --- | --- | --- |
| Signs in for the first time | `a@` (new to core) | A new person with `a@` |
| Was imported, put on a roster, or granted a role by address | `a@` | That person |
| Signs in again | `a@` | The same person |
| Uses "Change your login email" and picks a second address | `b@` (new to core) | A new person with `b@`. The `a@` person is untouched; signing in with `a@` returns to it |
| Picks an address that already belongs to someone in core | `b@` | That person. Delegate confirmed they control `b@` |
| Has both addresses already joined in core | `b@` | The joined person |
| Uses a different Google account | `c@` | Whoever core knows by `c@`, like any other address |
| Has no confirmed email | (none) | The person for their Domain UNID |
| Was a Level 0 visitor, then confirms an address | `a@` | The person for `a@`. The visitor record for the Domain UNID is not joined to it |

### What a site does

- Use `session.personId` for everything you store. Do not key your own tables
  on `sub` or on an email address.
- Show `session.email` as "signed in as". It is always the address of this
  login.
- Treat "Change your login email" (`prompt: 'select'`) as "sign in with
  another address". Say so next to the link: *What you see here follows the
  address you sign in with.*
- To make two addresses one person, join them in core (an import with the
  same `person_id` or `remote_person_id`, or an operator merge). Delegate
  cannot do it for you.

People who signed in before core 1.16.0 keep their `person_id_delegate`
rows. A login with a confirmed email no longer reads them; a login without
one still does.

## `createDelegateAuth`

```js
createDelegateAuth({
  worker,
  delegateUrl,
  domain, // JWT aud (host[:port]); else domainFromUrl(returnTo) on login
  sessionSecret, // required — HMAC Core Session
  pluginId,
  roles, // { [segmentUuid]: { name, scopes, requiredAuth } }
  fetchImpl,
  sessionRevocations, // optional KV-like store; logout revokes the session
  acceptLegacySessions, // default true; false refuses sessions without `typ`
});
```

`login(token, { nonce })` accepts an Identity Token (JWT). Verification uses
the provider JWKS. No shared secret. With `nonce`, the token's `nonce` must
match.

`verify(sessionToken)` returns `personId`, `roles`, `domainUnid`, `email`,
`auth`, `level`, `sid`, `iat`, `exp`. `verifySession(sessionToken)` (async) is
what `createApi` uses: `verify`, then the revocation check.
`logout(sessionToken)` revokes. `rolesForPerson(personId)` reads the roles a
person holds now ([Permissions](#permissions)). `beginLogin` / `finishLogin`
bind a server-side sign-in to the browser.

`verifyIdentityToken(jwt)` is the same JWKS check with constructor `domain` /
`delegateUrl`.

`roles: 'standard'` builds the registry from `worker.accountId` with the
canonical name in `roleNames.js` (`admin`). Any other role
name is site-specific: put it in an explicit `config.roles` map (or install
it outside core).

`superadmins` (an array, or a function read on each request such as
`createSuperadminsReader()` from `@engine9/core/superadmins/node`) lists
verified emails that act as this account's `admin` role. `superadmins.js` is
the pure list logic (`isSuperadmin` needs Identity Level 3). The role is added
to the session on every `verify`, never stored in `person_segment` or in the
token. `auth.rolesForSession(session)` returns person_segment roles plus that
role; use it, not `rolesForPerson`, for a privileged decision on a session.
Details: [docs/roles.md](../docs/roles.md#superadmins).

`auth.ensureSegments()`, `auth.addPeople({ role, emails })`,
`auth.removePeople({ role, emails })`, and `auth.members({ role })` manage
membership from server-side code. HTTP callers use `POST /auth/segments`
(`add` / `remove`), which checks `canEditSegmentMembership`
(`segmentAccess.js`). A "user" is a person in one of these segments. Full
guide: [docs/segments.md](../docs/segments.md).

## Local session (`SESSION_SECRET`)

A **Core Session** is a compact HMAC token the host mints after it has
verified an Identity Token. Later requests present that token. The host
checks the signature and `exp` in process. It does not call Delegate, fetch
JWKS, or read the database to decide that the caller is the same User who
just logged in.

The env name is `SESSION_SECRET`. It is the HMAC-SHA256 key. Anyone who
knows it can mint a session the host will accept, so production must use an
unguessable value kept out of git. Each host has its own value. One host’s
secret does not sign the engine9 API’s sessions, and the API’s secret does
not sign another host’s cookie.

Create one (32 random bytes, hex). This is the same generator `e9core setup-keys` uses:

```bash
openssl rand -hex 32
```

`npx e9core setup-keys` writes `SESSION_SECRET` into `.env` next to the API
keys. `npx e9core setup-keys --remote` stores that value as a Cloudflare
secret. Rotate with `npx e9core setup-keys --rotate`, then `--remote` again.

### What it is, and what it is not

| Secret                                   | Who holds it                                | What it does                               |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| `SESSION_SECRET`                         | Your Domain’s host, or the engine9 API host | Signs that host’s local session            |
| `E9_ADMIN_API_KEY` / `E9_PUBLIC_API_KEY` | The caller                                  | Authorizes the HTTP API. Empty scopes deny |

Identity Tokens are verified with the provider’s public JWKS
(`{delegateUrl}/.well-known/jwks.json`). The signing key stays on the
provider.

An Identity Token proves the User to the host once. A Core Session is the
host’s own cache of that result. Login still needs Delegate (or another
provider). Requests after that need `SESSION_SECRET`.

### When a request hits Delegate

| Call                                                                                           | Credential                           | Delegate?                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| `POST /auth/login` with `delegate_token`                                                       | Identity Token (JWT, `aud` = Domain) | Yes. JWKS verify, then map UNID → `person_id` |
| `GET /auth/me`, `POST /auth/role`, other routes with `X-Engine9-Session` or the session cookie | Core Session                         | No. HMAC + `exp`                              |
| Same routes with `Authorization: Bearer <jwt>` (three segments, not an API key)                | Identity Token                       | Yes, when `verifyIdentityToken` is configured |
| `POST /people` and other data routes                                                           | API key                              | No                                            |

Mint a session when the browser or app will call back many times and you
want those calls to skip the provider. Send the Identity Token on each
request when you would rather not hold a host session. People writes need
only an API key; they never read `SESSION_SECRET`.

### Token shape

`createSessionToken(payload, { secret, ttlSeconds, typ })` builds
`base64url(JSON).base64url(HMAC-SHA256)`. The JSON is the payload plus
`typ` (what the token is for: `e9.session`, or `e9.login` for the pending
login cookie), `iat` and `exp` in unix milliseconds, and a random `sid` for
sessions. Default TTL is 86400 seconds. `verifySessionToken(token, { secret, typ })`
returns the payload, or `null` when the signature, encoding, `exp`, or `typ`
fails, so a login cookie can never be replayed as a session. Core does not
store sessions.

Sessions minted before `typ` existed have none. `createDelegateAuth` accepts
them until they expire (`acceptLegacySessions: true`, the default). Set it to
`false` once a day has passed after upgrading.

### Logout and revocation

A Core Session is valid until `exp` unless the host remembers that it was
revoked. Pass a KV-like store (`get`, `put` with `expirationTtl`, such as a
Cloudflare KV binding) as `sessionRevocations`:

```js
createDelegateAuth({ sessionSecret, worker, sessionRevocations: env.SESSION_REVOCATIONS });
```

`POST /auth/logout` (or `delegateAuth.logout(token)`) then records the
session's `sid` until it would have expired, and `verifySession` refuses it.
Without a store, logout only clears the cookie, and a copied token works
until `exp`. Rotating `SESSION_SECRET` ends every session at once.

### One-link sign-in (`/auth/start`, `/auth/callback`)

`createApi` ships the server-side sign-in described below, so a site needs one
link and no JavaScript:

```html
<a href="/api/auth/start?returnTo=/members">Log in with Google</a>
```

- `GET /auth/start` sends the browser to Delegate with a signed `e9_login`
  cookie. Delegate opens a single provider by itself. `returnTo` must be a
  path on this site; anything else becomes `/`. `login_hint=<email>` and
  `prompt=select` (let the visitor choose another account) are the only
  other query parameters. Everything else is `config.signIn`: `minLevel`
  (default 1), `maxLevel`, `fields` (default `['email']`), `optionalFields`,
  `loginLevel`, `loginProviders`, `brand`, `sessionCookie` (default
  `e9_session`), `sessionTtlSeconds`. On the Cloudflare example Worker,
  `E9_SIGN_IN` holds that object as JSON.
- `GET /auth/callback` runs `finishLogin`, sets the Core Session as an
  `HttpOnly`, `SameSite=Lax` cookie (`Secure` on https), clears `e9_login`, and
  redirects to `returnTo`. A declined or failed sign-in redirects there with
  `?login_error=<reason>`. A return this browser did not start redirects to
  `/` and sets nothing: show Log in, not an error.
- Neither route takes an API key (a link cannot send one). The session cookie
  is read on the API's other routes (`GET /auth/me`, `POST /auth/role`, …) next
  to `X-Engine9-Session`, and `POST /auth/logout` clears it.

To lock a page you serve yourself, check the cookie in the same Worker:

```js
import { requireRole } from '@engine9/core/auth/gate';

const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' });
if (!gate.ok) return gate.response; // 302 to /api/auth/start, 401, or a 403 page
// gate.session, gate.roles
```

`requireRole` reads the role from `person_segment` now and enforces the role's
`requiredAuth` (PL-8); it never trusts the roles copied into the cookie. With
no `role` it only requires a signed-in browser. `createGate({ auth })` fixes
`auth` once. This protects what your Worker serves; a static asset served
before your code runs is not protected.

### Server-side sign-in (`beginLogin` / `finishLogin`)

A host that receives the Identity Token on its own callback
(`response_mode=query`) must check that this browser started the sign-in.
Otherwise someone can send a victim a link carrying the attacker's token and
sign the victim in as the attacker.

```js
// GET /login
const { url, cookie } = delegateAuth.beginLogin({
  returnTo: "https://www.example.com/auth/callback",
  data: { next: "/members" }, // rides in the signed cookie, comes back from finishLogin
});
return redirect(url, { "Set-Cookie": cookie });

// GET /auth/callback?delegate_token=…&state=…
const { token, clearCookie, data } = await delegateAuth.finishLogin(query.delegate_token, {
  state: query.state,
  cookie: request.headers.get("cookie"),
});
// an `error=` return carries no token: delegateAuth.readLoginRequest({ cookie, state })
```

`beginLogin` makes a random `state` and `nonce`, signs them into a short-lived
`HttpOnly` cookie (`typ: e9.login`, 10 minutes), and returns the authorize
URL. `finishLogin` requires that cookie, the same `state`, and a token whose
`nonce` matches, then calls `login`. A mismatch throws `state_mismatch`
("Please sign in again"): start sign-in again, do not show an error. Send
`clearCookie` either way. The authorize URL asks for `expires_in=300`, so a
token in a query string is short-lived even if it leaks to logs or history.

`@engine9/id` already checks `state` and `nonce` in the browser.
`login(token, { nonce })` performs the same nonce check when you hold the
nonce yourself.

`createDelegateAuth({ sessionSecret })` requires the secret. `login()`
verifies the Identity Token, resolves the person, and returns
`{ session, token }`. `verify(token)` reads that token back. The session
object is:

```js
{
  (personId, // person in this database
    roles, // role_id values (segment UUIDs), copied when minted; see Permissions
    domainUnid, // the provider's id for this person on this Domain (token `sub`)
    email, // set when fields.email_verified is true (Google/Level 3
    // share of the provider email should mint that flag)
    auth, // { signInProvider, twoFactor, signInSecondFactor, authTime }
    level, // Identity Level from the provider
    sid, // random session id (revocation)
    iat, // unix milliseconds
    exp); // unix milliseconds
}
```

The host delivers the token: `/auth/callback` does it for you (above), or you
set the cookie yourself.

```js
createSessionCookieHeaders(token, {
  cookieName: "session",
  maxAge: 86400,
  secure: true,
  sameSite: "lax",
  path: "/",
});
// → Set-Cookie header value (HttpOnly)
```

The other delivery is the `X-Engine9-Session` header. Logout
(`POST /auth/logout`) returns `{ loggedOut: true, revoked }`. `revoked` is
true when a `sessionRevocations` store recorded it. Clearing the cookie or
dropping the header is the host's job, except the `e9_session` cookie that
`/auth/callback` set, which `POST /auth/logout` clears.

### Development

Local people APIs do not need a provider and do not need this secret.
`setup-keys` still writes `SESSION_SECRET` so the value is already there
when you turn login on. `createDelegateAuth` throws if `sessionSecret` is
missing; there is no built-in development key inside core. A laptop process
can use any string you put in `.env`. Production must use the random value
from the one-liner above, because a published default would let anyone mint
a session.

### The engine9 API host

The private server (Conductor and MCP against `data.engine9.ai`) uses the
same env name for the same job. After it verifies an Identity Token
(`aud` = the API origin), it signs an **operator session** and clients send
that as `Authorization: Bearer`. The HMAC check is local. Delegate is not
called again until the next login.

That session is not a Core Session. The body is the operator uid (the
Identity Token `sub` for the API host's domain), email, and
Identity Level (at least 3), and `exp` is unix seconds. By contrast, the Core Session
`@engine9/core` mints carries `personId` and roles, and uses unix milliseconds
for `exp`.
The two tokens do not verify against each other. Give the API host its own
`SESSION_SECRET`.

On that host the secret is required when `NODE_ENV=production`. Any other
`NODE_ENV` uses a fixed development key so a local API can sign sessions
without a provisioned secret. Production refuses that fallback.

## HTTP (`createApi`)

All routes except `GET /ok` require an API key.

- `Authorization: Bearer <jwt>` (3 segments, not an API key) resolves a
  session when `delegateAuth.verifyIdentityToken` exists.
  The person is found in SQL on every such request
  (`resolveDelegatePersonId`); nothing caches `person_id`.
- Keep `X-Engine9-Session` for HMAC sessions.

| Route               | Notes                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `POST /auth/login`  | API key; body `delegate_token`                                                           |
| `GET /auth/me`      | session or JWT → `{ personId, roles, level, domainUnid, fields?, auth }` |
| `POST /auth/logout` | API key; `{ loggedOut: true, revoked }`                                                  |
| `POST /auth/role`   | session/JWT `personId` must match `body.person_id`, or `admin` scope                     |

Error reasons include `invalid_identity_token` and `invalid_domain`.
