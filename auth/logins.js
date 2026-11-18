/*
  Logins: who can sign in, and as which person.

  `person_login` (@engine9/schemas/login) is this database's /etc/passwd. One
  row is one login: a Delegate account (`delegate`, by Domain UNID) or a
  verified email address (`email`, by email_hash_v1), and the person it signs
  in as. Sign-in, an admin's grant, and the `e9core signin` commands write it.
  The people pipeline (dedupe) never does, so nothing a public form writes can
  change who someone signs in as. Dedupe is asked in two places only: a first
  sign-in and a first grant, to find a person to adopt.

  Rules (docs/sign-in.md, "Who is signing in"; PERMISSIONS.md PL-13):

  - Below Identity Level 2 nothing is written. An existing login signs in with
    self-join roles only; otherwise the visitor is found by Domain UNID, as
    before this table existed.
  - At Level 2 and above, subject first (OpenID Connect Core 5.7): the
    subject's row, else a `merged_from` row, else the email's row. An address
    first used by another Delegate account stops (`login_reassigned`). A
    locked or retired login stops (`login_locked`), except that a retired
    address used by a new account makes a new person.
  - No row: dedupe names a person. Nobody signs in as it: adopt it (`adopted`,
    self-join roles only). Nobody: a new person (`created`). Somebody already
    signs in as it: stop with `other_login`, which shows one of that person's
    addresses masked, unless the person chose "This isn't me" in the Login
    button (`newAccount`), which makes a new person.
  - A subject that signed in without a verified address yields, once, to a
    granted address: see subjectYields.

  Sign-in is a plugin of its own (@engine9/schemas/login). loginMode says
  which of three states a database is in:

  - `on`: the table exists. These rules.
  - `legacy`: no table, and this database has not run the release that made
    sign-in a plugin (@engine9/schemas 1.15.0; its person plugin's last
    install is older). Every caller keeps the lookup it used before, until
    `e9core upgrade` turns sign-in on; `e9core status` fails `login.table`.
  - `off`: no table after that upgrade. The database has no sign-in: every
    sign-in stops with `sign_in_off`, sessions hold nothing, and nothing
    ever falls back to dedupe.
*/
import crypto from 'node:crypto';
import { createDefaultIdentifierStore } from '../lib/id/index.js';
import { insertPersons } from '../lib/id/sqlStore.js';
import semver from 'semver';

export const LOGIN_TABLE = 'person_login';
export const LOGIN_TYPES = ['email', 'delegate'];
export const LOGIN_STOP_REASONS = ['other_login', 'login_reassigned', 'login_locked', 'sign_in_off'];
/** The plugin that holds person_login. A database without it has no sign-in. */
export const LOGIN_PLUGIN_PATH = '@engine9/schemas/login';
/** The @engine9/schemas release that made sign-in its own plugin. Older databases are `legacy`. */
export const LOGIN_PLUGIN_SINCE = '1.15.0';
/** What a person sees, and what a 409 says, on a database with no sign-in. */
export const SIGN_IN_OFF_MESSAGE =
  'This site does not have sign-in. Its database needs the login plugin: npx e9core upgrade --plugin @engine9/schemas/login';
/** Identity Level at which a sign-in may write or claim a login (Contact Confirmed). */
export const LOGIN_MIN_LEVEL = 2;

const COLUMNS = 'type, value_hash, subject, person_id, how, state, last_sign_in_at';
const READY_RECHECK_MS = 30000;

/** SHA-256 hex of the trimmed, lowercased value. For email this is email_hash_v1. */
export function loginHash(value) {
  return crypto.createHash('sha256').update(String(value ?? '').trim().toLowerCase(), 'utf8').digest('hex');
}

/**
 * One address, masked the same way for every address: the first and last
 * character of the local part and of the first domain label, three stars in
 * between whatever the length, and the rest of the domain. A part of one or
 * two characters shows only its first. `vic.tor@gmail.com` -> `v***r@g***l.com`.
 */
export function maskEmail(address) {
  const [local = '', domain = ''] = String(address ?? '').trim().toLowerCase().split('@');
  const part = (p) => (p.length <= 2 ? `${p[0] || ''}***` : `${p[0]}***${p[p.length - 1]}`);
  const [label = '', ...rest] = domain.split('.');
  return `${part(local)}@${part(label)}${rest.length ? `.${rest.join('.')}` : ''}`;
}

const modeCache = new WeakMap();

function isMissingTable(e) {
  return e?.code === 'DOES_NOT_EXIST' || /does not exist|no such table/i.test(String(e?.message || ''));
}

/* Whether the person plugin was last installed by @engine9/schemas 1.15.0 or later. */
async function upgradedPastLegacy(worker) {
  try {
    const { data } = await worker.query({ sql: 'select last_install from plugin where path=?', values: ['@engine9/schemas/person'] });
    if (!data?.length) return true; // no person plugin: nothing to sign in as
    let last = data[0].last_install;
    if (typeof last === 'string') last = JSON.parse(last || '{}');
    const version = semver.valid(semver.coerce(last?.version || ''));
    return Boolean(version && semver.gte(version, LOGIN_PLUGIN_SINCE));
  } catch (e) {
    // A plugin table from before the last_install columns: an old database.
    return false;
  }
}

/**
 * 'on' | 'legacy' | 'off' (see the comment at the top). Cached once on;
 * rechecked every 30 seconds otherwise. A worker that cannot describe tables
 * (a host's stub) is 'legacy': it has no table to read and no plugin rows.
 */
export async function loginMode(worker) {
  const cached = modeCache.get(worker);
  if (cached?.mode === 'on') return 'on';
  if (cached && Date.now() - cached.at < READY_RECHECK_MS) return cached.mode;
  if (!worker || typeof worker.describe !== 'function' || typeof worker.query !== 'function') return 'legacy';
  let mode = 'on';
  try {
    await worker.describe({ table: LOGIN_TABLE });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    mode = (await upgradedPastLegacy(worker)) ? 'off' : 'legacy';
  }
  modeCache.set(worker, { mode, at: Date.now() });
  return mode;
}

/** Whether this database has person_login (loginMode is 'on'). */
export async function loginTableReady(worker) {
  return (await loginMode(worker)) === 'on';
}

/** Forget the cached answer (after an upgrade or an install in the same process, and in tests). */
export function forgetLoginTable(worker) {
  modeCache.delete(worker);
}

/** The error a sign-in on a database with no sign-in throws (loginStop, reason sign_in_off). */
export function signInOffError() {
  return stop('sign_in_off');
}

function stop(reason, extra = {}) {
  const messages = {
    other_login: 'This email address belongs to someone here who signs in with a different address.',
    login_reassigned: 'This address signs in to an account here through a different Delegate account.',
    login_locked: 'This sign-in is turned off.',
    sign_in_off: SIGN_IN_OFF_MESSAGE
  };
  const error = new Error(messages[reason] || reason);
  error.reason = reason;
  error.loginStop = true;
  Object.assign(error, extra);
  return error;
}

function rowOut(row) {
  if (!row) return null;
  return { ...row, person_id: Number(row.person_id) };
}

/** The login row for one value, or null. */
export async function loginRow(worker, type, value) {
  if (value == null || String(value).trim() === '') return null;
  const { data } = await worker.query({
    sql: `select ${COLUMNS} from ${LOGIN_TABLE} where type=? and value_hash=?`,
    values: [type, loginHash(value)]
  });
  return rowOut(data[0]);
}

async function loginRowByHash(worker, type, hash) {
  const { data } = await worker.query({
    sql: `select ${COLUMNS} from ${LOGIN_TABLE} where type=? and value_hash=?`,
    values: [type, hash]
  });
  return rowOut(data[0]);
}

/** Every login of a person. */
export async function loginsOfPerson(worker, personId) {
  const { data } = await worker.query({
    sql: `select ${COLUMNS} from ${LOGIN_TABLE} where person_id=? order by type, created_at`,
    values: [personId]
  });
  return data.map(rowOut);
}

async function personHasLogin(worker, personId) {
  const { data } = await worker.query({
    sql: `select 1 as x from ${LOGIN_TABLE} where person_id=? limit 1`,
    values: [personId]
  });
  return data.length > 0;
}

async function personHoldsSegments(worker, personId) {
  const { data } = await worker.query({
    sql: 'select 1 as x from person_segment where person_id=? limit 1',
    values: [personId]
  });
  return data.length > 0;
}

/*
  Write one login. An existing row for the value is moved and changed; its
  subject stays only while it stays on the same person (an email row's subject
  is the account that first used it there).
*/
async function putLogin(worker, { type, value, hash, personId, how, state = 'active', subject }) {
  const valueHash = hash || loginHash(value);
  const subjectValue = type === 'delegate' ? String(value) : subject ?? null;
  const existing = await loginRowByHash(worker, type, valueHash);
  if (!existing) {
    await worker.query({
      sql: `insert into ${LOGIN_TABLE} (type, value_hash, subject, person_id, how, state) values (?, ?, ?, ?, ?, ?)`,
      values: [type, valueHash, subjectValue, personId, how, state]
    });
    return;
  }
  const keepSubject = subjectValue ?? (existing.person_id === Number(personId) ? existing.subject : null);
  await worker.query({
    sql: `update ${LOGIN_TABLE} set person_id=?, how=?, state=?, subject=? where type=? and value_hash=?`,
    values: [personId, how, state, keepSubject, type, valueHash]
  });
}

async function touchLogins(worker, rows) {
  for (const { type, value_hash: valueHash } of rows) {
    await worker.query({
      sql: `update ${LOGIN_TABLE} set last_sign_in_at=CURRENT_TIMESTAMP where type=? and value_hash=?`,
      values: [type, valueHash]
    });
  }
}

/* ------------------------------------------------------------- dedupe */

async function dedupePerson(worker, idType, value) {
  if (!value) return null;
  const store = await createDefaultIdentifierStore(worker);
  const idValue = idType === 'email_hash_v1' ? loginHash(value) : String(value).trim().toLowerCase();
  const rows = await store.findByIdentifiers([{ id_type: idType, id_value: idValue }]);
  return rows?.[0]?.person_id != null ? Number(rows[0].person_id) : null;
}

/** The person dedupe holds for this address, or null. */
export const dedupePersonForEmail = (worker, email) => dedupePerson(worker, 'email_hash_v1', email);

async function newPerson(worker, { pluginId, email, subject, remoteInputId, inputType }) {
  // A new address: the pipeline creates the person and files the address, as an import would.
  if (email && (await dedupePersonForEmail(worker, email)) == null) {
    const summary = await worker.processPeople({ pluginId, remoteInputId, inputType, batch: [{ email }] });
    if (summary.personIds?.[0]) return Number(summary.personIds[0]);
  }
  // No address: the Domain UNID files the person, so a Level 0 visit and a later sign-in agree.
  if (!email && subject && (await dedupePerson(worker, 'delegate', subject)) == null) {
    const summary = await worker.processPeople({ pluginId, remoteInputId, inputType, batch: [{ delegate_id: subject }] });
    if (summary.personIds?.[0]) return Number(summary.personIds[0]);
  }
  // The address or subject belongs to someone else: an empty person.
  const [id] = await insertPersons(worker, [{}]);
  return Number(id);
}

/* ------------------------------------------------------- the mask */

/**
 * One active email login of this person, masked, most recently used first.
 * Null on a PII-free account (no person_email table) or when there is none.
 */
export async function maskedLoginOf(worker, personId) {
  let emails;
  try {
    ({ data: emails } = await worker.query({
      sql: 'select email from person_email where person_id=?',
      values: [personId]
    }));
  } catch {
    return null;
  }
  const logins = (await loginsOfPerson(worker, personId)).filter((r) => r.type === 'email' && r.state === 'active');
  const byHash = new Map(logins.map((r) => [r.value_hash, r]));
  const hits = (emails || [])
    .map((r) => ({ email: r.email, row: byHash.get(loginHash(r.email)) }))
    .filter((x) => x.row);
  hits.sort((a, b) => String(b.row.last_sign_in_at || '').localeCompare(String(a.row.last_sign_in_at || '')));
  return hits[0] ? maskEmail(hits[0].email) : null;
}

/* ------------------------------------------------------------ sign-in */

function identityLevel(identity) {
  if (typeof identity.level === 'number') return identity.level;
  return identity.email ? LOGIN_MIN_LEVEL : 0;
}

/*
  A subject that signed in without a verified address (a Level 0 visit
  cannot write one; Microsoft or Facebook, or a phone at Level 2, can) made
  an empty person. When the same account later proves an address an admin
  named (granted or backfilled) that no account has used yet, the subject
  moves there. Only when the empty person has no email login and no segment,
  so nothing it holds is lost.
*/
async function subjectYields(worker, rSub, rEmail) {
  if (!rSub || !rEmail) return false;
  if (rSub.how !== 'created' || rEmail.state !== 'active' || rEmail.subject) return false;
  if (!['granted', 'backfill'].includes(rEmail.how) || rEmail.person_id === rSub.person_id) return false;
  const mine = await loginsOfPerson(worker, rSub.person_id);
  if (mine.some((r) => r.type === 'email')) return false;
  return !(await personHoldsSegments(worker, rSub.person_id));
}

/**
 * Which person this verified identity signs in as.
 *
 * identity: { subject (Domain UNID), mergedFrom?, email? (verified only), level }
 * options:
 *   newAccount  the person chose "This isn't me" after an other_login stop
 *   readOnly    find only: never write, adopt, or stop with a prompt (agents)
 *   person      fields to record on the person after sign-in (as today)
 *
 * Returns { personId, how, foundBy }. Throws an error with `reason`
 * other_login (and `masked`), login_reassigned, or login_locked.
 */
export async function personForSignIn({
  worker,
  pluginId,
  identity,
  newAccount = false,
  readOnly = false,
  person = {},
  remoteInputId = 'delegate',
  inputType = 'api',
  audit = null
}) {
  if (!worker) throw new Error('personForSignIn requires a worker');
  // No person_login: no sign-in (a host calling this directly gets the same stop).
  if (!(await loginTableReady(worker))) throw stop('sign_in_off');
  const subject = identity?.subject ? String(identity.subject) : null;
  if (!subject) throw new Error('personForSignIn requires identity.subject (the Domain UNID)');
  const level = identityLevel(identity);
  const rSub = await loginRow(worker, 'delegate', subject);

  /* Level 0 and 1: read only. */
  if (level < LOGIN_MIN_LEVEL) {
    if (rSub && rSub.state !== 'active') throw stop('login_locked');
    if (rSub) return { personId: rSub.person_id, how: rSub.how, foundBy: 'subject' };
    if (readOnly) return { personId: null, how: null, foundBy: 'none' };
    const record = { ...person, delegate_id: subject };
    if (identity.mergedFrom && identity.mergedFrom !== subject) record.delegate_merged_from = identity.mergedFrom;
    const summary = await worker.processPeople({ pluginId, remoteInputId, inputType, batch: [record] });
    const personId = Number(summary.personIds?.[0]);
    if (!personId) throw new Error('delegate person resolution did not produce a person_id');
    return { personId, how: null, foundBy: 'visitor' };
  }

  const email = identity.email ? String(identity.email).trim().toLowerCase() : null;
  const rMerged = identity.mergedFrom && identity.mergedFrom !== subject ? await loginRow(worker, 'delegate', identity.mergedFrom) : null;
  const rEmail = email ? await loginRow(worker, 'email', email) : null;
  let personId;
  let how;
  let foundBy;
  let moveSubject = false;

  if (rSub) {
    if (rSub.state !== 'active') throw stop('login_locked');
    if (await subjectYields(worker, rSub, rEmail)) {
      ({ person_id: personId, how } = rEmail);
      foundBy = 'granted_email';
      moveSubject = true;
    } else {
      ({ person_id: personId, how } = rSub);
      foundBy = 'subject';
    }
  } else if (rMerged && rMerged.state === 'active') {
    ({ person_id: personId, how } = rMerged);
    foundBy = 'merged_from';
  } else if (rEmail && rEmail.state === 'locked') {
    throw stop('login_locked');
  } else if (rEmail && rEmail.state === 'retired') {
    if (readOnly) return { personId: null, how: null, foundBy: 'none' };
    personId = await newPerson(worker, { pluginId, email: null, subject: null, remoteInputId, inputType });
    how = 'created';
    foundBy = 'retired_address';
    await putLogin(worker, { type: 'email', value: email, personId, how, subject });
  } else if (rEmail) {
    if (rEmail.subject && rEmail.subject !== subject) throw stop('login_reassigned');
    ({ person_id: personId, how } = rEmail);
    foundBy = 'email';
  } else {
    if (readOnly) return { personId: null, how: null, foundBy: 'none' };
    const candidate = email ? await dedupePersonForEmail(worker, email) : await dedupePerson(worker, 'delegate', subject);
    const claimed = candidate != null && (await personHasLogin(worker, candidate));
    if (candidate != null && !claimed) {
      personId = candidate;
      how = 'adopted';
      foundBy = 'dedupe';
    } else if (claimed && !newAccount) {
      throw stop('other_login', { masked: await maskedLoginOf(worker, candidate) });
    } else {
      personId = await newPerson(worker, {
        pluginId,
        email: candidate == null ? email : null,
        subject: candidate == null ? subject : null,
        remoteInputId,
        inputType
      });
      how = 'created';
      foundBy = claimed ? 'new_account' : 'new';
    }
  }
  if (readOnly) return { personId, how, foundBy };

  // Write the logins this token brings, on the person it found.
  if (!rSub || moveSubject) await putLogin(worker, { type: 'delegate', value: subject, personId, how });
  const emailNow = email ? await loginRow(worker, 'email', email) : null;
  if (email && !emailNow) await putLogin(worker, { type: 'email', value: email, personId, how, subject });
  else if (emailNow && !emailNow.subject && emailNow.person_id === personId) {
    await worker.query({
      sql: `update ${LOGIN_TABLE} set subject=? where type='email' and value_hash=?`,
      values: [subject, emailNow.value_hash]
    });
  }
  const used = [{ type: 'delegate', value_hash: loginHash(subject) }];
  if (email) used.push({ type: 'email', value_hash: loginHash(email) });
  await touchLogins(worker, used);

  if (foundBy === 'new_account' || moveSubject) {
    await auditLogin(worker, audit, foundBy === 'new_account' ? 'login.new_account' : 'login.subject_moved', {
      person_id: personId,
      subject_hash: loginHash(subject).slice(0, 16)
    });
  }
  await recordSignInData(worker, { pluginId, personId, email, subject, person, remoteInputId, inputType });
  return { personId, how, foundBy };
}

/*
  The sign-in's own data (fields the site passed, a new address) goes on the
  person through the pipeline, as before. An address dedupe files under
  someone else stays there: data dedupe is not changed by a sign-in.
*/
async function recordSignInData(worker, { pluginId, personId, email, subject, person, remoteInputId, inputType }) {
  const fields = { ...(person || {}) };
  const hasFields = Object.keys(fields).length > 0;
  // The pipeline files a row by an identifier: one this person owns, or a new
  // one. A row with person_id and no identifier would make an empty person.
  let identifier = null;
  let isNew = false;
  if (email) {
    const owner = await dedupePersonForEmail(worker, email);
    if (owner == null || owner === personId) {
      identifier = { email };
      isNew = owner == null;
    }
  } else if (subject) {
    // No verified address: the Domain UNID, as sign-in always filed it.
    const owner = await dedupePerson(worker, 'delegate', subject);
    if (owner == null || owner === personId) {
      identifier = { delegate_id: subject };
      isNew = owner == null;
    }
  }
  if (!identifier || (!isNew && !hasFields)) return;
  await worker.processPeople({ pluginId, remoteInputId, inputType, batch: [{ ...fields, ...identifier, person_id: personId }] });
}

/* -------------------------------------------------------------- roles */

/**
 * The login a session signed in with: its subject's row, else its email's
 * (a session from before the upgrade has no subject row yet). An email row
 * another Delegate account first used is not this session's.
 */
export async function loginForSession(worker, session) {
  const bySubject = await loginRow(worker, 'delegate', session?.domainUnid);
  if (bySubject) return bySubject;
  const byEmail = session?.email ? await loginRow(worker, 'email', session.email) : null;
  if (byEmail?.subject && session?.domainUnid && byEmail.subject !== session.domainUnid) return null;
  return byEmail;
}

/**
 * Role ids (from `roleIds`) this session holds now, through its login.
 *
 * - An active login on the session's person carries the person's roles; an
 *   adopted login, or a session below Level 2, only self-join roles at or
 *   below the session's level (`join_min_level`).
 * - A Level 0 or 1 visitor with no login keeps the self-join roles its person
 *   holds at its level.
 * - Otherwise (a locked or retired login, a login on another person, a
 *   session from before the upgrade with no login): none.
 */
export async function loginRoleIds({ worker, session, roleIds }) {
  const ids = (roleIds || []).filter(Boolean);
  const personId = Number(session?.personId);
  if (!ids.length || !Number.isInteger(personId)) return [];
  const level = typeof session.level === 'number' ? session.level : 0;
  const row = await loginForSession(worker, session);
  const visitor = !row && level < LOGIN_MIN_LEVEL;
  if (!visitor && (!row || row.state !== 'active' || row.person_id !== personId)) return [];
  const { data } = await worker.query({
    sql: `select ps.segment_id, s.join_min_level from person_segment ps
      left join segment s on s.id=ps.segment_id
      where ps.person_id=? and ps.segment_id in (${ids.map(() => '?').join(',')})`,
    values: [personId, ...ids]
  });
  const selfJoinOnly = visitor || level < LOGIN_MIN_LEVEL || row.how === 'adopted';
  const held = new Set(
    data
      .filter((r) => !selfJoinOnly || (r.join_min_level != null && r.join_min_level !== '' && level >= Number(r.join_min_level)))
      .map((r) => r.segment_id)
  );
  return ids.filter((id) => held.has(id));
}

/**
 * Role ids an email's login holds (a host that knows only the address, such
 * as the engine9 server). An active email row only; it never reads
 * person_email and never adopts. Pass `subject` when known, so an address
 * first used by another Delegate account is refused.
 */
export async function loginRoleIdsForEmail({ worker, email, subject, roleIds, level = 3 }) {
  const row = await loginRow(worker, 'email', email);
  if (!row || row.state !== 'active') return [];
  if (subject && row.subject && row.subject !== subject) return [];
  return loginRoleIds({ worker, session: { personId: row.person_id, email, level }, roleIds });
}

/* -------------------------------------------------------------- grants */

/**
 * The person an admin's grant by email reaches, writing its `granted` login.
 * A login for the address: its person (an adopted one becomes granted). No
 * login: an unclaimed dedupe person, or a new person. Never a person someone
 * else already signs in as; `note` says when dedupe named one.
 */
export async function personForGrant({ worker, pluginId, email, remoteInputId = 'roles', inputType = 'api' }) {
  const address = String(email ?? '').trim().toLowerCase();
  const row = await loginRow(worker, 'email', address);
  if (row && row.state !== 'retired') {
    if (row.how === 'adopted') {
      await worker.query({
        sql: `update ${LOGIN_TABLE} set how='granted' where person_id=? and how='adopted'`,
        values: [row.person_id]
      });
    }
    return { personId: row.person_id, login: 'existing' };
  }
  const candidate = await dedupePersonForEmail(worker, address);
  const claimed = candidate != null && (await personHasLogin(worker, candidate));
  let personId;
  let note;
  if (candidate != null && !claimed) personId = candidate;
  else {
    if (!pluginId) throw new Error('a grant to a new address requires pluginId');
    personId = await newPerson(worker, { pluginId, email: candidate == null ? address : null, subject: null, remoteInputId, inputType });
    if (claimed) note = `${address} is on person ${candidate}, who signs in with another address; made person ${personId}. Use e9core signin link to put the address on person ${candidate} instead.`;
  }
  await putLogin(worker, { type: 'email', value: address, personId, how: 'granted' });
  return { personId, login: 'granted', ...(note ? { note } : {}) };
}

/** The person whose login this address is (for removals), or null. */
export async function personForLoginEmail(worker, email) {
  const row = await loginRow(worker, 'email', email);
  return row && row.state !== 'retired' ? row.person_id : null;
}

/* ---------------------------------------------------- admin commands */

async function auditLogin(worker, audit, action, meta) {
  const sink = audit || worker.audit;
  if (!sink) return;
  const record = { accountId: worker.accountId, action, meta };
  try {
    await sink.log(record);
  } catch (e) {
    console.error(JSON.stringify({ engine9_audit_write_failed: String(e?.message || e), ...record }));
  }
}

function target({ email, subject }) {
  if (email) return { type: 'email', value: String(email).trim().toLowerCase() };
  if (subject) return { type: 'delegate', value: String(subject).trim() };
  throw new Error('name a login: --email <address> or --subject <Domain UNID>');
}

async function emailsByHash(worker, personIds) {
  const map = new Map();
  if (!personIds.length) return map;
  try {
    const { data } = await worker.query({
      sql: `select email from person_email where person_id in (${personIds.map(() => '?').join(',')})`,
      values: personIds
    });
    data.forEach((r) => map.set(loginHash(r.email), String(r.email).trim().toLowerCase()));
  } catch {
    // PII-free: hashes only.
  }
  return map;
}

function describeRow(row, emails) {
  return {
    type: row.type,
    ...(row.type === 'email' && emails.get(row.value_hash) ? { email: emails.get(row.value_hash) } : {}),
    value_hash: row.value_hash,
    ...(row.subject ? { subject: row.subject } : {}),
    person_id: row.person_id,
    how: row.how,
    state: row.state,
    last_sign_in_at: row.last_sign_in_at || null
  };
}

/** `signin list`: the logins of a person, or of the person an address or subject signs in as. */
export async function listLogins({ worker, personId, email, subject }) {
  let pid = personId != null ? Number(personId) : null;
  if (pid == null) {
    const { type, value } = target({ email, subject });
    const row = await loginRow(worker, type, value);
    if (!row) return { person_id: null, logins: [] };
    pid = row.person_id;
  }
  const rows = await loginsOfPerson(worker, pid);
  const emails = await emailsByHash(worker, [pid]);
  return { person_id: pid, logins: rows.map((r) => describeRow(r, emails)) };
}

/** `signin explain`: what a sign-in with this address or subject would do now, and why. Reads only. */
export async function explainLogin({ worker, email, subject, roleIds = [] }) {
  const out = { ...(email ? { email: String(email).trim().toLowerCase() } : {}), ...(subject ? { subject } : {}) };
  const rSub = subject ? await loginRow(worker, 'delegate', subject) : null;
  const rEmail = email ? await loginRow(worker, 'email', email) : null;
  const emails = await emailsByHash(worker, [rSub?.person_id, rEmail?.person_id].filter((x) => x != null));
  if (rSub) out.subject_login = describeRow(rSub, emails);
  if (rEmail) out.email_login = describeRow(rEmail, emails);
  let outcome;
  let personId = null;
  if (rSub) {
    if (rSub.state !== 'active') outcome = { result: 'stop', reason: 'login_locked', why: `the Delegate account's login is ${rSub.state}` };
    else if (await subjectYields(worker, rSub, rEmail)) {
      personId = rEmail.person_id;
      outcome = { result: 'sign_in', person_id: personId, why: 'the account signed in before without a verified address; the granted address moves it to the granted person' };
    } else {
      personId = rSub.person_id;
      outcome = { result: 'sign_in', person_id: personId, why: 'the Delegate account has a login on this person' };
    }
  } else if (rEmail) {
    if (rEmail.state === 'locked') outcome = { result: 'stop', reason: 'login_locked', why: 'the address\'s login is locked' };
    else if (rEmail.state === 'retired') outcome = { result: 'new_person', why: 'the address was retired; a new account with it gets a new person' };
    else if (subject && rEmail.subject && rEmail.subject !== subject) outcome = { result: 'stop', reason: 'login_reassigned', why: 'another Delegate account first signed in with this address' };
    else {
      personId = rEmail.person_id;
      outcome = { result: 'sign_in', person_id: personId, why: rEmail.subject ? 'the address has a login on this person' : `the address has a ${rEmail.how} login that no account has used yet; the first account to sign in with it binds to it` };
    }
  } else {
    const candidate = email ? await dedupePersonForEmail(worker, email) : subject ? await dedupePerson(worker, 'delegate', subject) : null;
    if (candidate == null) outcome = { result: 'new_person', why: 'no login, and dedupe has no person for it' };
    else if (await personHasLogin(worker, candidate)) {
      outcome = {
        result: 'stop',
        reason: 'other_login',
        dedupe_person_id: candidate,
        masked: await maskedLoginOf(worker, candidate),
        why: `dedupe files it under person ${candidate}, who already signs in with another login; the person is asked to sign in with that one, or choose "This isn't me"`
      };
    } else {
      personId = candidate;
      outcome = { result: 'adopt', person_id: candidate, why: `no login; dedupe files it under person ${candidate}, whom nobody signs in as yet. The login would carry self-join roles only` };
    }
  }
  out.outcome = outcome;
  if (personId != null && roleIds.length) {
    const row = rSub && outcome.why?.startsWith('the Delegate') ? rSub : rEmail || rSub;
    out.roles_at_level_3 = await loginRoleIds({
      worker,
      session: { personId, domainUnid: row?.type === 'delegate' ? subject : undefined, email, level: 3 },
      roleIds
    });
  }
  return out;
}

/** `signin link`: add a login to a person (granted), or move an existing one there. */
export async function linkLogin({ worker, email, subject, personId, audit, actor }) {
  const pid = Number(personId);
  if (!Number.isInteger(pid)) throw new Error('signin link requires --person <person_id>');
  const { data } = await worker.query({ sql: 'select id from person where id=?', values: [pid] });
  if (!data.length) throw new Error(`No person ${pid} in this database.`);
  const { type, value } = target({ email, subject });
  const before = await loginRow(worker, type, value);
  await putLogin(worker, { type, value, personId: pid, how: 'granted', state: 'active' });
  await auditLogin(worker, audit, 'login.link', { type, value_hash: loginHash(value), from_person_id: before?.person_id ?? null, person_id: pid, ...(actor || {}) });
  return { type, person_id: pid, from_person_id: before?.person_id ?? null, how: 'granted', state: 'active' };
}

async function setState({ worker, email, subject, personId, state, action, audit, actor, how }) {
  let rows;
  if (personId != null && !email && !subject) rows = await loginsOfPerson(worker, Number(personId));
  else {
    const { type, value } = target({ email, subject });
    const row = await loginRow(worker, type, value);
    rows = row ? [row] : [];
  }
  if (!rows.length) throw new Error('No login matches. e9core signin list shows a person\'s logins.');
  for (const row of rows) {
    await worker.query({
      sql: `update ${LOGIN_TABLE} set state=?${how ? ', how=?' : ''} where type=? and value_hash=?`,
      values: [state, ...(how ? [how] : []), row.type, row.value_hash]
    });
  }
  await auditLogin(worker, audit, action, {
    logins: rows.map((r) => ({ type: r.type, value_hash: r.value_hash, person_id: r.person_id })),
    ...(actor || {})
  });
  return { state, logins: rows.map((r) => ({ type: r.type, person_id: r.person_id })) };
}

/** `signin lock`: the login signs nobody in and keeps its person closed (passwd -l). */
export const lockLogin = (opts) => setState({ ...opts, state: 'locked', action: 'login.lock' });
/** `signin unlock`: the login signs in again, as a grant (passwd -u). */
export const unlockLogin = (opts) => setState({ ...opts, state: 'active', how: 'granted', action: 'login.unlock' });
/** `signin retire`: offboarding (userdel). A new account with a retired address gets a new person. */
export const retireLogin = (opts) => setState({ ...opts, state: 'retired', action: 'login.retire' });

/**
 * Add a sign-in address yourself: a signed-in session proves a second
 * Delegate token, and both of its logins go on the session's person. Needs
 * both accounts at once, so it cannot take someone else's login.
 */
export async function addSignInAddress({ worker, session, identity, audit }) {
  const current = await loginForSession(worker, session);
  if (!current || current.state !== 'active' || current.person_id !== Number(session.personId)) {
    return { refused: 'no_session_login', error: 'Sign in again before adding an address.' };
  }
  if (identityLevel(identity) < LOGIN_MIN_LEVEL) return { refused: 'level', error: 'The new account must confirm its address.' };
  const email = identity.email ? String(identity.email).trim().toLowerCase() : null;
  for (const [type, value] of [['delegate', identity.subject], ['email', email]]) {
    if (!value) continue;
    const row = await loginRow(worker, type, value);
    if (row && row.person_id !== current.person_id) {
      return { refused: 'login_belongs_to_another_account', error: 'That address already signs in to another account here.' };
    }
  }
  await putLogin(worker, { type: 'delegate', value: identity.subject, personId: current.person_id, how: current.how });
  if (email) await putLogin(worker, { type: 'email', value: email, personId: current.person_id, how: current.how, subject: identity.subject });
  await auditLogin(worker, audit, 'login.add_address', {
    person_id: current.person_id,
    subject_hash: loginHash(identity.subject).slice(0, 16),
    ...(email ? { email_hash: loginHash(email).slice(0, 16) } : {})
  });
  return { ok: true, person_id: current.person_id, added: email ? ['delegate', 'email'] : ['delegate'] };
}

export default {
  LOGIN_TABLE,
  LOGIN_PLUGIN_PATH,
  loginHash,
  maskEmail,
  loginMode,
  loginTableReady,
  signInOffError,
  forgetLoginTable,
  loginRow,
  loginsOfPerson,
  personForSignIn,
  loginForSession,
  loginRoleIds,
  loginRoleIdsForEmail,
  personForGrant,
  personForLoginEmail,
  maskedLoginOf,
  listLogins,
  explainLogin,
  linkLogin,
  lockLogin,
  unlockLogin,
  retireLogin,
  addSignInAddress
};
