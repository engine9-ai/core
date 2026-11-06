# Upgrading to @engine9/core 1.16.0

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL), or
engine9 server accounts. Do every step for every site. The general process
is in [upgrading.md](upgrading.md).

Two changes. Read both before you deploy. Neither changes the database: there
is no `lib/upgrades` entry and nothing to run with `e9core upgrade`.

| # | Change | Who is affected | Breaks a build? |
| --- | --- | --- | --- |
| 1 | A Delegate login finds the person by its confirmed email, not by the Domain UNID | Every site that signs people in with Delegate | No. Who a login resolves to can change |
| 2 | `PERSON_ID_DELEGATE_KV`, `PERSON_SEGMENT_VK`, and `@engine9/core/cloudflare/kv` are removed | Cloudflare sites that bound either namespace or import that path | Yes, if you import `@engine9/core/cloudflare/kv` |

## Find out whether this affects your site

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

## 1. A login is found by its confirmed email

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
[auth/README.md](../auth/README.md#who-is-signing-in-credential-identity-deduplication).

| Where | Find | Change to |
| --- | --- | --- |
| Your own records | Tables or lookups keyed on `session.domainUnid`, `sub`, or `person_id_delegate` | Key on `session.personId` |
| `login(token, { person })` | `person.email` meant to replace the token's address | Remove `email` from `person`. A confirmed email on the token always wins; `person.email` is used only when the token has none |
| "Change your Delegate information" / Switch email | Copy that promises the person's data follows them ("your stories stay with you") | "What you see here follows the address you sign in with" |
| Two addresses that must be one person | Expecting Delegate to join them | Join them in core: import both with the same `person_id` or `remote_person_id`, or merge |

New export: `delegateConfirmedEmail(delegateUser)` returns the confirmed
address, or undefined.

## 2. The KV caches are removed

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

## Deploy steps, in order

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
