# Upgrading to @engine9/core 1.11.3 and @engine9/schemas 1.11.3

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL), or
engine9 server accounts. Do every step for every database. The general process
is in [upgrading.md](upgrading.md).

## What changed

- **`setting.value` is `text`, not `varchar(255)`.** Plugin settings such as
  `people_custom_fields` are stored as JSON strings and routinely exceed 255
  characters. MySQL truncated those writes silently. The
  `@engine9/schemas/plugin` schema now declares `value: 'text'`. The
  `setting_value_text` upgrade widens existing columns (MySQL `MODIFY COLUMN`,
  SQLite/D1 table rebuild). `setSetting` checks the live column length and
  throws before insert when a value would exceed it (TEXT max 65535), so
  oversized JSON is never sliced into unreadable debris.

New installs get `text` from the schema. Accounts that already ran a manual
`ALTER` are detected as current.

## 1. Inventory

One row per database before you change anything:

| Project directory | Host (Cloudflare / Node / server account) | Site URL or account id | D1 database or connection | Wrangler env |
| --- | --- | --- | --- | --- |

## 2. Back up

Cloudflare: `npx wrangler d1 time-travel info <database> --remote` and keep the
bookmark. MySQL: a dump or snapshot.

## 3. Install and deploy

```bash
npm install @engine9/core@^1.11.3 @engine9/schemas@^1.11.3
npx wrangler deploy   # or restart the Node service / server release
```

## 4. Dry run, then upgrade

```bash
npx e9core upgrade --url https://www.example.com --dry-run
npx e9core upgrade --url https://www.example.com
```

Server account:

```json
{ "command": "upgrade", "account_id": "<account_id>", "dry_run": true }
```

Expect `setting_value_text` as `pending` then `applied` (or `current` if the
column was already text). Re-run shows `current`.

## 5. Verify

```sql
-- MySQL
show columns from setting like 'value';
-- expect Type: text

-- SQLite / D1
pragma table_info('setting');
-- expect value type TEXT

-- Round-trip a long JSON setting (should not truncate)
select length(value), substr(value, -20) from setting where name like '%custom_fields';
```

If a `*_custom_fields` value was truncated before the upgrade, re-save it with
`plugin` `setSetting` (or the admin UI) after the column is text.

## 1.11.0 (2026-10-16): safer login and sessions

| Where | Change |
| --- | --- |
| A server callback that receives the token in the URL (`response_mode=query`) | Replace `login(token)` with `auth.beginLogin({ returnTo })` on the way out and `auth.finishLogin(delegate_token, { state, cookie })` on the way back. A `state_mismatch` means "sign in again", not an error. The authorize URL now asks for a 5-minute token |
| Logout | Pass a KV-like store as `delegate.sessionRevocations` (Cloudflare: bind `SESSION_REVOCATIONS`) so logout ends the session token, not only the cookie. Without it logout only clears the cookie |
| Production keys | Run `npx e9core setup --remote` (or `setup-keys --remote`, add `--env staging` for another environment). Production gets its own admin key and `SESSION_SECRET`, saved in `.env.production`; the old admin key stops working in production and everyone is signed out. Update CI and scripts that call production with the admin key |
| Privileged decisions | Read `auth.rolesForPerson(personId)` at that moment. The `roles` in a session are a copy for deciding what to show |
| Requests that name a `role_id` | Send one only for a role the caller holds. Any other is `403` (`unknown_role` or `role_not_held`); it no longer falls back to the key's scopes |
| `GET /api/read/:name?person_id=` | With a session it reads the signed-in person. Another `person_id` needs `admin` |
| Erasing a person | New: `POST /api/admin/erase` with `{ person_ids, dry_run: true }` first |

Sessions minted before 1.11.0 carry no `typ`. Core refuses them; the people holding one sign in again.
