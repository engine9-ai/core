# `@engine9/core/auth`

Module reference for core authentication and authorization. Product vocabulary:
**User** (not Account), **Site** (not Audience). The JWT claim is still `aud`.

This is **not** OpenID Connect. Do not invent OIDC discovery, `id_token`
aliases, or extra OIDC claims. The wire protocol is
[`id/docs/protocol.md`](../../id/docs/protocol.md).

## Layout

| File | Role |
| --- | --- |
| `index.js` | API keys (`SqlApiKeyStore`, `KVApiKeyStore`, prefixes, catalog) |
| `policy.js` | Scopes, `requiredAuth` (`minLevel`, `twoFactor`), `resolveAuthContext` |
| `hmac.js` | `encoded.sig` HMAC helpers (Core Session + legacy bridge) |
| `delegate.js` | Identity Tokens, legacy handoff, person + role + session |
| `delegate.d.ts` | Types for `createDelegateAuth` and JWT verification |

## Authentication vs authorization

1. **API key** (layer 1) — enables the caller. Empty `scopes` deny. `admin`
   grants every scope. Prefix `e9key_` or `e9publickey_` (`public` scope).
2. **Role** (layer 2) — `role_id === segment_id`. Effective scopes =
   key ∩ role (`intersectScopes`).
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

`verifyDelegateIdentityToken({ token, delegateUrl, site, jwks?, issuer?, fetchImpl? })`

- GET `{delegateUrl}/.well-known/jwks.json` (in-memory cache by `delegateUrl`).
- Verify ES256, `iss` (default: delegateUrl origin), `aud === site`, `exp`
  (±60s).
- Returns a DelegateUser-like object: `unid`, optional `firebaseUid`, `email`
  from `profile` when `email_verified`, `auth` (`signInProvider` ←
  `auth.provider`, `twoFactor` ← `auth.two_factor`, `signInSecondFactor`,
  `authTime` ← `auth.auth_time`), `level`, `profileId` (`sub` if not
  `unid:…`), `profile`.

`firebaseUid` is optional. `resolveDelegatePersonId` only needs `unid`.

Email is written onto the person record only when
`delegateUser.emailVerified === true` **or** `delegateUser.level >= 2`.

## `createDelegateAuth`

```js
createDelegateAuth({
  worker,
  delegateUrl,
  site,              // Site origin for JWT aud; else returnTo origin on login
  handoffSecret,     // optional — legacy code/bridge only
  sessionSecret,     // required — HMAC Core Session
  pluginId,
  roles,             // { [segmentUuid]: { name, scopes, requiredAuth } }
  fetchImpl
})
```

`login(token)` detects:

| Form | Detection | Secret |
| --- | --- | --- |
| Identity Token | starts with `eyJ` and has two dots | none |
| HMAC bridge | contains `.` but is not a JWT | `handoffSecret` |
| Handoff code | 64-hex, or any other string without `.` | `handoffSecret` |

`verify(sessionToken)` returns `personId`, `roles`, `unid`, `email`, `auth`,
`level`, `profileId`, `exp`.

`verifyIdentityToken(jwt)` is the same JWKS check with constructor `site` /
`delegateUrl`.

## Core Session (host-delivered)

Sessions are compact HMAC tokens (`createSessionToken` /
`verifySessionToken`). The host sets the cookie or sends
`X-Engine9-Session`. Core does not store sessions.

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

Logout (`POST /auth/logout`) returns `{ loggedOut: true }`. Clearing the
cookie is the host's job.

## HTTP (`createApi`)

All routes except `GET /ok` require an API key.

- `Authorization: Bearer <jwt>` (3 segments, not an API key) resolves a
  session when `delegateAuth.verifyIdentityToken` exists.
- Optional `kvEnv` (`{ PERSON_ID_DELEGATE_KV }`): `getPersonIdByUnid` before
  SQL, `setDelegatePersonId` after resolve.
- Keep `X-Engine9-Session` for HMAC sessions.

| Route | Notes |
| --- | --- |
| `POST /auth/login` | API key; body `delegate_token` \| `delegate_code` \| `delegate_bridge` |
| `GET /auth/me` | session or JWT → `{ personId, roles, level, unid, profileId, profile?, auth }` |
| `POST /auth/logout` | API key; `{ loggedOut: true }` |
| `POST /auth/role` | session/JWT `personId` must match `body.person_id`, or `admin` scope |

## Legacy handoff

`delegateAuthorizeUrl` / `exchangeDelegateCode` / `verifyHandoffBridgeToken`
still use `DELEGATE_SHARED_SECRET`. Prefer Identity Tokens for new Sites.

Error reasons include `invalid_identity_token` and `invalid_site`.
