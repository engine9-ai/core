/*
  Who may change membership of a segment.

  Two operations: `add` and `remove`. The target is either the caller
  (self) or another person (other). The policy lives on the segment row:

    join_min_level   lowest Identity Level at which a person may add
                     themselves; 0 = a public form with no login
    leave_min_level  lowest level at which a person may remove themselves;
                     never 0
    manager_role_id  role whose members may add and remove other people

  null means only `admin` scope may do it. This module decides; it does not
  write. HTTP routes and other callers write only after
  `canEditSegmentMembership` allows it.

  Admin means the request's effective scopes include `admin` (API key ∩
  role). A person in admin using a key that lacks `admin` does not
  bypass. Direct SQL bypasses this module entirely; the engine9 server
  surface is in that category. See docs/segments.md.
*/
import { meetsRequiredAuth, ADMIN_SCOPE } from './policy.js';

const OPERATIONS = new Set(['add', 'remove']);

/** Integer 0–7, or null. `leave_min_level` rejects 0. */
export function parseMinLevel(value, { field = 'min_level', allowZero = true } = {}) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0 || n > 7) {
    throw new Error(`${field} must be an integer from 0 to 7, or null`);
  }
  if (!allowZero && n === 0) {
    throw new Error(`${field} cannot be 0; leaving requires an authenticated person`);
  }
  return n;
}

/** Columns for a segment insert/update. Throws on an illegal leave level. */
export function normalizeMembershipPolicy({ joinMinLevel = null, leaveMinLevel = null, managerRoleId = null } = {}) {
  return {
    join_min_level: parseMinLevel(joinMinLevel, { field: 'join_min_level' }),
    leave_min_level: parseMinLevel(leaveMinLevel, { field: 'leave_min_level', allowZero: false }),
    manager_role_id: managerRoleId || null
  };
}

/**
 * Policy object from a segment row. A stored leave_min_level of 0 is treated
 * as closed (null): a bad row must not allow anonymous removal.
 * `scopes` and `requiredAuth` are filled by the caller from the role registry
 * when this segment is a role; they are not columns.
 */
export function membershipPolicyFromRow(row) {
  if (!row) return null;
  let join = row.join_min_level == null || row.join_min_level === '' ? null : Number(row.join_min_level);
  let leave = row.leave_min_level == null || row.leave_min_level === '' ? null : Number(row.leave_min_level);
  if (!Number.isInteger(join) || join < 0 || join > 7) join = null;
  if (!Number.isInteger(leave) || leave <= 0 || leave > 7) leave = null;
  return {
    id: row.id,
    joinMinLevel: join,
    leaveMinLevel: leave,
    managerRoleId: row.manager_role_id || null,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    requiredAuth: row.requiredAuth && typeof row.requiredAuth === 'object' ? row.requiredAuth : null
  };
}

function scopesCover(held, needed) {
  const have = Array.isArray(held) ? held : [];
  const need = Array.isArray(needed) ? needed : [];
  if (need.length === 0) return true;
  if (have.includes(ADMIN_SCOPE)) return true;
  if (need.includes(ADMIN_SCOPE)) return false;
  return need.every((scope) => have.includes(scope));
}

/**
 * Decide one membership change.
 *
 * `targetPersonId` picks the subject:
 *   - equal to `caller.personId`  → self (join_min_level / leave_min_level)
 *   - null                        → self, for a person who is not signed in
 *                                   (a public form; `add` only, and only
 *                                   when join_min_level is 0)
 *   - anyone else                 → other (manager_role_id or admin)
 *
 * The result names the subject so callers can explain a denial:
 *   { allowed, subject: 'self'|'other', reason, granted?: 'admin'|'manager'|'self' }
 *
 * @param {{
 *   policy: ReturnType<typeof membershipPolicyFromRow>|null,
 *   operation: 'add'|'remove',
 *   caller: {
 *     isAdmin?: boolean,
 *     level?: number,
 *     personId?: number|null,
 *     roleIds?: string[],
 *     scopes?: string[],
 *     twoFactor?: boolean
 *   },
 *   targetPersonId?: number|null
 * }} args
 */
export function canEditSegmentMembership({ policy, operation, caller = {}, targetPersonId = null } = {}) {
  const selfId = caller.personId == null ? null : Number(caller.personId);
  const target = targetPersonId == null || targetPersonId === '' ? null : Number(targetPersonId);
  const signedIn = selfId != null && Number.isInteger(selfId);
  const isSelf = target == null || (signedIn && target === selfId);
  const subject = isSelf ? 'self' : 'other';
  const deny = (reason) => ({ allowed: false, subject, reason });
  const allow = (granted) => ({ allowed: true, subject, granted, reason: granted });

  if (!OPERATIONS.has(operation)) return deny(`unknown operation '${operation}'; use add or remove`);
  if (!policy) return deny('unknown segment');
  if (caller.isAdmin) return allow('admin');

  const level = Number.isFinite(Number(caller.level)) ? Number(caller.level) : 0;
  const roleIds = Array.isArray(caller.roleIds) ? caller.roleIds : [];
  const manages = Boolean(policy.managerRoleId) && roleIds.includes(policy.managerRoleId);
  const verb = operation === 'add' ? 'add' : 'remove';
  const segment = policy.name ? `'${policy.name}'` : 'this segment';
  // "add X to S" / "remove X from S"
  const phrase = (who) => `${verb} ${who} ${operation === 'add' ? 'to' : 'from'} ${segment}`;

  if (manages) {
    if (!scopesCover(caller.scopes, policy.scopes)) {
      return deny(
        `cannot ${phrase(isSelf ? 'yourself' : 'other people')}: you manage it, but your effective scopes do not include every scope it grants (${(policy.scopes || []).join(', ')})`
      );
    }
    return allow('manager');
  }

  if (!isSelf) {
    return deny(
      policy.managerRoleId
        ? `cannot ${phrase('other people')}: requires its manager role (${policy.managerRoleId}) or admin scope`
        : `cannot ${phrase('other people')}: it has no manager role, so only admin scope may`
    );
  }

  if (operation === 'add') {
    if (policy.joinMinLevel == null) {
      return deny(`cannot add yourself to ${segment}: join_min_level is not set (an admin or manager must add you)`);
    }
    if (!signedIn && policy.joinMinLevel > 0) {
      return deny(`cannot add yourself to ${segment}: sign in at Identity Level ${policy.joinMinLevel} or higher`);
    }
    if (level < policy.joinMinLevel) {
      return deny(`cannot add yourself to ${segment}: requires Identity Level ${policy.joinMinLevel}, you are at ${level}`);
    }
    if (policy.requiredAuth && !meetsRequiredAuth(policy.requiredAuth, { level, twoFactor: caller.twoFactor })) {
      const need = policy.requiredAuth.minLevel != null ? `Identity Level ${policy.requiredAuth.minLevel}` : 'a stronger login';
      return deny(`cannot add yourself to ${segment}: using this role requires ${need}${policy.requiredAuth.twoFactor ? ' with two-factor' : ''}`);
    }
    return allow('self');
  }

  if (policy.leaveMinLevel == null) {
    return deny(`cannot remove yourself from ${segment}: leave_min_level is not set (an admin or manager must remove you)`);
  }
  if (!signedIn) return deny(`cannot remove yourself from ${segment}: sign in at Identity Level ${policy.leaveMinLevel} or higher`);
  if (level < policy.leaveMinLevel) {
    return deny(`cannot remove yourself from ${segment}: requires Identity Level ${policy.leaveMinLevel}, you are at ${level}`);
  }
  return allow('self');
}

/** Load policies for segment ids. Ids with no row are absent. Registry fills scopes and requiredAuth. */
export async function loadMembershipPolicies(worker, segmentIds, registry = {}) {
  const ids = [...new Set((Array.isArray(segmentIds) ? segmentIds : []).map((id) => (id == null ? '' : String(id).trim())).filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await worker.query({
    sql: `select id, name, join_min_level, leave_min_level, manager_role_id from segment where id in (${ids.map(() => '?').join(',')})`,
    values: ids
  });
  const out = {};
  for (const row of data || []) {
    const role = registry?.[row.id];
    const policy = membershipPolicyFromRow({
      ...row,
      scopes: role?.scopes,
      requiredAuth: role?.requiredAuth
    });
    policy.name = role?.name || row.name || null;
    out[row.id] = policy;
  }
  return out;
}

export default {
  parseMinLevel,
  normalizeMembershipPolicy,
  membershipPolicyFromRow,
  canEditSegmentMembership,
  loadMembershipPolicies
};
