# Identity provider: delegate

**Delegate** is the default identity provider for a production `@engine9/core`
Site. It is optional. Local development of the people API does not need it.
Another provider can be used if it issues an Identity Token this Site can
verify. This is not OpenID Connect.

Core setup without a provider: [../deploy.md](../deploy.md).

## When you need it

| Environment | Identity provider |
| --- | --- |
| Local (`wrangler dev`, Node, laptop SQLite) | None. `POST /api/people` uses an API key |
| Production | Delegate, unless you configure a different provider |

## Words that belong to delegate

| Word | Meaning |
| --- | --- |
| **User** | The person delegate knows |
| **UNID** | Delegate’s id for that User. Core stores the link UNID → `person_id`. Delegate does not assign `person_id` |
| **Profile** | Fields the User agreed to share (`given_name`, `email`, …) |
| **Identity Token** | Short-lived JWT delegate signs. The Site verifies it |
| **Site** | Your website origin. The token `aud` claim must equal it |

## Production setup

Do this after `POST /api/people` works. See [../deploy.md](../deploy.md).

1. Allow your exact origin (for example `https://www.example.com`) on delegate.
   There is no OAuth client id. The Site is the origin.
2. `SESSION_SECRET` is already created by `npx e9core setup-keys`
   (`openssl rand -hex 32` is the same 32-byte value).
   `npx e9core setup-keys --remote` stores it as a Cloudflare secret.
   It signs the Core Session this Site checks on later requests, so those
   requests do not call Delegate again. Full account of the token, the cookie,
   and when a request still hits Delegate:
   [auth/README.md](../../auth/README.md#local-session-session_secret).
3. In the Worker, configure the default provider:

```js
import { createDelegateAuth, createSessionCookieHeaders } from '@engine9/core/auth/delegate';

const auth = createDelegateAuth({
  worker,
  delegateUrl: 'https://delegate.engine9.ai',
  site: 'https://www.example.com',
  sessionSecret: env.SESSION_SECRET,
  pluginId: env.E9_PLUGIN_ID,
  roles: {
    '<admin-segment-uuid>': {
      name: 'Admin',
      scopes: ['admin'],
      requiredAuth: { minLevel: 3 },
    },
  },
});
```

4. In the browser, `@engine9/id` talks to delegate and then calls
   `id.core.login()` with the public API key.
   See [id with core](https://github.com/engine9-ai/id/blob/main/docs/with-core.md).

## What core does with the token

`createDelegateAuth` verifies the JWT (ES256, JWKS, `iss`, `aud` = Site origin,
`exp`), maps the **UNID** to a `person_id`, reads segment roles, and may mint
a Core Session.

```js
const { session, token } = await auth.login(identityToken, {
  returnTo: 'https://www.example.com/auth/callback',
});
```

Verification steps:

1. Fetch `{delegateUrl}/.well-known/jwks.json` (cached in memory).
2. Verify ES256, `iss`, `aud === site`, `exp`.
3. Read `unid`, `level`, `profile`, and `auth` from the token.

Person resolution uses the UNID only. Email is copied onto the person record
only when it is verified or the Identity Level is at least 2.

## Login request fields

`POST /auth/login` (still needs an API key):

| Body field | When |
| --- | --- |
| `delegate_token` | Identity Token |

`GET /auth/me` includes `personId`, `roles`, `level`, and `unid`.

Send visitors to `/identity/authorize` (`auth.identityUrl`).

## Optional Cloudflare cache

On Workers you can pass `kvEnv: { PERSON_ID_DELEGATE_KV }` to `createApi`.
D1 remains the source of truth.

| Key | Value |
| --- | --- |
| `unid:<unid>` | `person_id` |
| `person:<person_id>` | `unid` |

Wire format: [id protocol](https://github.com/engine9-ai/id/blob/main/docs/protocol.md).
Browser library: [id deploy](https://github.com/engine9-ai/id/blob/main/docs/deploy.md).
