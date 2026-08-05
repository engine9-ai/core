/*
  Three-layer auth policy helper.

  Layer 1 — API key (enable/disable, default role, scope ceiling)
  Layer 2 — Role (role_id === segment_id UUID; scopes + requiredAuth)
  Layer 3 — Delegate credential level on the session

  resolveAuthContext consolidates role + scope selection for createApi and
  any future server callers that import @engine9/core/auth.
*/

/**
 * Intersect two scope lists. `*` in either list means that side is unrestricted
 * for intersection purposes (the other list wins). Empty list means unrestricted.
 */
export function intersectScopes(keyScopes = [], roleScopes = []) {
  const key = Array.isArray(keyScopes) ? keyScopes : [];
  const role = Array.isArray(roleScopes) ? roleScopes : [];
  if (key.length === 0 && role.length === 0) return [];
  if (key.length === 0) return [...role];
  if (role.length === 0) return [...key];
  if (key.includes('*')) return [...role];
  if (role.includes('*')) return [...key];
  return key.filter((s) => role.includes(s));
}

/** True when scopes allow `scope`. Empty scopes = full access. */
export function hasScope(scopes, scope) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.length === 0) return true;
  return list.includes(scope) || list.includes('*');
}

/**
 * Check Delegate credential level against a role's requiredAuth.
 * Only enforces keys that are explicitly true on requiredAuth (e.g. twoFactor).
 */
export function meetsRequiredAuth(requiredAuth, credentialLevel) {
  if (!requiredAuth || typeof requiredAuth !== 'object') return true;
  if (requiredAuth.twoFactor === true && !credentialLevel?.twoFactor) return false;
  return true;
}

/**
 * Resolve effective auth context from API key + optional role/session.
 *
 * Role id priority: explicit `roleId` → first session role → apiKey.default_role_id
 *
 * @param {{
 *   apiKey?: { id?: string, scopes?: string[], default_role_id?: string|null },
 *   roleId?: string|null,
 *   session?: { roles?: string[], auth?: object }|null,
 *   rolesRegistry?: Record<string, { name?: string, scopes?: string[], requiredAuth?: object }>
 * }} opts
 */
export function resolveAuthContext({
  apiKey = null,
  roleId = null,
  session = null,
  rolesRegistry = {}
} = {}) {
  const registry = rolesRegistry && typeof rolesRegistry === 'object' ? rolesRegistry : {};
  const sessionRoles = Array.isArray(session?.roles) ? session.roles : [];
  const resolvedRoleId =
    roleId ||
    sessionRoles[0] ||
    apiKey?.default_role_id ||
    null;

  const role = resolvedRoleId && registry[resolvedRoleId] ? registry[resolvedRoleId] : null;
  const keyScopes = apiKey?.scopes || [];
  const roleScopes = role?.scopes || [];
  const scopes = intersectScopes(keyScopes, roleScopes);
  const requiredAuth = role?.requiredAuth || {};
  const credentialLevel = session?.auth || null;
  const authSatisfied = meetsRequiredAuth(requiredAuth, credentialLevel);

  return {
    apiKey,
    roleId: resolvedRoleId,
    role,
    scopes,
    requiredAuth,
    credentialLevel,
    authSatisfied
  };
}

export default {
  intersectScopes,
  hasScope,
  meetsRequiredAuth,
  resolveAuthContext
};
