/*
  Three-layer auth policy helper.

  Layer 1 — API key (enable/disable, default role, scope ceiling)
  Layer 2 — Role (role_id === segment_id UUID; scopes + requiredAuth)
  Layer 3 — Delegate credential level on the session

  Scope rules (same for keys and roles):
    - Empty list denies access (keys must be created with an explicit list).
    - `admin` grants every scope (replaces the old `*` wildcard).
    - With a role active: effective scopes = key ∩ role (see intersectScopes).

  resolveAuthContext consolidates role + scope selection for createApi and
  any future server callers that import @engine9/core/auth.
*/

/** Full-access scope for keys and roles. Prefer this over listing every scope. */
export const ADMIN_SCOPE = 'admin';

/**
 * Inbound / public-form access. Keys with this scope use the `e9publickey_`
 * prefix; other keys use `e9key_`. Same `api_key` table — scope is the
 * distinguisher, not a separate key system.
 */
export const PUBLIC_SCOPE = 'public';

/**
 * Combine key and role scope lists into the effective set.
 *
 * | Key scopes | Role scopes | Result |
 * | --- | --- | --- |
 * | empty | anything | `[]` (no access) |
 * | some | empty / no role | key scopes (role does not constrain) |
 * | has `admin` | some | role scopes |
 * | some | has `admin` | key scopes |
 * | both concrete | both concrete | intersection |
 */
export function intersectScopes(keyScopes = [], roleScopes = []) {
  const key = Array.isArray(keyScopes) ? keyScopes : [];
  const role = Array.isArray(roleScopes) ? roleScopes : [];
  if (key.length === 0) return [];
  if (role.length === 0) return [...key];
  if (key.includes(ADMIN_SCOPE)) return [...role];
  if (role.includes(ADMIN_SCOPE)) return [...key];
  return key.filter((s) => role.includes(s));
}

/** Whether `scopes` authorize a specific `scope` (or include `admin`). */
export function hasScope(scopes, scope) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.length === 0) return false;
  return list.includes(scope) || list.includes(ADMIN_SCOPE);
}

/**
 * Validate scopes for API key creation / CLI.
 * Requires a non-empty array; rejects legacy `*` (use `admin`).
 */
export function assertValidKeyScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes.map((s) => String(s).trim()).filter(Boolean) : [];
  if (list.length === 0) {
    throw new Error('API key scopes are required (e.g. --scopes tasks:read,tasks:schedule or --scopes admin)');
  }
  if (list.includes('*')) {
    throw new Error('Invalid scope "*": use "admin" for full access');
  }
  return list;
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
  ADMIN_SCOPE,
  PUBLIC_SCOPE,
  intersectScopes,
  hasScope,
  assertValidKeyScopes,
  meetsRequiredAuth,
  resolveAuthContext
};
