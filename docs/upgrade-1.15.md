# Upgrading to @engine9/core 1.15

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL), or
engine9 server accounts. Do every step for every site. The general process
is in [upgrading.md](upgrading.md).

## 1.15.0: Delegate moves to delegate.network

`https://delegate.engine9.ai` was retired on 2026-10-30. A site that still names it cannot sign anyone in.

### What to change in your site

A site that does not set `DELEGATE_URL` gets the new host by upgrading to
1.15.0. A site that names the old host anywhere must change that text. Find
every place:

```bash
rg -n "delegate\.engine9\.ai" . -g '!node_modules' -g '!dist' -g '!.wrangler'
```

| Where | Find | Change to |
| --- | --- | --- |
| `wrangler.jsonc` `vars` | `"DELEGATE_URL": "https://delegate.engine9.ai"` | Delete the line (the default is `https://delegate.network`), or set `"DELEGATE_URL": "https://delegate.network"` |
| `.env`, `.env.production`, `.env.<name>`, `.dev.vars` | `DELEGATE_URL=https://delegate.engine9.ai` | Delete the line, or `DELEGATE_URL=https://delegate.network` |
| Cloudflare dashboard (Worker variables), CI, and your host's environment | `DELEGATE_URL` set to the old host | Delete it, or set it to `https://delegate.network` |
| `createApi({ delegate: { delegateUrl } })` | `delegateUrl: 'https://delegate.engine9.ai'` | `delegateUrl: env.DELEGATE_URL` (unset uses the default), or `'https://delegate.network'` |
| `createDelegateAuth({ delegateUrl, issuer })` | `delegateUrl` or `issuer` naming the old host | Same values with `https://delegate.network`. Drop `issuer` unless you need to override it |
| `verifyDelegateIdentityToken({ token, delegateUrl, issuer })` | Same | Same |
| `delegateIdentityUrl({ delegateUrl, ... })`, `auth.identityUrl(...)` | Same | Same |
| Your own checks of the token's `iss` | `=== 'https://delegate.engine9.ai'` | Compare to your configured `delegateUrl` origin: `'https://delegate.network'` |
| Hard-coded links and fetches | `https://delegate.engine9.ai/user`, `/identity/authorize`, `/identity/bridge`, `/identity/logout`, `/.well-known/jwks.json`, `/.well-known/delegate-configuration` | Same paths on `https://delegate.network` |
| Content-Security-Policy (`connect-src`, `frame-src`, `form-action`), firewall and proxy allowlists | `delegate.engine9.ai` | `delegate.network` (add it before you remove the old entry) |
| Tests, mocks, and fixtures that sign tokens | `iss: 'https://delegate.engine9.ai'` | `iss: 'https://delegate.network'` |

Rules:

- **Change browser and server together, in one deploy.** The server
  (`@engine9/core`) checks the token's `iss` against the Delegate URL it was
  configured with. A browser on `@engine9/id` 1.13.0 sends people to
  `delegate.network`, and a server still configured for the old host rejects
  those tokens. See the matching steps in
  [`@engine9/id` CHANGELOG](https://github.com/engine9-ai/id/blob/main/CHANGELOG.md).
- **Do not accept both issuers.** Core verifies `iss` against the one
  `delegateUrl` you configure. There is no "either issuer" option, and none
  was added.
- **Registered Domains need nothing.** A Domain registered with Delegate works
  on the new host. Do not ask for a new registration.
- **Redeploy after the change.** A Worker reads `DELEGATE_URL` when it is
  deployed or restarted.

What your Users see: each User signs in once more, because the new host does
not have their Delegate session and tokens from the old host no longer verify.
Delegate recognizes the same account, so it is the same User and the same
Domain UNID, and no new person is created. Core Sessions already issued
(the `e9_session` cookie, `X-Engine9-Session`) are signed with your
`SESSION_SECRET`, not by Delegate, so they stay valid until they expire.


### What changed

- `DEFAULT_DELEGATE_URL` is `https://delegate.network` (was
  `https://delegate.engine9.ai`).
- Docs, examples, and tests use the new host.
- No schema change and no `lib/upgrades` entry. `e9core upgrade` has nothing
  new to apply.
- Documentation: do not run `installDefaultPlugins` while a visitor waits on
  the login return; ask whether the database is already installed and install
  only when it is not. See
  [docs/identityProviders/delegate.md](identityProviders/delegate.md#keep-the-return-from-delegate-fast).

## 1.15.3: PII-free is `exclude_pii` only

`exclude_pii` on `@engine9/schemas/utilities/limited-pii` is the only signal
that an account is PII-free. The limited-pii stack is an install list; it no
longer contributes `metadata.exclude`, and an installed stack alone does not
make `upgrade` report `pii_free` or re-select itself in
`installDefaultPlugins`. With the setting on, leftover plaintext plugin rows
are also skipped in the inbound weave. `bootstrapAccount({ exclude_pii: true })`
installs the utility, sets the setting, then installs the limited-pii stack.

### What a site changes

| Where | Find | Change to |
| --- | --- | --- |
| Accounts that rely on the limited-pii stack without the utility setting | Stack installed, `exclude_pii` unset or false | Install `@engine9/schemas/utilities/limited-pii` and set `exclude_pii` to `true` before upgrading core/schemas |
| Docs / runbooks that say "the stack excludes plaintext plugins" | Stack `exclude` as the install guard | Use `exclude_pii`; the stack only lists what to install |

No `lib/upgrades` entry. Pair with `@engine9/schemas` that drops `exclude`
from `stacks/limited-pii`.
