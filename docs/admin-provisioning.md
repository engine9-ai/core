# Defining admins from outside core

For anyone writing code that puts admins into engine9 databases: a product
that already holds an access list, a provisioning tool, an onboarding job.
It says exactly what an admin is, what to write, and what to check. The
permission model itself is [PERMISSIONS.md](../PERMISSIONS.md); this page is
only the how.

**Scope.** Core defines admins and gives you the calls below. How a particular
source (a Mongo collection, a spreadsheet, a previous product's cache) maps to
"this email is an admin of this account" belongs to the system that owns that
source. Neither core nor the engine9 server contains migration code for any
other system's list. Put that code in the owning system and have it call core.

## What an admin is

An admin of an account is a person in that account's own database whose
`person_segment` row puts them in the account's `admin` role segment. That is
the whole definition.

- The segment id is computed, never looked up:
  `roleSegmentId(accountId, 'admin')` from `@engine9/core/auth/roles`.
  `accountId` is the id the account has everywhere else (on the engine9
  server, its id in the account catalog). A different `accountId` computes a
  different segment, and the person would be an admin of nothing.
- The person is found by email (`person_email`). When the address is new,
  core creates the person through the normal inbound pipeline, so the person
  exists before they ever sign in. A later sign-in with that verified email
  lands on the same person.
- Admin access needs a verified email at Identity Level 3 at sign-in
  (`requiredAuth.minLevel`). Putting someone in the segment does not make
  them sign in at that level; it only says they may.
- A superadmin is not an admin. Superadmins are a file of verified emails and
  never go in a database, a token, or `person_segment`. See
  [Superadmins](#superadmins).

There is no other admin list anywhere (PL-3). After you provision, the
account database is the only record.

## What you decide before writing

| Decision | Rule |
| --- | --- |
| Which account | The core/engine9 `accountId` of the database you are writing to. Write to that account's own database only. |
| Which emails | Verified addresses of named people. No role mailboxes, no shared addresses, no placeholders. Lowercase and trim; core normalizes, but reject what is not an address instead of guessing. |
| Admin or superadmin | Admin if the person works in this one account. Superadmin only for platform staff who must reach every account, and only by a deliberate entry in the superadmins file, never derived automatically from a source list. |
| What about lesser access | There is no read-only admin and no operator. Someone who needs less than admin gets no admin membership. A narrower site role is a separate role the site defines. |
| Remove or keep stale entries | Provisioning adds. Deleting people who are admins today but absent from your source is a separate, explicit step. |

## Recipe

Node, one account at a time. `PersonWorker` is the core worker over the
account database (`new PersonWorker({ accountId, auth: { database_connection } })`).

```js
import {
  ROLE_NAMES,
  addPeopleToSegment,
  ensureRoleSegment,
  roleSegmentId,
  rolesPluginId
} from '@engine9/core/auth/roles';

async function provisionAdmins({ worker, accountId, emails }) {
  // Creates the account's `roles` plugin row and the admin segment row when missing.
  await ensureRoleSegment({
    worker,
    accountId,
    name: ROLE_NAMES.ADMIN,
    description: 'Administrative access to this account'
  });
  // Creates people for addresses core does not know, then adds the membership.
  return addPeopleToSegment({
    worker,
    pluginId: rolesPluginId(accountId), // new people are recorded under the roles plugin
    segmentId: roleSegmentId(accountId, ROLE_NAMES.ADMIN),
    emails
  });
}
```

`addPeopleToSegment` returns `{ segmentId, personIds, byEmail, added }`.
`added` is only the people who were not members before.

Notes:

- `pluginId` is the plugin that new people are recorded under. A site that
  has its own plugin passes that one. An account with no site plugin, such as
  an account that was not created by `e9core setup`, uses
  `rolesPluginId(accountId)`, which `ensureRoleSegment` has just created.
  A plugin id with no `plugin` row fails with `No such plugin`.
- The database must have the standard schema (`person`, `person_email`,
  `segment`, `person_segment`, `plugin`, `input`). Install `@engine9/schemas`
  first if the account has never had it ([docs/deploy.md](deploy.md)).
- People are created through the plugin pipeline, so outside `e9core` call
  `ensureNodePluginRegistry({ cwd })` from `@engine9/core/plugins/node` once
  before using the worker, as the CLI does ([AGENTS.md](../AGENTS.md#plugins)).
- `addPeopleToSegment` throws on the first string that is not an address.
  Filter first with `normalizeEmail` from the same module, report what you
  drop, and pass only what survives.
- Do not insert into `person_segment` or `segment` yourself, and do not
  compute `person_id`. The calls above own those rules.
- Batch by account. A failure on one account must not stop the others, and
  must be in the report.

The same thing without code, per account:

```bash
npx e9core segment add --segment admin --account <account_id> \
  --db <connection> --email a@example.org,b@example.org
```

The engine9 server's MCP `account` `addAdmin` also works once someone can
already open the account, but it refuses addresses that are not yet people.
Use core for the first admin.

## Properties your implementation must have

1. **Idempotent.** Running it twice gives the same state. Test it by running
   it twice and comparing `added` (empty the second time) and `personIds`.
2. **Dry run by default.** A report of what would be added, already present,
   or rejected, with a switch to write. Nothing is written without it.
3. **Per-account result.** For every account: emails added, already admins,
   rejected (and why), and any error. Exit non-zero if any account errored.
4. **One-way and finite.** It is a migration, not a sync. Do not run it on a
   schedule to mirror another system's list; the moment you do, there are two
   admin lists (PL-3) and a removal in one does not happen in the other.
   Moving a person out of the source must be followed by an explicit removal
   (`removePeopleFromSegment`).
5. **No secrets in the report.** Emails and account ids only.
6. **Never widens.** It writes `admin` membership and nothing else. It does
   not create keys, change policy columns on the segment, or touch roles other
   than `admin`.

## Superadmins

A superadmin is a verified email on a file. Core's file is
`engine9.superadmins.json`, managed with
`npx e9core superadmin add|remove|list` (see
[PERMISSIONS.md](../PERMISSIONS.md#operating-it-granting-removing-incidents)).
The engine9 server reads `ENGINE9_SUPERADMINS_URI`, a local path or `s3://`
URI holding `{ "superadmins": ["a@example.org"] }`, managed with
`scripts/superadmins.mjs show|add|remove` in that repository.

If your source has a "platform admin" flag, list the people it selects and
have a person on the platform team add them to the file on purpose. The file
grants access to every account, so it is never written by a job that
translates someone else's data.

## Checking the result

Per account, after a write:

```bash
npx e9core segment members --segment admin --account <account_id> --db <connection>
```

It must list exactly the addresses you intended and no others. Then, in code:

```js
import { rolesForEmail, roleSegmentId } from '@engine9/core/auth/roles';
const roleId = roleSegmentId(accountId, 'admin');
await rolesForEmail({ worker, email: 'a@example.org', roleIds: [roleId] }); // [roleId]
```

On the engine9 server the new admin opens the account within
`ENGINE9_ADMIN_LOOKUP_TTL_MS` (default 60 seconds); it reads the account
database and keeps no copy. Sign in as the person at Level 3 and confirm the
account is listed. Confirm that someone who was not provisioned does not see
it.

## Rolling back

Remove what you added, using the `added` lists from the report:

```js
import { removePeopleFromSegment } from '@engine9/core/auth/roles';
await removePeopleFromSegment({ worker, segmentId: roleSegmentId(accountId, 'admin'), emails });
```

People created along the way stay as ordinary people and have no access. Keep
the report with the change record (PL-12).

## Acceptance checklist

An implementation is done when a test or a recorded run shows:

- A new database with no site plugin and no admin segment ends with the
  segment, the `roles` plugin row, the people, and the memberships.
- A second run adds nothing.
- Mixed-case and padded emails land on one person; an invalid address is
  filtered out before the call and reported, and does not stop the batch.
- A run against two accounts writes each address only to the account it was
  listed under, and the same address in both gets one person per database.
- Nothing is written without the write switch.
- No `operator` role, no key, and no file other than the superadmins file (and
  only by a deliberate step) is touched.

The recipe above is run against an empty in-memory database in
[test/adminProvisioning.test.js](../test/adminProvisioning.test.js).
