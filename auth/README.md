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
[`id` protocol](https://github.com/engine9-ai/id/blob/main/docs/protocol.md).

## Layout

| File | Role |
| --- | --- |
| `index.js` | API keys (`SqlApiKeyStore`, `KVApiKeyStore`, prefixes, catalog) |
| `policy.js` | Scopes, `requiredAuth` (`minLevel`, `twoFactor`), `resolveAuthContext` |
| `hmac.js` | `encoded.sig` HMAC helpers (Core Session + legacy bridge) |
| `delegate.js` | Identity Tokens, person + role + session |
| `delegate.d.ts` | Types for `createDelegateAuth` and JWT verification |

## Authentication vs authorization

1. **API key** (layer 1) — enables the caller. Empty `scopes` deny. `admin`
   grants every scope. Prefix `e9key_` or `e9publickey_` (`public` scope).
2. **Role** (layer 2) — `role_id === segment_id`. Effective scopes =
   key ∩ role (`intersectScopes`). Soft **declared roles** with the same
   `requiredAuth` shape (no `person_id`) are documented in
   [`@engine9/id` declared roles](https://github.com/engine9-ai/id/blob/main/docs/declared-roles.md)
   and demonstrated in [`demo-id`](https://github.com/engine9-ai/demo-id).
3. **Identity Level** (layer 3) — `requiredAuth.minLevel` and
   `requiredAuth.twoFactor` against the session / Identity Token. Levels are
   not authorization.

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
verifies the provider JWT and returns the provider user object. Email is
written onto the person record only when it is verified or the Identity Level
is at least 2.

## `createDelegateAuth`

```js
createDelegateAuth({
  worker,
  delegateUrl,
  domain,            // JWT aud (host[:port]); else domainFromUrl(returnTo) on login
  sessionSecret,     // required — HMAC Core Session
  pluginId,
  roles,             // { [segmentUuid]: { name, scopes, requiredAuth } }
  fetchImpl
})
```

`login(token)` accepts an Identity Token (JWT). Verification uses the
provider JWKS. No shared secret.

`verify(sessionToken)` returns `personId`, `roles`, `domainUnid`, `domainProfile`,
`email`, `auth`, `level`, `exp`.

`verifyIdentityToken(jwt)` is the same JWKS check with constructor `domain` /
`delegateUrl`.

## Local session (`SESSION_SECRET`)

A **Core Session** is a compact HMAC token the host mints after it has
verified an Identity Token. Later requests present that token. The host
checks the signature and `exp` in process. It does not call Delegate, fetch
JWKS, or read the database to decide that the caller is the same User who
just logged in.

The env name is **`SESSION_SECRET`**. It is the HMAC-SHA256 key. Anyone who
knows it can mint a session the host will accept, so production must use an
unguessable value kept out of git. Each host has its own value. One host’s
secret does not sign the engine9 API’s sessions, and the API’s secret does
not sign another host’s cookie.

Create one (32 random bytes, hex). This is the same generator `e9core
setup-keys` uses:

```bash
openssl rand -hex 32
```

`npx e9core setup-keys` writes `SESSION_SECRET` into `.env` next to the API
keys. `npx e9core setup-keys --remote` stores that value as a Cloudflare
secret. Rotate with `npx e9core setup-keys --rotate`, then `--remote` again.

### What it is, and what it is not

| Secret | Who holds it | What it does |
| --- | --- | --- |
| `SESSION_SECRET` | Your Domain’s host, or the engine9 API host | Signs that host’s local session |
| `E9_ADMIN_API_KEY` / `E9_PUBLIC_API_KEY` | The caller | Authorizes the HTTP API. Empty scopes deny |

Identity Tokens are verified with the provider’s public JWKS
(`{delegateUrl}/.well-known/jwks.json`). The signing key stays on the
provider.

An Identity Token proves the User to the host once. A Core Session is the
host’s own cache of that result. Login still needs Delegate (or another
provider). Requests after that need `SESSION_SECRET`.

### When a request hits Delegate

| Call | Credential | Delegate? |
| --- | --- | --- |
| `POST /auth/login` with `delegate_token` | Identity Token (JWT, `aud` = Domain) | Yes. JWKS verify, then map UNID → `person_id` |
| `GET /auth/me`, `POST /auth/role`, other routes with `X-Engine9-Session` or the session cookie | Core Session | No. HMAC + `exp` |
| Same routes with `Authorization: Bearer <jwt>` (three segments, not an API key) | Identity Token | Yes, when `verifyIdentityToken` is configured |
| `POST /people` and other data routes | API key | No |

Mint a session when the browser or app will call back many times and you
want those calls to skip the provider. Send the Identity Token on each
request when you would rather not hold a host session. People writes need
only an API key; they never read `SESSION_SECRET`.

### Token shape

`createSessionToken(payload, { secret, ttlSeconds })` builds
`base64url(JSON).base64url(HMAC-SHA256)`. The JSON is the payload plus
`exp` in unix milliseconds (`Date.now() + ttlSeconds * 1000`). Default TTL
is 86400 seconds. `verifySessionToken` returns the payload, or `null` when
the signature, encoding, or `exp` fails. Core does not store sessions.

`createDelegateAuth({ sessionSecret })` requires the secret. `login()`
verifies the Identity Token, resolves the person, and returns
`{ session, token }`. `verify(token)` reads that token back. The session
object is:

```js
{
  personId,          // person in this database
  roles,             // role_id values (segment UUIDs)
  domainUnid,        // the provider's id for this person on this Domain (token `sub`)
  domainProfile,     // which Profile is acting (token `domain_profile`)
  email,             // only when the provider said it was verified, or level >= 2
  auth,              // { signInProvider, twoFactor, signInSecondFactor, authTime }
  level,             // Identity Level from the provider
  exp                // unix milliseconds
}
```

The host delivers the token. Core will not set a cookie for you.

```js
createSessionCookieHeaders(token, {
  cookieName: 'session',
  maxAge: 86400,
  secure: true,
  sameSite: 'lax',
  path: '/'
})
// → Set-Cookie header value (HttpOnly)
```

The other delivery is the `X-Engine9-Session` header. Logout
(`POST /auth/logout`) returns `{ loggedOut: true }`. Clearing the cookie
or dropping the header is the host's job.

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
Identity Token `sub` for the API host's domain), email, `domainProfile`, and
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
- Optional `kvEnv` (`{ PERSON_ID_DELEGATE_KV }`): `getPersonIdByDomainUnid`
  before SQL, `setDelegatePersonId` after resolve.
- Keep `X-Engine9-Session` for HMAC sessions.

| Route | Notes |
| --- | --- |
| `POST /auth/login` | API key; body `delegate_token` |
| `GET /auth/me` | session or JWT → `{ personId, roles, level, domainUnid, domainProfile, profile?, auth }` |
| `POST /auth/logout` | API key; `{ loggedOut: true }` |
| `POST /auth/role` | session/JWT `personId` must match `body.person_id`, or `admin` scope |

Error reasons include `invalid_identity_token` and `invalid_domain`.
