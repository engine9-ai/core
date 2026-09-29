/*
  Privileged groups as segments.

  Every human is a person. A "user" is a person whose person_segment row puts
  them in a role segment. The role registry passed to createDelegateAuth
  (`roles: { [segmentId]: { name, scopes, requiredAuth } }`) decides what
  that membership allows. This module manages the membership itself:

    - ensureRoleSegment        create the segment row for a role (idempotent)
    - setMembershipPolicy      who may add/remove themselves or others
    - addPeopleToSegment       add people by email or person_id
    - removePeopleFromSegment  remove people by email or person_id
    - listSegmentMembers       who is in the segment, with their email
    - personHasRole            one membership check

  The *Segment functions take any segment id; a role is just a segment
  the registry names.

  Email is the key. Adding an email that is not yet a person runs the normal
  inbound pipeline, so the person exists before anyone signs in. When that
  person later logs in through Delegate with a verified email, the login
  merges into the same person and the Domain UNID attaches to it.

  Roles are account-scoped. Every role segment belongs to the account's
  `roles` plugin, rolesPluginId(accountId) = getPluginUUID(accountId, 'roles'),
  and roleSegmentId(accountId, name) = uuidv5(`role:<name>`, that plugin id).
  Any process that knows the account id can compute a role's segment id
  with no lookup, in core sites and on the engine9 server alike.

  `pluginId` in this module is the plugin people are created under when an
  email is new (the site plugin). It does not affect segment ids.
*/
import { v5 as uuidv5 } from 'uuid';
import { getPluginUUID } from '../lib/utilities.js';
import { STANDARD_ROLES } from './roleNames.js';
import { normalizeMembershipPolicy } from './segmentAccess.js';

export { ROLE_NAMES, STANDARD_ROLES } from './roleNames.js';

/** `plugin.path` of the per-account plugin that owns role segments. */
export const ROLES_PLUGIN_PATH = 'roles';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email && EMAIL_RE.test(email) ? email : '';
}

function emailList(emails) {
  const out = [];
  for (const raw of Array.isArray(emails) ? emails : []) {
    const email = normalizeEmail(raw);
    if (!email) throw new Error(`Not an email address: ${raw}`);
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

function personIdList(personIds) {
  const out = [];
  for (const raw of Array.isArray(personIds) ? personIds : []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Not a person_id: ${raw}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function requireWorker(worker, fn) {
  if (!worker || typeof worker.query !== 'function') {
    throw new Error(`${fn} requires a worker (PersonWorker or SQLWorker)`);
  }
}

function requireAccountId(accountId, worker, fn) {
  const id = typeof accountId === 'string' && accountId.trim() ? accountId.trim() : worker?.accountId;
  if (!id) throw new Error(`${fn} requires accountId`);
  return id;
}

/** Plugin id that owns every role segment in an account. */
export function rolesPluginId(accountId) {
  if (!accountId) throw new Error('rolesPluginId requires accountId');
  return getPluginUUID(accountId, ROLES_PLUGIN_PATH);
}

/** Deterministic segment id for a role name in an account. */
export function roleSegmentId(accountId, name) {
  const roleName = typeof name === 'string' ? name.trim() : '';
  if (!roleName) throw new Error('roleSegmentId requires a role name');
  return uuidv5(`role:${roleName}`, rolesPluginId(accountId));
}

/**
 * Role registry for createDelegateAuth / createApi without touching the
 * database: { [segmentId]: { name, scopes, requiredAuth } }. Ids are
 * roleSegmentId(accountId, name), so this matches what ensureRoleSegments
 * creates. Pass `roles: 'standard'` to createApi to use this.
 */
export function standardRoleRegistry(accountId, roles = STANDARD_ROLES) {
  if (!accountId) throw new Error('standardRoleRegistry requires accountId');
  const registry = {};
  for (const role of roles) {
    registry[roleSegmentId(accountId, role.name)] = {
      name: role.name,
      scopes: Array.isArray(role.scopes) ? [...role.scopes] : [],
      requiredAuth: role.requiredAuth && typeof role.requiredAuth === 'object' ? { ...role.requiredAuth } : {}
    };
  }
  return registry;
}

/** Segment id for a role name in a registry (or the id itself when already a key). */
export function roleIdByName(registry, nameOrId) {
  if (!registry || !nameOrId) return null;
  if (registry[nameOrId]) return nameOrId;
  const wanted = String(nameOrId).trim().toLowerCase();
  for (const [id, role] of Object.entries(registry)) {
    if (String(role?.name || '').trim().toLowerCase() === wanted) return id;
  }
  return null;
}

/** Create the account's `roles` plugin row if missing. Returns its id. */
export async function ensureRolesPlugin({ worker, accountId } = {}) {
  requireWorker(worker, 'ensureRolesPlugin');
  const account = requireAccountId(accountId, worker, 'ensureRolesPlugin');
  const id = rolesPluginId(account);
  const { data } = await worker.query({ sql: 'select id from plugin where id=?', values: [id] });
  if (!data[0]) {
    await worker.insertArray({
      table: 'plugin',
      array: [{ id, path: ROLES_PLUGIN_PATH, name: 'Roles', table_prefix: '' }]
    });
  }
  return id;
}

/**
 * Create the segment row for a role if it does not exist.
 * Returns { id, name, created }.
 */
/**
 * Set who may join, leave, and manage a segment (any segment, not only
 * roles). Admin-side call; the HTTP surface has no route for this.
 */
export async function setMembershipPolicy({ worker, segmentId, joinMinLevel, leaveMinLevel, managerRoleId } = {}) {
  requireWorker(worker, 'setMembershipPolicy');
  if (!segmentId) throw new Error('setMembershipPolicy requires segmentId');
  const stored = normalizeMembershipPolicy({ joinMinLevel, leaveMinLevel, managerRoleId });
  await worker.query({
    sql: 'update segment set join_min_level=?, leave_min_level=?, manager_role_id=? where id=?',
    values: [stored.join_min_level, stored.leave_min_level, stored.manager_role_id, segmentId]
  });
  return stored;
}

/**
 * Create the segment row for a role if it does not exist. `policy` (join,
 * leave, manager) is written only when the row is created; an existing
 * row keeps whatever an admin set. Use setMembershipPolicy to change it.
 * Returns { id, name, created }.
 */
export async function ensureRoleSegment({ worker, accountId, name, description, policy } = {}) {
  requireWorker(worker, 'ensureRoleSegment');
  const account = requireAccountId(accountId, worker, 'ensureRoleSegment');
  const roleName = typeof name === 'string' ? name.trim() : '';
  if (!roleName) throw new Error('ensureRoleSegment requires name');
  const segmentId = roleSegmentId(account, roleName);
  const stored = policy ? normalizeMembershipPolicy(policy) : normalizeMembershipPolicy({});
  const { data } = await worker.query({
    sql: 'select id, name from segment where id=?',
    values: [segmentId]
  });
  if (data[0]) return { id: segmentId, name: data[0].name, created: false };
  const pluginId = await ensureRolesPlugin({ worker, accountId: account });
  await worker.insertArray({
    table: 'segment',
    array: [
      {
        id: segmentId,
        plugin_id: pluginId,
        remote_segment_id: `role:${roleName}`,
        name: description ? `${roleName} (${description})` : roleName,
        category: 'role',
        build_type: 'manual',
        join_min_level: stored.join_min_level,
        leave_min_level: stored.leave_min_level,
        manager_role_id: stored.manager_role_id
      }
    ]
  });
  return { id: segmentId, name: roleName, created: true };
}

/**
 * Create segments for a list of role definitions and return the registry
 * shape createDelegateAuth expects: { [segmentId]: { name, scopes, requiredAuth } }.
 * Defaults to STANDARD_ROLES.
 */
function policyForRole(account, role) {
  return {
    joinMinLevel: role.joinMinLevel ?? null,
    leaveMinLevel: role.leaveMinLevel ?? null,
    managerRoleId: role.managerRole ? roleSegmentId(account, role.managerRole) : null
  };
}

export async function ensureRoleSegments({ worker, accountId, roles = STANDARD_ROLES } = {}) {
  const account = requireAccountId(accountId, worker, 'ensureRoleSegments');
  for (const role of roles) {
    await ensureRoleSegment({
      worker,
      accountId: account,
      name: role.name,
      description: role.description,
      policy: policyForRole(account, role)
    });
  }
  return standardRoleRegistry(account, roles);
}

/** person_ids already known for these emails (no creation). Map of email → person_id. */
export async function lookupPersonIdsByEmail({ worker, emails } = {}) {
  requireWorker(worker, 'lookupPersonIdsByEmail');
  const list = emailList(emails);
  if (!list.length) return {};
  const { data } = await worker.query({
    sql: `select person_id, lower(email) as email from person_email where lower(email) in (${list.map(() => '?').join(',')})`,
    values: list
  });
  const found = {};
  for (const row of data) {
    if (!found[row.email]) found[row.email] = row.person_id;
  }
  return found;
}

/**
 * person_ids for emails, creating people through the inbound pipeline when
 * they do not exist. Map of email → person_id. `pluginId` is the plugin new
 * people are recorded under.
 */
export async function personIdsForEmails({
  worker,
  pluginId,
  emails,
  remoteInputId = 'roles',
  inputType = 'api',
  create = true
} = {}) {
  requireWorker(worker, 'personIdsForEmails');
  const list = emailList(emails);
  if (!list.length) return {};
  const known = await lookupPersonIdsByEmail({ worker, emails: list });
  const missing = list.filter((email) => !known[email]);
  if (!missing.length || !create) return known;
  if (!pluginId) throw new Error('personIdsForEmails requires pluginId to create people');
  if (typeof worker.processPeople !== 'function') {
    throw new Error('personIdsForEmails requires a PersonWorker to create people');
  }
  const summary = await worker.processPeople({
    pluginId,
    remoteInputId,
    inputType,
    batch: missing.map((email) => ({ email }))
  });
  missing.forEach((email, index) => {
    const personId = summary.personIds?.[index];
    if (personId) known[email] = personId;
  });
  const failed = missing.filter((email) => !known[email]);
  if (failed.length) throw new Error(`Could not create people for: ${failed.join(', ')}`);
  return known;
}

async function resolveTargets({ worker, pluginId, emails, personIds, create, remoteInputId }) {
  const ids = personIdList(personIds);
  const byEmail = await personIdsForEmails({ worker, pluginId, emails, create, remoteInputId });
  const resolved = new Set(ids);
  for (const id of Object.values(byEmail)) resolved.add(id);
  return { personIds: [...resolved].sort((a, b) => a - b), byEmail };
}

/**
 * Add people to a segment (a role segment or any other). Emails not yet
 * known become people first (recorded under `pluginId`).
 * Returns { segmentId, personIds, byEmail, added }.
 */
export async function addPeopleToSegment({
  worker,
  pluginId,
  segmentId,
  emails = [],
  personIds = [],
  remoteInputId = 'roles'
} = {}) {
  requireWorker(worker, 'addPeopleToSegment');
  if (!segmentId) throw new Error('addPeopleToSegment requires segmentId');
  const targets = await resolveTargets({ worker, pluginId, emails, personIds, create: true, remoteInputId });
  if (!targets.personIds.length) throw new Error('addPeopleToSegment requires at least one email or person_id');
  const { data: existing } = await worker.query({
    sql: `select person_id from person_segment where segment_id=? and person_id in (${targets.personIds.map(() => '?').join(',')})`,
    values: [segmentId, ...targets.personIds]
  });
  const already = new Set(existing.map((row) => Number(row.person_id)));
  const added = targets.personIds.filter((id) => !already.has(id));
  if (added.length) {
    await worker.upsertArray({
      table: 'person_segment',
      array: added.map((person_id) => ({ person_id, segment_id: segmentId }))
    });
  }
  return { segmentId, personIds: targets.personIds, byEmail: targets.byEmail, added };
}

/**
 * Remove people from a segment. Unknown emails are ignored (nothing to
 * remove). Returns { segmentId, personIds, removed }.
 */
export async function removePeopleFromSegment({ worker, segmentId, emails = [], personIds = [] } = {}) {
  requireWorker(worker, 'removePeopleFromSegment');
  if (!segmentId) throw new Error('removePeopleFromSegment requires segmentId');
  const targets = await resolveTargets({ worker, emails, personIds, create: false });
  if (!targets.personIds.length) return { segmentId, personIds: [], removed: [] };
  const { data: existing } = await worker.query({
    sql: `select person_id from person_segment where segment_id=? and person_id in (${targets.personIds.map(() => '?').join(',')})`,
    values: [segmentId, ...targets.personIds]
  });
  const removed = existing.map((row) => Number(row.person_id)).sort((a, b) => a - b);
  if (removed.length) {
    await worker.query({
      sql: `delete from person_segment where segment_id=? and person_id in (${removed.map(() => '?').join(',')})`,
      values: [segmentId, ...removed]
    });
  }
  return { segmentId, personIds: targets.personIds, removed };
}

/** Members of a segment: [{ person_id, emails: [] }]. */
export async function listSegmentMembers({ worker, segmentId } = {}) {
  requireWorker(worker, 'listSegmentMembers');
  if (!segmentId) throw new Error('listSegmentMembers requires segmentId');
  const { data } = await worker.query({
    sql: `select ps.person_id, pe.email
      from person_segment ps
      left join person_email pe on pe.person_id=ps.person_id
      where ps.segment_id=?
      order by ps.person_id, pe.preference_order, pe.email`,
    values: [segmentId]
  });
  const members = new Map();
  for (const row of data) {
    const id = Number(row.person_id);
    if (!members.has(id)) members.set(id, { person_id: id, emails: [] });
    const email = normalizeEmail(row.email);
    if (email && !members.get(id).emails.includes(email)) members.get(id).emails.push(email);
  }
  return [...members.values()];
}

export async function personHasRole({ worker, personId, roleId } = {}) {
  requireWorker(worker, 'personHasRole');
  if (!personId || !roleId) return false;
  const { data } = await worker.query({
    sql: 'select person_id from person_segment where segment_id=? and person_id=? limit 1',
    values: [roleId, personId]
  });
  return data.length > 0;
}

/**
 * Role ids (segment ids) held by the person who owns this email, limited
 * to `roleIds`. One query; used by hosts that only know an email (the
 * engine9 server checking an account database at login).
 */
export async function rolesForEmail({ worker, email, roleIds } = {}) {
  requireWorker(worker, 'rolesForEmail');
  const mail = normalizeEmail(email);
  const ids = Array.isArray(roleIds) ? roleIds.filter(Boolean) : [];
  if (!mail || !ids.length) return [];
  const { data } = await worker.query({
    sql: `select distinct ps.segment_id
      from person_email pe
      join person_segment ps on ps.person_id=pe.person_id
      where lower(pe.email)=? and ps.segment_id in (${ids.map(() => '?').join(',')})`,
    values: [mail, ...ids]
  });
  const found = new Set(data.map((row) => row.segment_id));
  return ids.filter((id) => found.has(id));
}

/** Role ids (segment ids) this person holds from the given registry keys. */
export async function rolesForPerson({ worker, personId, roleIds } = {}) {
  requireWorker(worker, 'rolesForPerson');
  const ids = Array.isArray(roleIds) ? roleIds.filter(Boolean) : [];
  if (!personId || !ids.length) return [];
  const { data } = await worker.query({
    sql: `select segment_id from person_segment where person_id=? and segment_id in (${ids.map(() => '?').join(',')})`,
    values: [personId, ...ids]
  });
  const found = new Set(data.map((row) => row.segment_id));
  return ids.filter((id) => found.has(id));
}

export default {
  ROLES_PLUGIN_PATH,
  normalizeEmail,
  rolesPluginId,
  roleSegmentId,
  standardRoleRegistry,
  roleIdByName,
  ensureRolesPlugin,
  ensureRoleSegment,
  ensureRoleSegments,
  setMembershipPolicy,
  lookupPersonIdsByEmail,
  personIdsForEmails,
  addPeopleToSegment,
  removePeopleFromSegment,
  listSegmentMembers,
  personHasRole,
  rolesForEmail,
  rolesForPerson
};
