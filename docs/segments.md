# Segments and roles

Three nouns cover permissions in engine9.

| Noun | Table | Meaning |
| --- | --- | --- |
| **person** | `person` | Every human. Signups, staff, admins — all people. There is no `user` table. |
| **segment** | `segment`, `person_segment` | A named set of people. |
| **role** | a `segment` listed in `config.roles` | A segment whose members get **scopes** (what they may do) and a **requiredAuth** (how strong a login they need). |

Being in a role segment is the only way a person has permission. Grant a
role by adding the person to the segment. Revoke it by removing them.

Identity Level (0–7, from Delegate) is how sure we are who someone is. It
is not permission. A Level 4 person in no role has no scopes.

## Two verbs, two subjects

Membership changes are `add` and `remove`. Each one is about either
**yourself** or **someone else**, and the segment decides both with three
columns:

| Column on `segment` | Governs | `null` means |
| --- | --- | --- |
| `join_min_level` | **add yourself**: lowest Identity Level allowed. `0` = a public form, no login. | not allowed |
| `leave_min_level` | **remove yourself**: lowest Identity Level allowed. Never `0`. | not allowed |
| `manager_role_id` | **add or remove someone else**: the role whose members may. | no one |

When a column is `null`, only a request with `admin` scope may do that
thing. A new segment has all three `null`.

Two more rules:

- Adding yourself to a **role** also has to satisfy the role's
  `requiredAuth.minLevel`. You cannot take a role you could not use.
- A manager may only put people in a role whose scopes the manager already
  holds. A site curator role can manage a self-join list but can never hand
  out `admin`, whatever the columns say.

Every denial says which subject failed and why:

```json
{ "error": "cannot remove yourself from 'RSVP': requires Identity Level 2, you are at 1",
  "segment_id": "…", "operation": "remove", "subject": "self" }

{ "error": "cannot add other people to 'admin': it has no manager role, so only admin scope may",
  "segment_id": "…", "operation": "add", "subject": "other" }
```

## What "admin" means, and where requests come from

`admin` is a **scope**. A request has it when its effective scopes include
`admin`. Effective scopes are the API key's scopes ∩ the active role's scopes;
the key is the ceiling.

That makes the source of the request matter:

| Request comes from | Key it holds | What it can do to membership |
| --- | --- | --- |
| A browser page | the **public** key (`e9publickey_`, scope `public`) | Add or remove **yourself**, and `POST /people` into segments with `join_min_level: 0`. Nothing for other people. |
| Your site's backend, forwarding the visitor's session | the **site** key (`data:read`, `people:write`, …) | Add or remove **other people** when the visitor's role is the segment's `manager_role_id`. |
| Your site's backend or a job, with the admin key | the **admin** key (scope `admin`) | Everything. |
| `npx e9core segment`, scripts, tests | direct database access | Everything. No policy check runs. |

A manager clicking a button on your site therefore does not call
`/auth/segments` from the browser. The page calls your backend; your backend
calls core with the site key and that person's session token. Core sees a
manager with `people:write` and allows the `add`.

## Standard roles

`roles: 'standard'` in `createApi` or `createDelegateAuth` installs these
two. Segment ids are `roleSegmentId(accountId, name)`, so every database for
the same account has the same ids.

| Role | Scopes | Login needed to use it | Add yourself | Remove yourself | Manager |
| --- | --- | --- | --- | --- | --- |
| `admin` | `admin` | Level 3 | no | no | none |
| `operator` | `data:read`, `tasks:read`, `tasks:schedule` | Level 3 | no | no | none |

Both are account-scoped; nothing in engine9 has a wider role. The role
`admin` and the scope `admin` share a name on purpose: the role's only scope
is that one, so "is an admin" and "has `admin`" mean the same thing.

- **No role** — a signup. Can be added to `join_min_level: 0` segments by a form. That is all.
- **`admin`** — **changes** the account. `admin` scope in this account's core API.
- **`operator`** — **uses** the account through engine9's tools (MCP, Conductor, Task API). Read data, schedule and watch curated flows.

Any other role name is **site-specific**. Choose it per deployment (or install
it through a non-core mechanism), insert a `segment` row, and list it in
`config.roles`. Core does not ship or recommend those names. No new concept
is needed — only the three policy columns and a registry entry.

### `admin` versus `operator`

The admin changes the account; the operator works in it.

| | `admin` | `operator` |
| --- | --- | --- |
| One line | May change anything about this account: people, segments, who holds which role, keys. | May use this account's data and tasks through engine9's tools. May not change who has permission. |
| Core scopes | `admin` | `data:read`, `tasks:read`, `tasks:schedule` |
| In core, can add/remove people in any segment? | Yes. Bypasses the three columns. | No. Same rules as anyone: self at `join_min_level`, others only as a `manager_role_id`. |
| In core, can write people (`POST /people`, `/upsert`)? | Yes. | No. |
| Opens the account on the engine9 server (MCP, Conductor, Task API)? | Yes. | Yes. This is the role that exists for that. |
| On the server, what can they change? | Everything (SQL writes, keys, plugins, on-demand tasks). | Read data (SELECT/WITH); run and watch curated flows; not keys, plugins, or arbitrary worker methods. |
| Typical person | The organization's technical owner. The one person you would call if the account were breached. | Staff and analysts who run reports, schedule loads, and inspect data. |

So the difference is real in core and on the server. If a person will only
ever open MCP for reports and flows, `operator` is enough. Give `admin` to
people who should also write SQL, manage keys and plugins, or schedule
arbitrary worker methods.

An `admin` is not automatically an `operator`. Put a person in both when
they should have both. The server's cache lists both roles for an account,
so either one opens it there.

### The server, the access cache, and the system account

Two more things sound like roles and are not.

| | Question it answers | Where it lives |
| --- | --- | --- |
| the server's **account access cache** | Which accounts may **this operator** open on the server? (An index across accounts.) | one JSON document on the server host, `ENGINE9_ACCOUNT_ACCESS_CACHE_URI` (server repo `scripts/README.md`) |
| the **system account** | Engine9's own account: holds the account catalog. | its own account database, like any account |

There is no separate "engine9 staff" role. Engine9 staff are the system
account's `admin` and `operator`, exactly as an
organization's staff are theirs.

The cache is compiled from segment membership and is not canonical: system
account staff become its cross-account `admins` list (system-account
`admin` **and** `operator` — both are admin on every other account; that is
intentional for engine9 staff), each account's `admin` and `operator` become
that account's role lists. Edit membership in the account database; rebuild
or patch the cache to reflect it.

## The decision

`canEditSegmentMembership` in `@engine9/core/auth/segmentAccess` is the only
place the rule lives. Every route calls it, then writes. In order:

1. Request has `admin` scope → allowed.
2. Caller is in the segment's `manager_role_id` and holds the segment's role scopes → allowed, for anyone (including themselves).
3. Subject is someone else → denied (`subject: "other"`).
4. `add` yourself: `join_min_level` is set, your level ≥ it, and the role's `requiredAuth` passes. Not signed in counts only when `join_min_level` is `0`, and only for the people in the same request (a form), never for an arbitrary `person_id`.
5. `remove` yourself: signed in, `leave_min_level` is set, your level ≥ it.
6. Otherwise denied (`subject: "self"`).

A denied request writes nothing. The whole body is checked before the first
write.

## Where the policy is read and written

The policy is the three columns on the `segment` row. Nothing else stores it.

| Reads it | When |
| --- | --- |
| `POST /auth/segments` | every entry |
| `POST /auth/role` | the role being taken; when `exclusive`, every role being dropped |
| `POST /people` | each `segment_ids` value on a record (`join_min_level` must be `0`) |
| `POST /upsert/person_segment` | each `segment_id` in the batch (`join_min_level` must be set) unless `admin` |

| Writes it | When |
| --- | --- |
| `ensureRoleSegments` / `auth.ensureSegments()` / `npx e9core segment add --segment <role>` | only when it creates the row, from `STANDARD_ROLES` |
| `setMembershipPolicy({ worker, segmentId, joinMinLevel, leaveMinLevel, managerRoleId })` | whenever you call it |
| `npx e9core segment policy --segment <id> --join … --leave … --manager …` | same, from the shell |
| inserting a `segment` row yourself | you set the columns |

Not read by: `npx e9core segment add|remove`, `addPeopleToSegment`,
`removePeopleFromSegment`, SQL, the engine9 server. Those are the admin.

## Endpoints

All need an API key. Acting on yourself needs your Core Session
(`X-Engine9-Session`) or Identity Token (`Authorization: Bearer <jwt>` with
`X-API-Key`).

### `POST /auth/segments` — add and remove

```json
{
  "add":    ["<segment id>",
             { "segment_id": "<id>", "email": "sam@example.com" }],
  "remove": [{ "segment_id": "<id>" },
             { "segment_id": "<id>", "person_id": 12 }]
}
```

Either key may be omitted. An entry is:

- a bare segment id, or an object with only `segment_id` → **yourself** (the session person);
- an object with `person_id` or `email` → **someone else**.

`email` on an `add` creates the person when new. Entries with `email` need
`people:write` (or `admin`) and `config.pluginId`. The whole body is checked
first; `403 { error, segment_id, operation, subject }` means nothing was
written. `200` echoes both lists with `person_id` and `subject` filled in.

### `POST /auth/role` — take a role and refresh the session

`{ role_id, exclusive?, person_id? }`. `role_id` is a segment id or a name
from `config.roles`. This is `add` yourself to `role_id` plus, when
`exclusive` is true (the default), `remove` yourself from every other role
you hold — checked with the same rules as `/auth/segments` — and it returns
a **re-signed session token** with the new `roles`. Use it when the person
picks a role and the browser needs the updated session at once
(`@engine9/id` `core.changeRole`). With `admin` scope, `person_id` may name
someone else.

### `POST /people` — signup and import

`segment_ids` on a record (or `options.segmentIds`) is accepted only for
segments with `join_min_level: 0`, unless the key has `admin`. The people in
the batch are treated as adding themselves without a login. A public form
can subscribe someone to a newsletter. It cannot attach a role.

### `POST /upsert/person_segment` — backend bulk add

Needs `tables:write`. Without `admin`, every `segment_id` in the batch must
have `join_min_level` set (any value). Segments with no `join_min_level` —
including both standard roles — reject the write. This route cannot remove
people.

## Code and command line

These run with database access and skip the policy; the caller is the admin.

| Call | Module |
| --- | --- |
| `roleSegmentId(accountId, name)` | `@engine9/core/auth/roles` |
| `ensureRoleSegments({ worker })` | same — create standard role segments |
| `setMembershipPolicy({ worker, segmentId, joinMinLevel, leaveMinLevel, managerRoleId })` | same — set the three columns on any segment |
| `addPeopleToSegment` / `removePeopleFromSegment({ worker, segmentId, emails, personIds })` | same — any segment, role or not |
| `listSegmentMembers({ worker, segmentId })` | same |
| `canEditSegmentMembership({ policy, operation, caller, targetPersonId })` | `@engine9/core/auth/segmentAccess` |
| `auth.ensureSegments()`, `auth.addPeople({ role, emails })`, `auth.removePeople(...)`, `auth.members({ role })` | object from `createDelegateAuth` |

```bash
npx e9core segment list    --account acme
npx e9core segment add     --segment admin --email sam@example.com
npx e9core segment remove  --segment operator --email sam@example.com
npx e9core segment members --segment admin
npx e9core segment policy  --segment <id> --join 0 --leave 2 --manager <curator segment id>
```

`--segment` is a standard role name (`admin`, `operator`) or any segment id.
`--account` (or `E9_ACCOUNT_ID`) picks the account the role ids derive from.
`--db` (or `ENGINE9_DATABASE_CONNECTION`) picks the database. `policy` with
no flags prints the current policy; `none` clears a value.

## Example site roles

The names below are **examples only** — not canonical, not recommended, and
not installed by `roles: 'standard'`. Pick names that fit the deployment.
Create the segment, put it in `config.roles`, and set the three columns.

```js
// Example only — names and scopes are yours to choose.
const curatorId = roleSegmentId(accountId, 'curator');
const clubId = roleSegmentId(accountId, 'club');
await ensureRoleSegments({
  worker,
  roles: [
    { name: 'curator', description: 'Manages club lists', scopes: ['data:read', 'people:write'],
      requiredAuth: { minLevel: 2 }, leaveMinLevel: 1 },
    { name: 'club', description: 'Signed-up club', scopes: ['data:read'],
      requiredAuth: { minLevel: 1 }, joinMinLevel: 1, leaveMinLevel: 1, managerRole: 'curator' }
  ]
});
// Then pass { [curatorId]: {…}, [clubId]: {…}, …admin/operator… } in config.roles.
```

Older docs and some sites used the names `moderator` / `member` for that
same pattern (curator + self-join list). Those strings have no special meaning
in core.

## Common cases

| Case | Segment settings | How it happens |
| --- | --- | --- |
| Public newsletter | join `0`, leave `2`, manager = your curator role | Form: `POST /people` with `segment_ids`. Unsubscribe: `remove` yourself after a Level 2 login. Curator: `remove` by email. |
| Event RSVP | join `1`, leave `2`, manager = your curator role | Signed-in Level 1: `add` yourself. Level 1 cannot `remove` themselves; Level 2 can. Ticketing backend with `tables:write`: `POST /upsert/person_segment`. |
| Member / club area | a site role with join `1`, leave `1`, manager = curator | After login: `POST /auth/role` with that role id, or `add` yourself. Curator adds a holdout by email. |
| Make a curator | site role (join `no`, leave `1`) | Admin key: `POST /auth/role` with `person_id`, or `ensureRoleSegments` + `addPeopleToSegment`. They cannot self-appoint; they can step down. |
| Grant account admin or operator | closed | `npx e9core segment add --segment admin --email …`, or `POST /auth/segments` with the admin key. Site curator roles get `403 subject: other`. Public forms get `403 subject: self`. |
| Level 1 may add themselves, only Level 2 may remove themselves | join `1`, leave `2` | No new role. Same as RSVP. |
| Two teams manage one list | one `manager_role_id` | Put both teams in that one role. A segment has one manager role, like a Unix file has one group. |
| A custom editor role | new `segment` (`category: 'role'`, `build_type: 'manual'`) + `config.roles` entry | Set `manager_role_id` on the segments editors curate. Do not give it `admin` unless it should bypass everything. |
| Curated list, no self-service | join `null`, leave `2`, manager = curator | Only the manager role adds. People may remove themselves. |

## The server surface

The private engine9 server (MCP, Conductor, Task API) is another door into
the same account databases. MCP and Conductor read the operator's cache
level (`admin` or `operator`) and enforce it: operators may run SELECT/WITH
SQL and schedule published flows; changing the account (non-SELECT SQL,
API keys, plugin install/settings, on-demand `path`+`method` tasks, and
similar) needs the admin role. The Task API authenticates with `e9key_`
keys and their scopes instead — keys are created by admins, so that path
is an admin decision; the MCP `task` tool is stricter for operators than
the HTTP Task API.

Membership changes still go through core: this account's
`POST /auth/segments`, `addPeopleToSegment` /
`removePeopleFromSegment`, or `npx e9core segment`. The server's account
access cache answers a different question — which accounts an operator may
open and at which level — and is compiled from segment membership, not
maintained as a second copy of the rules.

## Upgrading an existing database

The three columns are on `@engine9/interfaces/segment`. Reinstall the
interfaces (`npx e9core installStandard`, or your usual schema apply) before
`ensureRoleSegments` or `POST /auth/segments` runs. Until then every
membership edit that reads the policy is denied. Role segments created before
the columns keep `null` in all three; set them with
`npx e9core segment policy` or `setMembershipPolicy`.
