# Permission levels

This is the normative description of who may do what on an `@engine9/core`
site and on the engine9 server, how to put it in place, and how to bring an
existing site up to it. Security reviews and automated checks measure sites
against the numbered requirements here (**PL-1** to **PL-12**; the ids are stable and are grouped by topic, not in
numeric order). When this
page and another page disagree, this page is the intended behavior and the
other page is a bug.

Applies to `@engine9/core` **1.12.0 and later**. Sites on earlier versions:
see [Converting an existing site](#converting-an-existing-site).

Related pages, which explain mechanisms rather than set requirements:
[docs/roles.md](docs/roles.md), [docs/segments.md](docs/segments.md),
[auth/README.md](auth/README.md), [docs/upgrading.md](docs/upgrading.md),
[docs/upgrade-1.12.md](docs/upgrade-1.12.md).

## Contents

1. [The levels](#the-levels)
2. [What each level can and cannot do](#what-each-level-can-and-cannot-do)
3. [How a request is decided](#how-a-request-is-decided)
4. [Requirements](#requirements)
5. [Implementing on a new site](#implementing-on-a-new-site)
6. [Converting an existing site](#converting-an-existing-site)
7. [Verifying a site](#verifying-a-site)
8. [Operating it: granting, removing, incidents](#operating-it-granting-removing-incidents)
9. [The engine9 server](#the-engine9-server)
10. [Do not](#do-not)

## The levels

Four permission levels exist. There are no others, and core ships no other
role names.

| Level | What it is | Recorded in | Reach |
| --- | --- | --- | --- |
| **Visitor** | Anyone, signed in or not. Holds no role. | Nowhere | Public routes, and only what the API key in use allows (a browser holds only the public key). |
| **Site role** (optional) | A named role you define for your site, such as a content curator. | `person_segment` in your database, plus an entry in `config.roles` | Only the scopes you give that role. Never more than the key in use allows. |
| **Admin** | A member of the account's `admin` role segment. | `person_segment` in **that account's own database** | One account. May change the account. |
| **Superadmin** | A verified email on a list. | A **file** (or the `E9_SUPERADMINS` variable). Never a database. | Every account the process serves. |

Two ideas are deliberately separate:

- **Permission** is what you may do. It comes from role membership and from
  the API key in use.
- **Identity Level** (0 to 7, from the identity provider) is how sure the
  site is who you are. It is never permission by itself. A Level 4 person in
  no role has no scopes. Roles can demand a minimum level.

Admin is **database based** and superadmin is **file based**. That is the
whole design: an organization's own people are admins of its account and are
recorded where the account's data lives; engine9 staff who work across many
accounts are superadmins and are recorded in one reviewable file that no
account database can alter.

The `operator` role from earlier releases no longer exists. See
[Converting an existing site](#converting-an-existing-site).

## What each level can and cannot do

### Visitor

- Can submit forms and signups that the public key permits, and add or
  remove themselves from segments whose `join_min_level` / `leave_min_level`
  allow it at their Identity Level.
- Cannot read data, change other people, or reach any admin route.
- In a browser the only key present is the public key (`e9publickey_…`,
  scope `public`).

### Site role

- A role is a segment listed in `config.roles` with `scopes` and an optional
  `requiredAuth` (`minLevel`, `twoFactor`).
- The role's scopes only narrow the key in use. A role can never give a
  request more than its API key allows.
- Whoever manages a role's members is set on the segment (`manager_role_id`).
  A manager can only put people in a role whose scopes the manager already
  holds, so a curator can never hand out `admin`.
- Names are yours to choose. Core does not ship or recommend them.

### Admin

- Member of the `admin` segment of this account.
- Holds the `admin` scope in this account's core API, which bypasses the
  segment membership rules for that account.
- Must have signed in at **Identity Level 3 or higher**
  (`requiredAuth.minLevel: 3` on the standard role).
- Reaches only this account. On the engine9 server, may do everything in
  this one account (data, tasks, plugins, API keys) and may add or remove
  other admins of it.
- Is **not** a superadmin and cannot become one by any action in a database.

### Superadmin

- A verified email, at Identity Level 3 or higher, that is on the
  superadmins list.
- On a core site, acts as that site's `admin` role. The role is added to the
  session on every verification and is never written to `person_segment` or
  into a token, so removing the email from the list ends it on the next
  request (on Cloudflare, at the next deploy).
- On the engine9 server, opens every account in the catalog and may do
  everything in each.
- Cannot be created, listed, or removed from any account database, any API,
  or any MCP tool. Only the file (or variable) changes the list.

## How a request is decided

```
Request
  → 1. API key        required on every route except GET /ok
  → 2. Role           effective scopes = key scopes ∩ role scopes
  → 3. Identity Level role's requiredAuth checked against the session
  → handler
```

- **The key is the ceiling.** A role only narrows it. A session with a key
  that lacks `admin` gets that key's scopes, even for an admin or a
  superadmin. This is why the admin key must stay on the server.
- **A request names a role only if it holds it.** A `role_id` that is not
  configured or not held is a 403 (`unknown_role`, `role_not_held`), never a
  silent fallback to the key.
- **Roles on a session are a copy.** The Core Session carries the roles the
  person held when it was minted. Use it to decide what to *show*. For a
  privileged decision on a session, call `auth.rolesForSession(session)`,
  which reads `person_segment` and adds superadmin. `auth.rolesForPerson` reads
  the database only and does not see superadmins.
- **Errors say why.** Membership denials return the subject (`self` or
  `other`), the operation, and the reason.

Full detail: [auth/README.md](auth/README.md).

## Requirements

Each requirement has an id for reports and automated checks. **MUST** is
required for every production site. **SHOULD** is expected unless there is a
recorded reason.

### Levels and roles

- **PL-1 (MUST)** The only built-in role is `admin`. Production sites set
  `roles: 'standard'` or an explicit `config.roles` whose entries each have
  non-empty `scopes`. No role named `operator` is installed or relied on.
  Any site-specific role must grant narrower scopes than `admin` and set a
  `requiredAuth.minLevel` appropriate to what it can do.
- **PL-2 (MUST)** The `admin` role requires Identity Level 3
  (`requiredAuth: { minLevel: 3 }`). Do not lower it, and do not offer an
  email-link sign-in to people who must reach Level 3.
- **PL-3 (MUST)** Admin membership exists only as `person_segment` rows for
  the account's `admin` segment. No list of admins is kept in code,
  environment variables, or configuration.
- **PL-6 (MUST)** The `admin` segment has `join_min_level`,
  `leave_min_level` and `manager_role_id` all `null`, so only a request that
  already has the `admin` scope can add or remove admins. Do not make `admin`
  self-joinable or manageable by a lesser role.

### Superadmins

- **PL-4 (MUST)** Superadmins are kept only in the superadmins file, or the
  `E9_SUPERADMINS` variable. Never in a database table, a token, or
  `person_segment`. Each entry is a named individual's verified email, at an
  address the organization controls. No shared or role mailboxes. Keep the
  list as short as the work allows.
- **PL-10 (MUST)** The superadmins file is not served to the public and not
  readable by outsiders. `e9core serve` refuses to serve it as a static
  file; confirm the same for any other host. Treat history of the file as
  sensitive if the list is.

### Keys and sessions

- **PL-5 (MUST)** API keys: every key has a non-empty scope list (no `*`);
  `admin` keys exist only on servers and never in a browser, repository, or
  client bundle; browsers hold only the public key (`public` scope only);
  other keys carry only the scopes the caller needs, and `expires_at` where
  the caller is not permanent. Rotate a key when a person who knew it
  leaves. Do not forward a visitor's session together with an admin key and
  rely on the role to restrict it; give the key a `default_role_id` with only
  the scopes visitors need.
- **PL-7 (MUST)** `SESSION_SECRET` is 32 random bytes, different for every
  host and every environment, kept out of git, and set in production. Core
  has no built-in default and will not create login without it. Production also
  SHOULD configure `sessionRevocations` so logout actually ends a session,
  and set `acceptLegacySessions: false` once a day has passed after upgrading
  to a version that adds session `typ`. Deliver the Core Session as an
  `HttpOnly`, `Secure` cookie (`GET /auth/callback` does this: `HttpOnly`,
  `SameSite=Lax`, and `Secure` on https).
- **PL-8 (MUST)** Host code that decides a privileged action from a session
  (opening an admin page, performing an admin action) uses
  `auth.rolesForSession(session)` and the role's `requiredAuth`
  (`meetsRequiredAuth`). It does not trust the `roles` copy in a token for
  that decision.

### Operation

- **PL-9 (MUST)** Removing access removes the record: delete the
  `person_segment` row (admin) or the list entry (superadmin). Removal is
  complete on the person's next request for privileged checks. To end an
  existing session, use logout with `sessionRevocations`, or rotate
  `SESSION_SECRET` to end every session.
- **PL-11 (MUST)** Upgrades follow install, deploy, then `e9core upgrade`
  for every release and every database ([docs/upgrading.md](docs/upgrading.md)).
  A deploy alone never changes the database.
- **PL-12 (SHOULD)** Review the admin list, the superadmins list, and the
  active API keys at least quarterly and after any staff change, and keep the
  result. [Verifying a site](#verifying-a-site) gives the commands.

## Implementing on a new site

1. **Install** `@engine9/core` and `@engine9/schemas` as siblings
   (`npm install @engine9/core @engine9/schemas`) and run setup
   (`npx e9core serve`, then the wizard). Setup creates the database, an
   admin key, a public key, and `SESSION_SECRET` ([docs/deploy.md](docs/deploy.md)).
2. **Turn on the standard role.** In `createApi`:

   ```js
   createApi({
     worker,
     keyStore,
     delegate: { sessionSecret: process.env.SESSION_SECRET },
     config: {
       pluginId: process.env.E9_PLUGIN_ID,
       roles: 'standard',
       superadmins: createSuperadminsReader() // optional
     }
   });
   ```

3. **Name the first admin.** One of the account's own people (a tool that
   provisions many accounts follows
   [docs/admin-provisioning.md](docs/admin-provisioning.md)):

   ```bash
   npx e9core segment add --segment admin --email owner@example.com
   ```

   This creates the segment if it is missing and the person if they do not
   exist yet. A later sign-in with that verified email lands on that person.
   On a deployed site (Cloudflare D1 included), add
   `--url https://www.example.com`: the site does the same through its API
   with the production admin key.
4. **Superadmins, only if engine9 staff or a platform team must reach this
   site:**

   ```bash
   npx e9core superadmin add --email chris@example.com
   ```

   `e9core serve` and a Node host read `engine9.superadmins.json` (or
   `E9_SUPERADMINS_FILE`) on each request. On Cloudflare set
   `E9_SUPERADMINS` (comma-separated) in the Worker's vars; it takes effect
   at the next deploy.
5. **Keys.** Keep the admin key on servers. Give the browser the public
   key. Create other keys with exact scopes and, where useful, an expiry
   (`npx e9core create-api-key --scopes …`).
6. **Sessions.** Set `sessionRevocations` (a KV store on Cloudflare) so
   logout revokes.
7. **Host decisions.** Use `auth.rolesForSession(session)` for admin pages
   and admin actions.
8. **Verify** with [Verifying a site](#verifying-a-site).

## Converting an existing site

Find the row that describes the site. Several can apply.

| Site today | What to do |
| --- | --- |
| On `@engine9/core` before 1.12.0 with `roles: 'standard'` (admin and operator) | [Upgrade to 1.12.0](#upgrading-to-1120) and migrate operators. |
| Admins are an email list in host code, an environment variable, or a config file | Put each person in the `admin` segment with `segment add`, delete the list, and switch the check to `auth.rolesForSession(session)`. |
| An admin or site key is used in a browser, or a visitor's session is forwarded with the admin key | Move the key server-side. Issue a public key for the browser and, for server code that forwards sessions, a key with a narrow `default_role_id`. Rotate the exposed key. |
| Custom roles with their own names | They stay valid. Check each against PL-1 (narrower than `admin`, `minLevel` set) and PL-6 on the policy columns. |
| No login at all (keys only) | Nothing is required. Admin work happens server-side with the admin key (PL-5). Add login and the `admin` role when people need to sign in to administer. |
| Admins are held in another system (a database, a vendor product, an earlier access cache) | Neither core nor the engine9 server migrates another system's list. The system that owns the list writes it into each account's `admin` segment with the calls in [docs/admin-provisioning.md](docs/admin-provisioning.md), once, then retires the old list. |
| An account on the engine9 server | [The engine9 server](#the-engine9-server). |

### Upgrading to 1.12.0

For one site, or for each site you operate. This is the same install, deploy,
upgrade sequence as every release, plus a membership step.

1. **Record the current state** before changing anything:

   ```bash
   npx e9core segment list --db <connection>
   npx e9core segment members --segment admin --db <connection>
   npx e9core segment members --segment operator --db <connection>
   ```

   Save the output. `operator` appears here only if the site had it.
2. **Back up** the database (Cloudflare D1: note a time-travel bookmark;
   MySQL: a dump). See [docs/upgrading.md](docs/upgrading.md).
3. **Install and build:**

   ```bash
   npm install @engine9/core@^1.12.0
   ```

   Run the project's build, which runs `e9core build-plugins`.
4. **Deploy:** `npx wrangler deploy`, or restart the Node service.
5. **Upgrade the database** (required even though 1.12.0 adds nothing to
   apply). Dry run first:

   ```bash
   npx e9core upgrade --url https://www.example.com --dry-run
   npx e9core upgrade --url https://www.example.com
   ```

   Local database: `npx e9core upgrade --db sqlite://./engine9.db`.
6. **Decide each former operator.**
   - Engine9 or platform staff who work across accounts: add to the
     superadmins file (step 7).
   - Someone who should keep working in this one account: make them an
     admin, which grants write access.

     ```bash
     npx e9core segment add --segment admin --email sam@example.com
     ```

   - Anyone else: do nothing. Old `operator` memberships remain in the
     database but grant nothing. A session that still carries the old role id
     is treated as having no role, with only the key's scopes, the same as a
     visitor. New logins never carry it.

   Leaving unused `operator` rows is harmless, but remove them when you
   review the site so an audit does not find a dormant role.
7. **Superadmins** (only if needed):

   ```bash
   npx e9core superadmin add --email chris@example.com
   ```

   Cloudflare: set `E9_SUPERADMINS` in the Worker's vars and deploy.
8. **Tighten what the review found** (PL-2 to PL-10): remove ad-hoc admin
   lists, move keys, add `sessionRevocations`, set `acceptLegacySessions:
   false`.
9. **Verify** with [Verifying a site](#verifying-a-site) and keep the output
   with the change record.

Rollback: redeploy the previous version. There is no schema change, so no
database rollback is needed. Admin and superadmin entries you added are
harmless to the previous version, except that it would again ignore the
superadmins file.

## Verifying a site

Run these and keep the output. They are the evidence a reviewer asks for.
Every `segment list` and `segment members` check also works against a
deployed site with `--url https://www.example.com` (it reads
`GET /api/admin/segments` with the admin key). On Cloudflare that is the
only way to read the production D1 database, so use it there.

| Requirement | How to check |
| --- | --- |
| PL-1 | `npx e9core segment list` shows only the roles you meant. No `operator`. `config.roles` in the host code lists only intended roles with non-empty `scopes`. |
| PL-2 | Read the role registry (`config.roles` or `roles: 'standard'`): the `admin` entry has `requiredAuth.minLevel` of 3 or more. A sign-in at Level 2 must not reach an admin route. |
| PL-3 | `npx e9core segment members --segment admin` is the full list of admins. Search the code and environment for any other list of admin emails or ids; there should be none. |
| PL-4 | `npx e9core superadmin list` (or the `E9_SUPERADMINS` value) is the full list. Each entry is a named person's verified address. |
| PL-5 | Query the key table and review it: `select id, name, scopes, default_role_id, active, expires_at from api_key;`. Expect few `admin` keys, none unexpected, expiry set where appropriate, nothing with `*` or empty scopes. Search built assets and the repository for `e9key_`; there should be no match (only `e9publickey_` may appear in a browser bundle). |
| PL-6 | `npx e9core segment list` shows the `admin` segment with `join_min_level`, `leave_min_level`, `manager_role_id` all empty or `null`. |
| PL-7 | `SESSION_SECRET` is set in production and differs from other environments. Logout with a session and then reuse its token: it must be refused. |
| PL-8 | Code review: privileged paths call `auth.rolesForSession` and `meetsRequiredAuth`, not the `roles` array from a token. |
| PL-9 | Remove a test admin, then call a privileged route with a fresh token: it must be refused. |
| PL-10 | `curl -I https://<site>/engine9.superadmins.json` returns 404, and the file is not in a public repository. |
| PL-11 | `npx e9core status --url <site>` reports no failure, and every `upgrade.<id>` check passes (or is a skipped opt-in). |
| PL-12 | The review output from the rows above, dated, kept with change records. The audit log's `role.grant` and `role.revoke` records show every change to a role between reviews. |

A superadmin check: sign in as a listed address at Level 3 and request
`GET /auth/me`; the session's `roles` includes the account's `admin` role id.
Then remove the address from the list; the next request must not.

## Operating it: granting, removing, incidents

**Add an admin:** `npx e9core segment add --segment admin --email …` (add
`--url <site>` for a deployed site), or `POST /auth/segments` with an
`admin`-scope key.

**Remove an admin:** `npx e9core segment remove --segment admin --email …`
(or with `--url <site>`).
Privileged checks refuse it on the next request. A token already issued keeps
showing the old role in menus until it expires or the person logs in again.
End the session itself with logout (`sessionRevocations`) if that matters.

**Add or remove a superadmin:** `npx e9core superadmin add|remove`, or edit the
file or `E9_SUPERADMINS` and deploy where required. Takes effect on the next
request, except on Cloudflare where it takes effect at the next deploy.

**A person leaves:** remove them from the admin segment and the superadmins
list, revoke or rotate any key they knew, and end their sessions.

**A key is exposed:** rotate it (`store.rotate()` creates a new key and
revokes the old one) and replace it wherever it was used.

**Suspected session compromise:** rotate `SESSION_SECRET` (this ends every
session on that host), then redeploy.

**A superadmin address is compromised or reassigned:** remove it from the list
first, then review what that address could reach (every account the process
serves).

## The engine9 server

The server applies the same two tiers across the accounts in its catalog.

- **Superadmin:** `ENGINE9_SUPERADMINS_URI` (a local path or `s3://`) holds
  `{ "superadmins": [...] }`. Manage it with
  `node scripts/superadmins.mjs show|add|remove`. A listed, verified,
  Level 3 email opens every account.
- **Admin:** the server reads each account's database for membership in that
  account's `admin` segment and remembers the answer briefly. An admin opens
  that account only. Manage with MCP `account` `listAdmins`, `addAdmin`,
  `removeAdmin`, or with core as above. A person cannot remove themselves
  unless they are a superadmin. `addAdmin` needs the person to exist in the
  account already.
- **Putting admins into an account** (first admin, or a one-time move from
  another system's list): [docs/admin-provisioning.md](docs/admin-provisioning.md).
  The server holds no migration code and no copy of any list. Superadmins are
  added to the file by a person, never derived from another system's data.

The server's own documentation is `api/mcp/accounts.md` and `scripts/README.md`
in that repository.

## Do not

- Do not create an `operator` role, or any role whose purpose is "admin, but
  read only". If someone needs less than admin, define a site role with exactly
  those scopes and a `requiredAuth.minLevel`.
- Do not store superadmins in a database, a token, or `person_segment`, and do
  not add an API that edits the list.
- Do not put an `admin` key, or any `e9key_`, in a browser or a repository.
- Do not keep a second list of admins in code or configuration.
- Do not use the `roles` in a token for a privileged decision.
- Do not make `admin` self-joinable, or give a lesser role authority to manage
  it.
- Do not lower the `admin` role below Identity Level 3.
- Do not share a superadmin address between people, or use a role mailbox.
- Do not run `wrangler d1 migrations apply` for engine9 tables; use
  `e9core upgrade` ([docs/upgrading.md](docs/upgrading.md)).
