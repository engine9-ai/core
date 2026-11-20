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
| `index.js`         | API keys (`SqlApiKeyStore`, prefixes, catalog)                                                        |
| `policy.js`        | Scopes, `requiredAuth` (`minLevel`, `twoFactor`), `resolveAuthContext`                                                 |
| `hmac.js`          | `encoded.sig` HMAC helpers (Core Session + legacy bridge)                                                              |
| `delegate.js`      | Identity Tokens, person + role + session                                                                               |
| `delegate.d.ts`    | Types for `createDelegateAuth` and JWT verification                                                                    |
| `logins.js`        | `person_login` (`@engine9/schemas/login`): whether this database has sign-in (`loginMode`), who a sign-in is (`personForSignIn`), roles through a login, grants by email, the `e9core signin` actions |
| `linkTokens.js`    | Link tokens: an outside sender's signed note of which person an email went to, for one-click forms ([docs/link-tokens.md](../docs/link-tokens.md)). Never a session |
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

Sign-in, the session, and access checks are core's. Use them before writing
your own. With Delegate login, the default is core's Login button (two lines
in the page header, `GET /api/auth/login.js`), not a sign-in flow of the
site's own: [docs/sign-in.md](../docs/sign-in.md).

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
`POST /auth/segments`). For someone who left, also retire their logins
(`e9core signin retire --person <id>`). Core's API and `requireRole` read
roles through the login on every request, so the next request sees it. To end the session itself,
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
`resolveDelegateLogin` (and `resolveDelegatePersonId`, which returns only the
id) finds the person for it, by the rule in the next section.

## Who is signing in: logins, people, deduplication

A sign-in involves four different things. Keep them apart.

| | What it is | Decided by | Stored in |
| --- | --- | --- | --- |
| **Credential** | The Identity Token. Delegate says: this browser's Delegate account controls this address, at this Identity Level, for this Domain | Delegate | The token, then the Core Session |
| **Login** | Who can sign in, and as which person: a Delegate account (by Domain UNID) or a verified address (by `email_hash_v1`) | Sign-in, an admin's grant or link, `e9core signin`, the login plugin's upgrade | `person_login` |
| **Identity** | The person: one `person` row and its `person_id` | core | `person` and the person tables |
| **Deduplication** | Whether two identifiers (two addresses, an address and a CRM id) are one person's data | The people pipeline, from imports and forms | `person_id_*` |

`person_login` is this database's `/etc/passwd`. It belongs to the login plugin
(`@engine9/schemas/login`, which no edition includes), which a site needs to have
sign-in: a database without it has no sign-in (`loginMode` `off`), and every
sign-in stops with `sign_in_off`. Deduplication files data,
and public forms write it, so it never decides who someone signs in as: a
sign-in or a grant with no login is a new person. Joining a login to a
record that already exists is an explicit act: an admin's link, or a merge
tool ([docs/merge-tools.md](../docs/merge-tools.md)).
[auth/logins.js](logins.js) has every rule; PERMISSIONS.md PL-13 is the
requirement.

### The names

| Name | Meaning |
| --- | --- |
| `sub` (Domain UNID) | Delegate's id for the Delegate account on this Domain, `domain:hex`. The same for every address that account holds. On the session as `domainUnid` |
| `fields.email`, `fields.email_verified` | The address the account chose to share with this Domain, and whether Delegate confirmed it |
| Confirmed email | `email_verified` is true. `delegateConfirmedEmail(delegateUser)` returns it, or undefined. Level 2 alone can mean a verified phone |
| Login | One `person_login` row: `type` (`delegate` or `email`), the hash, the person, `how` (`created` by a first sign-in, `granted` by an admin, `backfill` by the upgrade), `state` (`active`, `locked`, `retired`). An email login also keeps the Delegate account that first signed in with it |
| `person_id` | core's id for the person. Roles (`person_segment`) and every person table hang on it. On the session as `personId` |
| `session.email` | The confirmed address of this sign-in. Undefined when there is none |

### The rule

At Identity Level 2 and above (`personForSignIn`):

1. **The Delegate account's login**, if it has one. Locked or retired: stop
   (`login_locked`).
2. Else a **`merged_from` login**: Delegate merged that account into this one.
3. Else the **address's login**. Locked: stop. Retired: a new person (the
   address was offboarded). First used by a different Delegate account: stop
   (`login_reassigned`). Otherwise sign in, and the account is recorded on
   the address. This is how a granted or upgraded admin's first sign-in works.
4. **No login:** **a new person**. Never a record found by the address or
   by the Domain UNID: both are dedupe data, which imports and forms write
   too.
5. The logins the token brings are written on the person, and the sign-in's
   own data (fields the site passed, the address when no other record holds
   it) is filed on that person through the people pipeline.

Sign-in starts at Identity Level 2. Core asks Delegate for at least
Level 2, and a token below it stops with `level_too_low` before anything
is read or written. A session below Level 2 is no session, and holds no
role. People who do not sign in are found by what they send (forms,
imports), never through Delegate.

**Sign-in links** are the one sign-in without Delegate: an admin runs
`e9core signin invite --email …` for an address with an active login and
emails the URL. Core signs it with `SESSION_SECRET` (type
`e9.signin_link`, never a session); `GET /auth/link` shows a Sign in
button and changes nothing; `POST /auth/link` from that page uses it
once (`useSignInLink`: the login's `last_sign_in_at`, compared as stored,
must not have changed) and starts a Level 2 session. See
[docs/sign-in.md](../docs/sign-in.md#sign-in-links).

**Link tokens** ([linkTokens.js](linkTokens.js),
[docs/link-tokens.md](../docs/link-tokens.md)) are not sign-in: an outside
sender's ES256 note of which person an email went to, which files one
`POST /people` row on that person. Never a session or a role.

A grant by email follows the same rule: the address's login, else a new
person with a `granted` login. `e9core signin link --email … --person <id>`
before the grant puts the login on an existing record instead.

A Delegate account that first signed in without a confirmed address
(Microsoft, Facebook, a phone) and later proves an address an admin granted,
moves to the granted person once, when its own person holds nothing.

### The stops

The Login button shows them; `/api/auth/callback` shows the same page
without JavaScript. Every stop issues no session and shows no `person_id`
and no full address.

| Reason | The Login button says | Ways forward |
| --- | --- | --- |
| `login_reassigned` | This address signs in here through a different Delegate account. Ask the site's administrator | An admin retires the old login, or links the new account |
| `login_locked` | This sign-in is turned off. Ask the site's administrator | An admin unlocks it |
| `sign_in_off` | This site does not have sign-in yet | The owner adds `@engine9/schemas/login` |

### Use cases

| The person… | What happens |
| --- | --- |
| Was imported, and an admin linked their address to that record | Their first sign-in lands on it (the invite flow) |
| Was granted a role by address, and signs in for the first time | The granted login finds the person the grant made |
| Is on file but nobody linked them, and signs in for the first time | A new person; an admin links them, or a merge tool joins the records |
| Signs in again | Their Delegate account's login finds the same person |
| Changes the address they share, in the same Delegate account | Same person; the new address becomes a login too |
| Moves to a new Delegate account | **Add a sign-in address** from the old session (Login button), then retire the old one |
| Has two addresses on one record | An admin links one; the person adds the other with **Add a sign-in address** |
| Shares one imported record with someone else (a household) | Each signs in to a record of their own |
| Reuses an address a former colleague signed in with | `login_reassigned`; offboarding retires the old login |
| Is offboarded | `e9core signin retire --person <id>`; their address, used by someone new later, gets a new person |

### What a site does

- Use `session.personId` for everything you store. Do not key your own tables
  on `sub` or on an email address.
- Show `session.email` as "signed in as". It is always the address of this
  sign-in.
- Leave sign-in choices to the Login button: switching address, the stops,
  adding an address. Add no link or page of your own for them.
- To make two addresses one person's data, join them in an import or a merge.
  To make them one person's **logins**, the person adds the address in the
  Login button, or an admin runs `e9core signin link`.

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

A person never chooses it. Anyone who signs in once holds a session signed
with it, and can test guesses against that session offline, with no rate
limit, so a phrase falls in minutes. `npx e9core setup-keys` writes
`SESSION_SECRET` (and `AGENT_CREDENTIALS_SECRET`) into `.env` next to the API
keys. `npx e9core setup-keys --remote` gives a Cloudflare environment its own
and stores them as secrets. Rotate with `npx e9core setup-keys --rotate`, then
`--remote` again.

The value is 32 random bytes as 64 hex characters. `createDelegateAuth`
throws on anything else, `createApi` leaves login off and says why, and
`e9core status` fails the check. `setup-keys` replaces a value of any other
form. On your own servers, where setup-keys does not reach production, use the
same generator:

```bash
openssl rand -hex 32
```

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
  path on this site; anything else becomes `/`. `login_hint=<email>`,
  `prompt=select` (let the visitor choose another account), and
  `reason=access_denied` (from an access-denied page; implies
  `prompt=select`, and Delegate says why) are the only other query
  parameters. `signInUrl(path)` and `changeSignInUrl(path, { reason? })` in
  `@engine9/core/auth/signIn` build these links. Everything else is `config.signIn`: `minLevel`
  (default 2; a lower value is raised to 2), `maxLevel`, `fields` (default `['email']`), `optionalFields`,
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

### Browser sign-in to the same cookie (`/auth/begin`, `/auth/login` with `cookie: true`)

The recommended way for page JavaScript (the `@engine9/id` widget with
`core.session: 'cookie'`) to sign in. It ends in the same `e9_session`
cookie as the redirect above, so the gate does not care which one the person
used.

- `POST /auth/begin` (public key) returns `{ state, nonce }` and sets the
  signed `e9_login` cookie (`auth.beginLoginRequest()`). The page asks
  Delegate with that state and nonce.
- `POST /auth/login` with `{ delegate_token, state, cookie: true }` runs
  `finishLogin`: `state` and the token's nonce must match `e9_login`, and the
  `Origin` must be this site's (else `403 origin_mismatch`). It sets
  `e9_session`, clears `e9_login`, and answers `{ session }` with no token.
  A token for another request is `401 state_mismatch`.
- `POST /auth/role` from a cookie session (changing your own role) re-signs
  the cookie and leaves the token out of the body.

Without `cookie: true`, `/auth/login` answers `{ session, token }` as
before, for a page with no server of its own.

To lock a page you serve yourself, check the cookie in the same Worker:

```js
import { requireRole } from '@engine9/core/auth/gate';

const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' });
if (!gate.ok) return gate.response; // 302 to /api/auth/start, 401, or a 403 page
// gate.session, gate.roles
```

A page load gets the 302 or an HTML 403. `fetch()` from page code gets JSON:
401 `{ reason: 'sign_in_required', signInUrl }`, or 403
`{ reason: 'role_not_held' | 'auth_not_met', role, email, changeUrl }`. A
signed-in person is never redirected to sign in: Delegate would return the
same address and they would loop. The 403 says who they are signed in as and
links to `changeUrl` (`prompt=select&reason=access_denied`). The result
carries `reason`, `email`, `role`, `signInUrl`, and `changeUrl` for a site
that renders its own 403. What a site should and should not build:
[docs/sign-in.md](../docs/sign-in.md).

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

A request whose API key is refused never reaches these routes. It gets
`401 { error: 'unauthorized: <reason>', reason, kind: 'api_key', hint }`, and
the Worker logs `engine9 api key rejected: <reason> key_hash=<12 hex>`. Show
`kind: 'api_key'` as a site problem, not as "sign in again"
([deploy.md](../docs/deploy.md#when-the-api-answers-unauthorized)).
