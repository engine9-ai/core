# Identity provider: delegate

**Delegate** is the default identity provider for a production `@engine9/core`
deployment. It is optional. Local development of the people API does not need it.
Another provider can be used if it issues an Identity Token this host can
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
| **UNID** | Delegate’s id for the person. It stays on delegate. Core never sees it |
| **Domain UNID** | This Domain’s id for the person (`sub`, `domain:hex`). Core stores Domain UNID → `person_id` |
| **Fields** | Values the User agreed to share (`given_name`, `email`, …), on the Identity Token as `fields` |
| **Grant** | Which of the requested fields this Domain may receive. Core does not store the field values on the session |
| **Identity Token** | Short-lived JWT delegate signs. The host verifies it |
| **Domain** | Host or `host:port` for your site. The token `aud` claim must equal it (not a full `https://` origin) |

## Production setup

Do this after `POST /api/people` works. See [../deploy.md](../deploy.md).

1. Allow your login Domain (for example `www.example.com`) on delegate.
   There is no OAuth client id. The Domain is the JWT `aud` value.
   `localhost:3000`–`3003` are pre-allowed on the public delegate for
   development.
2. Make sure `SESSION_SECRET` is set. `npx e9core setup` (and `setup --node`)
   writes it to `.env`; `npx e9core setup --remote` stores it as a Cloudflare
   secret (`openssl rand -hex 32` is the same kind of value). It signs the
   Core Session this host checks on later requests, so those requests do not
   call Delegate again. Full account of the token, the cookie, and when a
   request still hits Delegate:
   [auth/README.md](../../auth/README.md#local-session-session_secret).
3. Server side, that is all. The shipped Worker
   ([`cloudflare/worker.js`](../../cloudflare/worker.js)) and `e9core serve`
   turn on `/auth/*` whenever `SESSION_SECRET` is present. In your own
   `createApi` call, pass the same thing:

```js
const api = createApi({
  worker,
  keyStore,
  delegate: {
    sessionSecret: env.SESSION_SECRET,
    // delegateUrl: env.DELEGATE_URL,   // default https://delegate.engine9.ai
    // domain: 'www.example.com',       // only when /api is on a different host than the pages
  },
  config: {
    pluginId: env.E9_PLUGIN_ID,
    roles: {
      '<admin-segment-uuid>': { name: 'Admin', scopes: ['admin'], requiredAuth: { minLevel: 3 } },
    },
  },
});
```

   The JWT `aud` defaults to the request's page `Origin`, else the API
   `Host` — correct whenever pages and `/api` share a hostname. Set
   `E9_DOMAIN` (or `delegate.domain`) when they do not. For full control,
   build the provider yourself with `createDelegateAuth` from
   `@engine9/core/auth/delegate` and pass it as `delegateAuth`.

4. In the browser, `@engine9/id` talks to delegate and then calls
   `id.core.login()` with the public API key:

```html
<script src="https://unpkg.com/@engine9/id@1/dist/id.iife.js"></script>
<script>
  const id = engine9Id.mount({
    core: { apiUrl: '/api', publicApiKey: 'e9publickey_…' },
  });
  id.onChange(async (identity) => {
    if (identity && identity.level >= 1) await id.core.login();
  });
</script>
<button data-e9-login>Log in</button>
```

   `id.core.login()` posts `{ delegate_token }` to `POST /api/auth/login`
   and keeps the returned Core Session for `id.core.me()`,
   `id.core.changeRole()`, and `id.core.fetch()`. Page-side content gates
   (`data-e9-min-level`, `id.gate()`) are soft; core's roles are the hard
   gate. See [id with core](https://github.com/engine9-ai/id/blob/main/docs/with-core.md).

5. Add a **Change your Delegate information** button for signed-in people.
   Include it unless the site asks for no fields.

   Delegate remembers which email address each person shares with your
   Domain, so logging in again returns the same address. When someone shared
   the wrong one (a personal Gmail instead of the address your roles
   expect), this button reopens delegate's share page. There they can pick
   another address, add one, or use a different Google account.

```html
<button data-e9-change-delegate hidden>Change your Delegate information</button>
```

   The existing `id.onChange` handler calls `id.core.login()` again with the
   new token, so roles are re-read. Picking another address keeps the same
   Domain UNID and `person_id`. A different Google account arrives as a
   different Domain UNID, which is a different person to core.

   Sites that log in on the server instead add a route that redirects to the
   same request with `prompt: 'select'`:

```js
return Response.redirect(auth.identityUrl({
  returnTo: new URL('/auth/callback', request.url).toString(),
  prompt: 'select',
  minLevel: 1,
  fields: ['display_name', 'email'],
}), 302);
```

   Put the link next to Log out and on any access-denied message.

6. Choose delegate's sign-in screen. Skip this step if Google-only is right
   for your site.

## Sign-in screen: Google only, or Google plus an email link

A visitor who is not signed in to delegate yet sees one of two screens.

| Option | Screen | Highest Level the sign-in can reach |
| --- | --- | --- |
| default (omit `loginLevel`, or `3` / `4`) | Sign in with Google | 4 |
| `loginLevel: 2` | Sign in with Google, or Email me a sign-in link | 2 for the email link, 4 for Google |

Google only is the default because an emailed link proves only that the
person reads that inbox: Level 2 (Contact Confirmed). Core roles that set
`requiredAuth: { minLevel: 3 }` (the standard `admin` and `operator` roles
do) can never be met by an email-link sign-in. Offering the link on those
logins would let people sign in and then be refused.

Offer the email link when Level 2 or lower is all the site needs, such as
newsletter signups, RSVPs, or comments, and you want people without a Google
account to get in:

```js
// Browser (@engine9/id): every login on the site
const id = engine9Id.mount({
  core: { apiUrl: '/api', publicApiKey: 'e9publickey_…' },
  loginLevel: 2,
});
```

```html
<!-- Browser: just this button -->
<button data-e9-login="2" data-e9-login-level="2">Join the list</button>
```

```js
// Server: a login route that redirects to delegate
return Response.redirect(auth.identityUrl({
  returnTo: new URL('/auth/callback', request.url).toString(),
  minLevel: 2,
  loginLevel: 2,
  fields: ['display_name', 'email'],
}), 302);
```

Rules delegate applies:

- With `minLevel` 3 or higher, delegate shows Google only, even when you
  pass `loginLevel: 2`.
- The screen does not change the Identity Level on the token, and it does
  not change what core's roles allow. A visitor who picks Google on the
  `loginLevel: 2` screen still arrives at Level 3. A role with
  `requiredAuth.minLevel: 3` still refuses an email-link login.
- Visitors already signed in to delegate do not see either screen.

On the wire this is `login_level=2` on `/identity/authorize`
([protocol](https://github.com/engine9-ai/id/blob/main/docs/protocol.md#sign-in-screen-login_level)).

## What core does with the token

`createDelegateAuth` verifies the JWT (ES256, JWKS, `iss`, `aud` = domain,
`exp`), maps the **Domain UNID** (`sub`) to a `person_id`, reads segment
roles, and may mint a Core Session.

```js
const { session, token } = await auth.login(identityToken, {
  returnTo: 'https://www.example.com/auth/callback',
});
```

Verification steps:

1. Fetch `{delegateUrl}/.well-known/jwks.json` (cached in memory).
2. Verify ES256, `iss`, `aud === domain`, `exp`.
3. Require `sub` to start with `domain:`. Read `merged_from`, `level`,
   `fields`, and `auth` from the token.

Person resolution uses the Domain UNID. When Delegate merges a second
browser into the person's UNID at sign-in, the next token carries
`merged_from`, the Domain UNID that browser had before. Core records it as a
second delegate id for the same person, so the earlier anonymous visits join
the signed-in person. Roles gate on `level` through `requiredAuth.minLevel`. Email is copied onto the person record only when it is
verified or the Identity Level is at least 2.

## Login request fields

`POST /auth/login` (still needs an API key):

| Body field | When |
| --- | --- |
| `delegate_token` | Identity Token |
| `domain` | Optional override for JWT `aud` (host[:port]); else derived from `return_to` |

`GET /auth/me` includes `personId`, `roles`, `level`, `domainUnid`, and `fields` when the request used an Identity Token.

Send visitors to `/identity/authorize` (`auth.identityUrl`). Pass
`prompt: 'select'` for the Change your Delegate information link (step 5),
and `loginLevel: 2` to offer an email sign-in link
([Sign-in screen](#sign-in-screen-google-only-or-google-plus-an-email-link)).

## Optional Cloudflare cache

On Workers you can pass `kvEnv: { PERSON_ID_DELEGATE_KV }` to `createApi`.
D1 remains the source of truth. A token with `merged_from` skips the cache
read so the earlier id is linked in SQL.

| Key | Value |
| --- | --- |
| `delegate:<domain_unid>` | `person_id` |
| `person:<person_id>` | Domain UNID |

Wire format: [id protocol](https://github.com/engine9-ai/id/blob/main/docs/protocol.md).
Browser library: [id deploy](https://github.com/engine9-ai/id/blob/main/docs/deploy.md).
