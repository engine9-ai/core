# Agent Guide

## Project

`@engine9/core` is the slim engine9 deployment for Sites: people pipeline,
SQL workers, API keys, and optional delegate identity. It is not the full
engine9 server.

## Tests

```
npm test
```

Auth-related only:

```
node --test --test-concurrency=1 test/auth.policy.test.js test/delegate.auth.test.js test/api.auth.test.js test/api.test.js
```

Do not start HTTP servers unless asked.

## Identity

Core is an optional **Site** server for the delegate identity protocol
(`../id/docs/protocol.md`).

- Vocabulary: **User** (not Account), **Site** (not Audience). The JWT claim
  remains `aud`.
- Identity Tokens are delegate-signed **ES256 JWTs**, verified via JWKS
  (`iss`, `aud` = Site origin, `exp`). This is **not OIDC**. Do not invent
  OpenID Connect discovery, authorization-code-as-OIDC, `id_token` aliases,
  or extra OIDC claims.
- A Core Session is an optional HMAC token the **host** delivers (cookie or
  `X-Engine9-Session`). Never required for authentication.
- Legacy handoff (`delegate_code` / `delegate_bridge`) still works when
  `handoffSecret` is set. JWT login does not need that secret.
- Roles may set `requiredAuth.minLevel`; that is authorization policy, not
  an identity level itself.

Do not git commit unless the user asks.
