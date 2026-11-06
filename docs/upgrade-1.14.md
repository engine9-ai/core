# Upgrading to @engine9/core 1.13.1 and 1.14.0

Instructions for an agent or an operator that maintains one or more sites
built on `@engine9/core`, on Cloudflare (D1) or Node (SQLite or MySQL), or
engine9 server accounts. Do every step for every site. The general process
is in [upgrading.md](upgrading.md).

Do 1.13.0 first ([upgrade-1.12.md](upgrade-1.12.md)).

## 1.13.1 (2026-10-23): manage segments on a deployed site

Added: `e9core segment list|members|add|remove --url <site>`,
`GET /api/admin/segments`, `GET /api/admin/segments/:segment/members`, and
role names as `segment_id` in `POST /api/auth/segments`.

| Where | Change |
| --- | --- |
| First admin on a Cloudflare (D1) site | `npx e9core segment add --segment admin --url https://www.example.com --email you@example.org`. It uses the production admin key (`--key`, `E9_ADMIN_API_KEY`, or `.env.production`) |
| A plugin package of your own that declares `exports` | `build-plugins` writes only exported paths. Export `<dir>/index.js` and re-export `schema` and `settings` from it. A plugin the package does not export stops the build with `PLUGIN_CONFIG_INVALID` |

## 1.14.0 (2026-10-23): one-link sign-in and a role gate

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
