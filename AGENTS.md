# Agent Guide

## Deploy docs

First-time Site setup (id vs core, Cloudflare + D1): [docs/deploy.md](docs/deploy.md).
Browser-only identity: [`id/docs/deploy.md`](../id/docs/deploy.md).

## Project

`@engine9/core` is a standalone library that creates an engine9-standard
database and HTTP endpoints, either as a site's primary database or alongside
another database. engine9 is the standard (tables, fields, pipeline, scopes)
as well as the code. Public libraries that share it include
[`@engine9/interfaces`](../interfaces) and [`@engine9/id`](../id); the festival
[`demo-festival`](../demo-festival) is a site built on both. The private `server` repo is for
people who already have an engine9-capable database.

An identity provider is optional. Production defaults to delegate
([docs/identityProviders/delegate.md](docs/identityProviders/delegate.md)).
Local development does not require one.

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

An identity provider is optional. People writes need an API key only.
Production defaults to delegate. Provider-specific terms (including UNID)
belong in [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md),
not in setup docs.

- Vocabulary in core docs: **User**, **Site**, **Identity Token**, **Identity Level**.
  The JWT claim remains `aud`.
- Do not invent OpenID Connect discovery, `id_token` aliases, or extra OIDC claims.
- A Core Session is an optional HMAC token the **host** delivers (cookie or
  `X-Engine9-Session`). Never required for authentication.
- Roles may set `requiredAuth.minLevel`; that is authorization policy, not
  an identity level itself.

Do not git commit unless the user asks.
