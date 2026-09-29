/*
  Canonical role names shipped by roles: 'standard'. Names are arbitrary
  strings; these two are the ones engine9 uses so every account's registry
  and the private server's access cache read the same way. Segment ids come
  from roleSegmentId(accountId, name): every role segment belongs to the
  account's `roles` plugin (rolesPluginId), so any process that knows the
  account id knows the segment id.

  Roles are account-scoped. A Domain (token audience) is an identity
  boundary, not a permission boundary: one account may serve several
  domains, and the person merges across them by verified email.

  admin      Changes the account. Grants the `admin` scope inside this
             account's core API, which bypasses every segment membership
             rule. Same word as the scope on purpose: the role's only
             scope is `admin`.
  operator   Works in the account through engine9's tools (MCP, Conductor,
             Task API): reads data, schedules curated flows. In core it
             cannot change who has permission. On the server it cannot run
             non-SELECT SQL, manage API keys/plugins, or schedule arbitrary
             worker methods — those need the admin role. See docs/segments.md.

  Any other role name (member area, curator, vip, …) is site-specific.
  Choose names per deployment, create the segment, and list it in
  config.roles — or install it through a non-core mechanism. Core does not
  ship or recommend those names; see docs/segments.md for examples that use
  the three membership-policy columns (join_min_level, leave_min_level,
  manager_role_id).

  Both standard roles are account-scoped; the ids derive from the account
  id. There is no separate "engine9 staff" role. Engine9 itself is an
  account (the system account, which holds the account catalog); its staff
  are that account's admin and operator. The private server compiles those
  memberships into its account access cache, which is an index, not the
  record.
*/

export const ROLE_NAMES = Object.freeze({
  ADMIN: 'admin',
  OPERATOR: 'operator'
});

/** Definitions for ensureRoleSegments. Scopes and requiredAuth feed the role registry. */
export const STANDARD_ROLES = Object.freeze([
  {
    name: ROLE_NAMES.ADMIN,
    description: 'Administrative access to this account',
    scopes: ['admin'],
    requiredAuth: { minLevel: 3 }
  },
  {
    name: ROLE_NAMES.OPERATOR,
    description: 'Operates this account through MCP, Conductor, and the Task API',
    scopes: ['data:read', 'tasks:read', 'tasks:schedule'],
    requiredAuth: { minLevel: 3 },
    joinMinLevel: null,
    leaveMinLevel: null
  }
]);

export default { ROLE_NAMES, STANDARD_ROLES };
