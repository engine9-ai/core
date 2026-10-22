# Roles

The permission levels, the requirements sites are checked against, and how to
convert or upgrade a site are in [PERMISSIONS.md](../PERMISSIONS.md). Writing
admins from another system is in [admin-provisioning.md](admin-provisioning.md).
This page is the mechanism.

A role is a segment listed in `config.roles`. Its members get the entry's
`scopes` and must log in at `requiredAuth.minLevel` to use them. Who may add
or remove people in each segment, and the HTTP endpoints for doing so, are in
[segments.md](segments.md). This page is the map.

## Two tiers of administrator

| Tier | Where it lives | Reach |
| --- | --- | --- |
| **admin** | The account's `admin` role segment: `person_segment` in that account's own database. | This one account. |
| **superadmin** | A file of verified emails. Never in a database. | Every account the process serves. |

`admin` is the only canonical role (`roles: 'standard'`):

| Name | Who |
| --- | --- |
| `admin` | Changes the account. `admin` scope in this account's core API. On the engine9 server, may do everything in this account. |

```js
createApi({
  worker,
  keyStore,
  delegate: { sessionSecret: process.env.SESSION_SECRET },
  config: {
    pluginId: process.env.E9_PLUGIN_ID,
    roles: 'standard',
    superadmins: createSuperadminsReader() // optional; see below
  }
});
```

```bash
npx e9core segment add --segment admin --email sam@example.com
```

Ids: `roleSegmentId(accountId, name)` from `@engine9/core/auth/roles`.

## Superadmins

A superadmin is a verified email on a list, kept in a file so that it can be
reviewed, versioned, and changed without touching any account database. It
is recognized by core on a site it serves, and by the engine9 server on every
catalog account.

```json
{ "superadmins": ["chris@example.com"] }
```

```bash
npx e9core superadmin add --email chris@example.com
npx e9core superadmin remove --email chris@example.com
npx e9core superadmin list
```

| Host | Where the list comes from | Changes take effect |
| --- | --- | --- |
| `npx e9core serve` | `engine9.superadmins.json` in the project directory (or `E9_SUPERADMINS_FILE`), plus `E9_SUPERADMINS` | The next request |
| Your Node host | `createSuperadminsReader()` from `@engine9/core/superadmins/node`, passed as `config.superadmins` | The next request |
| Cloudflare Worker | `E9_SUPERADMINS` var, parsed with `superadminsFromText` (`@engine9/core/auth/superadmins`) | The next deploy |
| engine9 server | `ENGINE9_SUPERADMINS_URI` (local path or `s3://`) | Within the file's reload interval |

Rules:

- The email must be verified and the credential at least Identity Level 3
  (`SUPERADMIN_MIN_LEVEL`). A listed email at Level 2 is nobody.
- In core a superadmin holds the account's `admin` role, first in the
  session's `roles`. The role is added on every verify. It is never written
  to `person_segment` and never put in a Core Session, so removing an email
  from the list ends it on the next request.
- A role only narrows the key. A superadmin session with a key that has no
  `admin` scope gets that key's scopes, the same as any admin session.
- For a privileged decision on a session use `auth.rolesForSession(session)`.
  `auth.rolesForPerson(personId)` reads `person_segment` only.
- Keep the file out of git history that outsiders can read if the list is
  sensitive. `e9core serve` refuses to serve it as a static file.

## Site-specific roles

Any other name is chosen per deployment (or installed by a non-core
mechanism). Core does not ship or recommend names like `moderator`,
`member`, or `operator`. Create a `segment` (`category: 'role'`,
`build_type: 'manual'`), list it in `config.roles`, and set the three
membership-policy columns when you need self-join or a manager role.
Examples: [segments.md](segments.md#example-site-roles).
