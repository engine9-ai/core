# Upgrading to @engine9/core 1.12.0

Instructions for an agent or a person who maintains sites built on
`@engine9/core` or engine9 server accounts. The general process is in
[upgrading.md](upgrading.md).

The requirements this release implements, and the verification steps for a
site, are in [PERMISSIONS.md](../PERMISSIONS.md).

## What changed

Administration has two tiers, not admin and operator.

- **admin** is a member of the account's `admin` role segment, in that
  account's own database (`person_segment`). It is the same role as before.
- **superadmin** is new. It is a verified email on a file, never in a
  database. It acts as the `admin` role in every account the process serves.
  See [roles.md](roles.md#superadmins).
- **operator** is removed. `roles: 'standard'` now installs only `admin`.
  `ROLE_NAMES.OPERATOR` is gone, and `npx e9core segment add --segment
  operator` is no longer a role name.

There is no schema change and no `lib/upgrades` entry. Existing `operator`
segment rows and memberships stay in the database. They grant nothing now:
`operator` is not in the standard registry, so a session carrying that role
id gets no scopes from it.

## Steps

1. Install and deploy as in [upgrading.md](upgrading.md). Run
   `npx e9core upgrade` as usual; it has nothing new to apply.
2. Decide who the former operators are:
   - People who only read data and run flows on the engine9 server need
     nothing in the account database. If they are engine9 staff, add them to
     the superadmins file.
   - People who should keep working in one account become that account's
     admin:

   ```bash
   npx e9core segment members --segment operator   # old membership, by segment id
   npx e9core segment add --segment admin --email sam@example.com
   ```

3. Superadmins, if the site wants any:

   ```bash
   npx e9core superadmin add --email chris@example.com
   ```

   This writes `engine9.superadmins.json` in the project directory
   (`E9_SUPERADMINS_FILE` overrides the path). `npx e9core serve` re-reads it
   on each request and does not serve it as a static file. On Cloudflare set
   `E9_SUPERADMINS` (comma-separated) in the Worker's vars; it takes effect
   at the next deploy.

## Notes

- A superadmin must sign in at Identity Level 3 or higher with a verified
  email. A key is still the ceiling: a superadmin session with a site key
  that lacks `admin` gets the site key's scopes, as any admin session does.
- For a privileged decision on a session, use
  `auth.rolesForSession(session)`. `auth.rolesForPerson(personId)` reads
  `person_segment` only and does not see superadmins.
- A removed email stops being a superadmin on its next request. Core never
  writes `person_segment` for a superadmin and never puts the role in a
  token.
- Engine9 server: this release is paired with the server change that reads
  per-account admins from each account database and superadmins from
  `ENGINE9_SUPERADMINS_URI`. Put admins in each account's `admin` segment
  ([admin-provisioning.md](admin-provisioning.md)) and superadmins in that
  file before removing any older access list. Moving an older list is done by
  the system that owns it, not by core or the server.
