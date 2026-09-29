# Roles

A role is a segment listed in `config.roles`. Its members get the entry's
`scopes` and must log in at `requiredAuth.minLevel` to use them. Who may add
or remove people in each segment, and the HTTP endpoints for doing so, are in
[segments.md](segments.md). This page is the map.

## Canonical roles (`roles: 'standard'`)

| Name | Who |
| --- | --- |
| `admin` | Changes the account. `admin` scope in this account's core API. |
| `operator` | Works in the account through engine9's tools (MCP, Conductor, Task API). Read data and run curated flows; cannot change keys, plugins, or who has permission. |

Engine9 staff are not a third role: they are the `admin` and `operator` of
engine9's own **system account**. See
[segments.md](segments.md#the-server-the-access-cache-and-the-system-account).

```js
createApi({
  worker,
  keyStore,
  delegate: { sessionSecret: process.env.SESSION_SECRET },
  config: { pluginId: process.env.E9_PLUGIN_ID, roles: 'standard' }
});
```

```bash
npx e9core segment add --segment admin --email sam@example.com
```

Ids: `roleSegmentId(accountId, name)` from `@engine9/core/auth/roles`.

## Site-specific roles

Any other name is chosen per deployment (or installed by a non-core
mechanism). Core does not ship or recommend names like `moderator` or
`member`. Create a `segment` (`category: 'role'`, `build_type: 'manual'`),
list it in `config.roles`, and set the three membership-policy columns when
you need self-join or a manager role. Examples:
[segments.md](segments.md#example-site-roles).
