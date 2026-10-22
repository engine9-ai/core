/*
  Canonical role name shipped by roles: 'standard'. Names are arbitrary
  strings; `admin` is the one engine9 uses so every account's registry and
  the private server read the same way. Segment ids come from
  roleSegmentId(accountId, name): every role segment belongs to the account's
  `roles` plugin (rolesPluginId), so any process that knows the account id
  knows the segment id.

  Roles are account-scoped. A Domain (token audience) is an identity
  boundary, not a permission boundary: one account may serve several
  domains, and the person merges across them by verified email.

  Two tiers of administrator:

  admin        Changes the account. A member of this account's `admin`
               segment (person_segment in the account's own database).
               Grants the `admin` scope inside this account's core API,
               which bypasses every segment membership rule. Same word as
               the scope on purpose: the role's only scope is `admin`. On
               the engine9 server an admin opens this one account and may
               do everything in it.
  superadmin   Not a role and not in any database. A verified email on the
               superadmins file (auth/superadmins.js). Acts as `admin` in
               every account the process serves.

  Any other role name (member area, curator, vip, ...) is site-specific.
  Choose names per deployment, create the segment, and list it in
  config.roles -- or install it through a non-core mechanism. Core does not
  ship or recommend those names; see docs/segments.md for examples that use
  the three membership-policy columns (join_min_level, leave_min_level,
  manager_role_id).
*/

export const ROLE_NAMES = Object.freeze({
  ADMIN: 'admin'
});

/** Definitions for ensureRoleSegments. Scopes and requiredAuth feed the role registry. */
export const STANDARD_ROLES = Object.freeze([
  {
    name: ROLE_NAMES.ADMIN,
    description: 'Administrative access to this account',
    scopes: ['admin'],
    requiredAuth: { minLevel: 3 }
  }
]);

export default { ROLE_NAMES, STANDARD_ROLES };
