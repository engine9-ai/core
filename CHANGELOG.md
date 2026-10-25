# Release notes: @engine9/core

This file lists what changed in each release, what was retired, and what a
site should change. The current way to do things is in [README.md](README.md).
Upgrading a database (`e9core upgrade`) is in [docs/upgrading.md](docs/upgrading.md).

Only releases from the last week are listed here with site steps. Older
releases have a guide in `docs/upgrade-<version>.md`.

## 1.16.0: Login finds people by confirmed email; the KV caches are gone

Two changes. Read both before you deploy. Neither changes the database: there
is no `lib/upgrades` entry and nothing to run with `e9core upgrade`.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | A Delegate login finds the person by its confirmed email, not by the Domain UNID | Every site that signs people in with Delegate | No. Who a login resolves to can change |
| 2 | `PERSON_ID_DELEGATE_KV`, `PERSON_SEGMENT_VK`, and `@engine9/core/cloudflare/kv` are removed | Cloudflare sites that bound either namespace or import that path | Yes, if you import `@engine9/core/cloudflare/kv` |

### Find out whether this affects your site

Run in your site's repository:

```bash
rg -n "cloudflare/kv|kvEnv|PERSON_ID_DELEGATE_KV|PERSON_SEGMENT_VK|domain_unids|domainUnids" . -g '!node_modules'
rg -n "domainUnid|domain_unid|person_id_delegate" . -g '!node_modules'
rg -n "\.login\([^)]*person" . -g '!node_modules'
```

- No matches in the first command: change 2 needs nothing from you except
  deleting the KV namespaces if you created them (step 4 below).
- Matches in the second: read change 1, "Your own records".
- Matches in the third: read change 1, "`login(token, { person })`".

### 1. A login is found by its confirmed email

The Identity Token is a credential; core decides who the person is.

- **A login with a confirmed email** (`email_verified`, or Identity Level 2
  or more) finds the person core knows by that address, or creates one, the
  same way an import of that address would. The Domain UNID (`sub`) is no
  longer stored on that person.
- **A login with no confirmed email** (Level 0, a Facebook address, or a
  Grant that does not share `email`) is still found by the Domain UNID, with
  `merged_from` as before.

Before, both the Domain UNID and the email were identifiers, and whichever
matched first won. A person who changed the address they share could be
signed in as whoever owned the new address in one login and as their old
person in the next, or keep the new address on the old person.

What changes for people signing in:

| Situation | Before 1.16.0 | From 1.16.0 |
| --- | --- | --- |
| Signs in with the same address as always | Same person | Same person |
| Switches to an address core does not know | Same person; the new address added to it | A new person with that address. Signing in with the old address returns to the old person |
| Switches to an address another person in core has | That other person in some logins, their own in others | That other person, every time |
| Granted a role by address (`addPeople({ emails })`), then signs in with that address | The person their Domain UNID was first attached to, which may not hold the role | The person with that address, who holds the role |
| A Level 0 visitor who later signs in with a confirmed address | The visitor record and the person were joined | Not joined. The visitor record stays under the Domain UNID |
| Switched addresses before 1.16.0 | — | Both addresses are already on one person in core, so they stay one person |

The rule, the names (`sub`, `person_id`, `session.email`), and the use cases
are in
[auth/README.md](auth/README.md#who-is-signing-in-credential-identity-deduplication).

| Where | Find | Change to |
| --- | --- | --- |
| Your own records | Tables or lookups keyed on `session.domainUnid`, `sub`, or `person_id_delegate` | Key on `session.personId` |
| `login(token, { person })` | `person.email` meant to replace the token's address | Remove `email` from `person`. A confirmed email on the token always wins; `person.email` is used only when the token has none |
| "Change your Delegate information" / Switch email | Copy that promises the person's data follows them ("your stories stay with you") | "What you see here follows the address you sign in with" |
| Two addresses that must be one person | Expecting Delegate to join them | Join them in core: import both with the same `person_id` or `remote_person_id`, or merge |

New export: `delegateConfirmedEmail(delegateUser)` returns the confirmed
address, or undefined.

### 2. The KV caches are removed

`PERSON_ID_DELEGATE_KV` cached Domain UNID → `person_id` for API requests
that send an Identity Token as `Authorization: Bearer <jwt>`. It had no
expiry, and only erase cleared it, so an import or merge could leave a stale
`person_id`. `PERSON_SEGMENT_VK` had helper functions only; no core code read
or wrote it. Both are gone. `person_id` and segment membership are read from
D1 on every request.

| If your site… | What happens on 1.16.0 | What to do |
| --- | --- | --- |
| Imports `@engine9/core/cloudflare/kv` (`setDelegatePersonId`, `getPersonIdByDomainUnid`, `getDomainUnidByPersonId`, `deleteDelegatePersonId`, `addToSegment`, `removeFromSegment`, `isInSegment`, `listSegmentMembers` from that path) | **The build fails**: the path is no longer exported (`ERR_PACKAGE_PATH_NOT_EXPORTED`, or Wrangler "Could not resolve") | Delete the import and the calls before upgrading. Segment membership: `listSegmentMembers` from `@engine9/core/auth` (SQL) |
| Uses the Worker core ships (`@engine9/core/cloudflare/worker`) | Nothing. It no longer passes the binding | Nothing in code |
| Passes `kvEnv` to `createApi` in its own Worker | Ignored | Remove the option |
| Passes `kvEnv` or `domainUnids` to `worker.erasePeople`, or `domain_unids` to `POST /api/admin/erase` | Ignored. Erase still removes every database row for those people, including `person_id_delegate` | Remove them |
| Binds `PERSON_ID_DELEGATE_KV` or `PERSON_SEGMENT_VK` in `wrangler.toml` | The binding is unused | Remove it, then delete the namespace (steps below) |
| Sends `Authorization: Bearer <Identity Token>` to the API | Each request resolves the person in SQL (the people pipeline). Requests with a Core Session already carry `personId` and are unchanged | Prefer a Core Session (`POST /api/auth/login` once, then `X-Engine9-Session`) for repeated calls |

**Privacy:** an existing `PERSON_ID_DELEGATE_KV` namespace still holds
Domain UNID ↔ `person_id` pairs written before the upgrade, and erase no
longer touches it. Delete the namespace; do not leave it bound.

**Rollback:** 1.15.x runs without these bindings. If you roll back after
deleting the namespace, it reads from SQL. Do not roll back with the old
namespace still bound: 1.15.x would read entries written before the upgrade.

### Deploy steps, in order

1. Run the `rg` commands above and make the changes they call for.
2. Install `@engine9/core@1.16.0`, build, run your tests, and deploy.
3. Remove the `PERSON_ID_DELEGATE_KV` and `PERSON_SEGMENT_VK`
   `[[kv_namespaces]]` blocks from `wrangler.toml` (or `wrangler.jsonc`) and
   deploy again.
4. Delete the namespaces (Wrangler 3.60 or later):

   ```bash
   npx wrangler kv namespace list
   npx wrangler kv namespace delete --namespace-id <id of each one>
   ```

5. Sign in with a test address, then with a second address the site has never
   seen, and confirm `GET /api/auth/me` shows a different `personId` for each.

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

## 1.15.2: Test scripts

No change to what a site runs, and no `lib/upgrades` entry. Contributors:
`npm run test:auth` runs the auth tests, and `test:id-large` now loads the
plugin registry setup, as `npm test` does. Running a test file without
`--import ./test/setup-plugins.js` fails with "no plugin registry is
configured"; see `AGENTS.md`.

## 1.15.1: Retirement date

Documentation only; no code change and no `lib/upgrades` entry. 1.15.0 said
`delegate.engine9.ai` would stop working "no later than 2026-10-23". That date
was wrong. The old host is retired on **2026-10-30**. Everything in 1.15.0
below still applies.

## 1.15.0: Delegate moves to delegate.network

<!-- REMOVE-AFTER 2026-11-06: the retirement notice and the migration table below.
     One week after delegate.engine9.ai is retired (2026-10-30), delete everything from here
     to the matching "END REMOVE-AFTER" comment, and keep the "What changed" list. -->

> **`https://delegate.engine9.ai` is being retired. It will stop working on
> 2026-10-30. Move every site to `https://delegate.network` now.**

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

<!-- END REMOVE-AFTER 2026-11-06 -->

### What changed

- `DEFAULT_DELEGATE_URL` is `https://delegate.network` (was
  `https://delegate.engine9.ai`).
- Docs, examples, and tests use the new host.
- No schema change and no `lib/upgrades` entry. `e9core upgrade` has nothing
  new to apply.
- Documentation: do not run `installDefaultPlugins` while a visitor waits on
  the login return; ask whether the database is already installed and install
  only when it is not. See
  [docs/identityProviders/delegate.md](docs/identityProviders/delegate.md#keep-the-return-from-delegate-fast).

## Site steps for the last week's releases

If you are on a release older than 1.11.0, do each section from your version
up, in order. After the last one, run `npx e9core upgrade --url <site>`
(or `--db <url>`).

### 1.14.0 (2026-10-23): one-link sign-in and a role gate

Added: `GET /api/auth/start`, `GET /api/auth/callback`,
`@engine9/core/auth/gate` (`requireRole`, `createGate`),
`@engine9/core/auth/signIn`, `POST /api/admin/install-default-plugins`, and
`e9core installDefaultPlugins --url <site>`.

| Where | Change |
| --- | --- |
| Your own sign-in route | Optional. Replace it with `<a href="/api/auth/start?returnTo=/members">Log in</a>`. Set `config.signIn` (`minLevel`, `fields`, `loginProviders`, `brand`, `sessionCookie`, `sessionTtlSeconds`). On the Cloudflare example Worker it is the `E9_SIGN_IN` variable (JSON) |
| Any route you serve at `/api/auth/start` or `/api/auth/callback` | Rename it. Core now answers those paths |
| A page you protect in your own Worker | Optional. `const gate = await requireRole({ auth: api.delegateAuth, request, role: 'admin' })`. It reads `person_segment` now, not the roles copied into the cookie |
| `brand.google: 'skip'` in `config.signIn`, `identityUrl`, or `@engine9/id` | Delete it. It is accepted and does nothing extra; one provider on a full-page login opens by itself |
| A fresh Cloudflare database whose tables you created by replaying SQL | Use `npx e9core installDefaultPlugins --url https://www.example.com` |
| Logout | `POST /api/auth/logout` now also clears the `e9_session` cookie that `/auth/callback` set |

### 1.13.1 (2026-10-23): manage segments on a deployed site

Added: `e9core segment list|members|add|remove --url <site>`,
`GET /api/admin/segments`, `GET /api/admin/segments/:segment/members`, and
role names as `segment_id` in `POST /api/auth/segments`.

| Where | Change |
| --- | --- |
| First admin on a Cloudflare (D1) site | `npx e9core segment add --segment admin --url https://www.example.com --email you@example.org`. It uses the production admin key (`--key`, `E9_ADMIN_API_KEY`, or `.env.production`) |
| A plugin package of your own that declares `exports` | `build-plugins` writes only exported paths. Export `<dir>/index.js` and re-export `schema` and `settings` from it. A plugin the package does not export stops the build with `PLUGIN_CONFIG_INVALID` |

### 1.13.0 (2026-10-22): admin and superadmin; `operator` removed

Full steps: [docs/upgrade-1.12.md](docs/upgrade-1.12.md). (That guide is
titled 1.12.0; the published version is 1.13.0.) Requirements:
[PERMISSIONS.md](PERMISSIONS.md).

| Where | Change |
| --- | --- |
| Config, code, or data that names the `operator` role | Remove it. `ROLE_NAMES.OPERATOR` is gone and `roles: 'standard'` installs only `admin`. Existing `operator` rows stay and grant nothing |
| Former operators | Make them `admin` for their account: `npx e9core segment add --segment admin --email sam@example.com` (add `--url <site>` for a deployed site) |
| Staff who need every account | `npx e9core superadmin add --email chris@example.com`. On Cloudflare set `E9_SUPERADMINS` (comma-separated) in the Worker's vars and redeploy |
| A privileged decision in your code | `auth.rolesForSession(session)`. `auth.rolesForPerson(personId)` does not see superadmins |
| `@engine9/input-tools` | Now `^2.6.0` |

### 1.11.3, 1.11.2, 1.11.1 (2026-10-20 and 2026-10-21): plugin settings

Full steps: [docs/upgrade-1.11.md](docs/upgrade-1.11.md).

| Where | Change |
| --- | --- |
| Install | `npm install @engine9/core@^1.11.3 @engine9/schemas@^1.11.3`, deploy |
| Database | `npx e9core upgrade --url https://www.example.com --dry-run`, then without `--dry-run`. `setting_value_text` widens `setting.value` to `text` |
| A `*_custom_fields` setting saved before the upgrade | Re-save it with `setSetting` if it was cut at 255 characters |
| Code that sets a setting | `setSetting` now throws before inserting a value that does not fit the column. Catch the error instead of expecting a silent cut |
| A plugin of your own that declares settings | A setting name must be unique across the plugin and its submodules. A duplicate now throws `Duplicate setting "<name>"`; rename one |
| Scripts | Use Node.js, not Python, for deploy and maintenance scripts ([docs/deploy.md](docs/deploy.md#scripting-use-nodejs-not-python)) |

### 1.11.0 (2026-10-16): safer login and sessions

| Where | Change |
| --- | --- |
| A server callback that receives the token in the URL (`response_mode=query`) | Replace `login(token)` with `auth.beginLogin({ returnTo })` on the way out and `auth.finishLogin(delegate_token, { state, cookie })` on the way back. A `state_mismatch` means "sign in again", not an error. The authorize URL now asks for a 5-minute token |
| Logout | Pass a KV-like store as `delegate.sessionRevocations` (Cloudflare: bind `SESSION_REVOCATIONS`) so logout ends the session token, not only the cookie. Without it logout only clears the cookie |
| Sessions minted before this release | They have no `typ` and are accepted until they expire (`acceptLegacySessions: true`). A day after upgrading, set `acceptLegacySessions: false` |
| Production keys | Run `npx e9core setup --remote` (or `setup-keys --remote`, add `--env staging` for another environment). Production gets its own admin key and `SESSION_SECRET`, saved in `.env.production`; the old admin key stops working in production and everyone is signed out. Update CI and scripts that call production with the admin key |
| Privileged decisions | Read `auth.rolesForPerson(personId)` at that moment. The `roles` in a session are a copy for deciding what to show |
| Requests that name a `role_id` | Send one only for a role the caller holds. Any other is `403` (`unknown_role` or `role_not_held`); it no longer falls back to the key's scopes |
| `GET /api/read/:name?person_id=` | With a session it reads the signed-in person. Another `person_id` needs `admin` |
| Erasing a person | New: `POST /api/admin/erase` with `{ person_ids, dry_run: true }` first |

## Older releases

[1.10.1](docs/upgrade-1.10.md) (person names move to `person_name`),
[1.9.1](docs/upgrade-1.9.md) (package rename).
