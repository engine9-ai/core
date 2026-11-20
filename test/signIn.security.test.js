/*
  Sign-in security: the escalation suite for person_login (auth/logins.js).

  Every case drives the real code: personForSignIn, loginRoleIds,
  personForGrant, the admin actions, the person_login backfill from
  @engine9/schemas, and the public-row filing of POST /people
  (api/publicRows.js). Attacks first poison dedupe through the raw people
  pipeline, as a public form could before the input patch, so the login
  table is tested on its own.

  Invariants (internal audit plan): I1 a login carries a non-self-join role
  only if an admin named it; I2 a first sign-in never lands on a record found
  by its address or Domain UNID (only a login, or a new person);
  I3 two Delegate accounts never share a person unless an admin linked them
  or one added the other; I4 an account keeps its person; I8 a stop carries
  no person_id and no full address; I10 a token below Level 2 is refused and
  writes nothing, and a session below Level 2 holds no role.

  The randomized runs use fixed seeds; FUZZ_OPS changes their length.
*/
import { test, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import PersonWorker from '../lib/PersonWorker.js';
import { ensureRoleSegments, roleSegmentId } from '../auth/roles.js';
import { getPluginUUID, getVersionedUUID } from '../lib/utilities.js';
import { createDefaultIdentifierStore } from '../lib/id/index.js';
import { applyWebsitePlugins, ensurePluginRow } from '../test/helpers/applySchemas.js';

const workers = [];
after(async () => { for (const w of workers) await w.destroy?.(); });

const DOMAIN = 'site.example.com';
const ADMIN = 'has-access@example.com';
const INVADER = 'invader@example.com';
const VICTIM = 'victim@example.com';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (e) => String(e).trim().toLowerCase();
const emailHash = (e) => sha(norm(e));
const subFor = (email, n = 0) => `${DOMAIN}:${sha(`${norm(email)}#${n}`).slice(0, 24)}`;

import {
  personForSignIn,
  loginRow,
  loginsOfPerson,
  loginRoleIds,
  loginRoleIdsForEmail,
  personForGrant,
  linkLogin,
  retireLogin,
  unlockLogin,
  addSignInAddress as addSignInAddressReal
} from '../auth/logins.js';
import { filterPublicRows } from '../api/publicRows.js';
import { backfillPersonLogin } from '@engine9/schemas/login/upgrades.js';

/* ---------------- adapters over the real code ---------------- */
const rowOf = (w, type, value) => loginRow(w, type, value);
const rowsOfPerson = (w, pid) => loginsOfPerson(w, Number(pid));

async function graphByEmail(w, email) {
  const store = await createDefaultIdentifierStore(w);
  const rows = await store.findByIdentifiers([{ id_type: 'email_hash_v1', id_value: emailHash(email) }]);
  return rows[0] ? Number(rows[0].person_id) : null;
}

const FOUND_BY = { granted_email: 'granted-email', retired_address: 'retired-address' };

/** Sign in with a token { email?, sub, mergedFrom?, level }. A stop is { stop }. */
async function signIn(ctx, tok) {
  const level = tok.level ?? 3;
  try {
    const r = await personForSignIn({
      worker: ctx.worker,
      pluginId: ctx.pluginId,
      identity: { subject: tok.sub, mergedFrom: tok.mergedFrom, email: tok.email, level }
    });
    return {
      personId: r.personId,
      foundBy: FOUND_BY[r.foundBy] || r.foundBy,
      session: { personId: r.personId, sub: tok.sub, domainUnid: tok.sub, email: tok.email, level }
    };
  } catch (e) {
    if (!e.loginStop && e.reason !== 'level_too_low') throw e;
    return { stop: e.reason };
  }
}

async function rolesForSession(ctx, session) {
  if (!session) return [];
  const ids = await loginRoleIds({
    worker: ctx.worker,
    session: { ...session, domainUnid: session.domainUnid ?? session.sub, level: session.level ?? 3 },
    roleIds: ctx.roleIds
  });
  return ids.sort();
}
async function rolesForEmail(ctx, email) {
  return (await loginRoleIdsForEmail({ worker: ctx.worker, email, roleIds: ctx.roleIds })).sort();
}

async function grant(ctx, email, segmentId) {
  const g = await personForGrant({ worker: ctx.worker, pluginId: ctx.pluginId, email });
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: g.personId, segment_id: segmentId }] });
  return { personId: g.personId, note: g.note };
}
const link = (ctx, { email, subject }, personId) => linkLogin({ worker: ctx.worker, email, subject, personId });
const retirePerson = (ctx, personId) => retireLogin({ worker: ctx.worker, personId });
const unlockRow = (ctx, { email, subject }) => unlockLogin({ worker: ctx.worker, email, subject });

async function addSignInAddress(ctx, session, tok) {
  const roles0 = await rolesForSession(ctx, session);
  const r = await addSignInAddressReal({
    worker: ctx.worker,
    session: { ...session, domainUnid: session.domainUnid ?? session.sub },
    identity: { subject: tok.sub, email: tok.email, level: tok.level ?? 3 }
  });
  return r.ok ? { ok: true, roles0 } : { refused: r.refused };
}

/** The person_login upgrade from @engine9/schemas, run again over the existing table. */
async function backfill(ctx, { extraSegments = [] } = {}) {
  const r = await backfillPersonLogin({ sqlWorker: ctx.worker, options: { role_segments: extraSegments }, dryRun: false });
  return { written: r.written || 0, noAddress: r.no_address, conflicts: r.conflicts.map((c) => c.email || c.email_hash_v1) };
}

/* I8: a stop never carries a person_id or a full address. */
function assertStopLeaksNothing(r, ...addresses) {
  assert.equal(r.personId, undefined);
  assert.equal(r.session, undefined);
  for (const a of addresses) assert.ok(!JSON.stringify(r).includes(norm(a)), `stop leaks ${a}`);
}

/* ---------------- harness ---------------- */
async function setup() {
  const worker = new PersonWorker({ accountId: 'acct', auth: { database_connection: 'sqlite://:memory:' } });
  workers.push(worker);
  await applyWebsitePlugins(worker);
  const pluginId = getPluginUUID('acct', 'website');
  await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
  await ensureRoleSegments({ worker, accountId: 'acct' });
  const admin = roleSegmentId(worker.accountHandle, 'admin');
  const member = getVersionedUUID();
  await worker.insertArray({ table: 'segment', array: [{ id: member, plugin_id: pluginId, name: 'Member', build_type: 'manual', join_min_level: 1, leave_min_level: 1 }] });
  const ctx = { worker, pluginId, admin, member, roleIds: [admin, member].sort(), delegate: new Map() };
  ctx.tok = (email, { n = 0, verified = true, mergedFrom, level = 3, sub } = {}) => {
    const s = sub || subFor(email, n);
    ctx.delegate.set(s, email);
    return { email: verified ? email : undefined, sub: s, mergedFrom, level };
  };
  /* A public row through the raw pipeline (what POST /people did before the input patch): poisons dedupe. */
  ctx.publicPost = async (people, options) =>
    (await worker.processPeople({ pluginId, remoteInputId: options?.remoteInputId || 'website', inputType: 'api', batch: people })).personIds;
  ctx.trustedImport = async (people) =>
    (await worker.processPeople({ pluginId, remoteInputId: 'crm', inputType: 'api', batch: people })).personIds;
  /* Sign-in before this release: the Domain UNID through the pipeline (no verified email). */
  ctx.legacySignIn = async (tok) =>
    (await worker.processPeople({ pluginId, remoteInputId: 'delegate', inputType: 'api', batch: [tok.email ? { email: tok.email } : { delegate_id: tok.sub }] })).personIds[0];
  /* The input filter (api/publicRows.js), then the pipeline, as POST /people runs them for a public key. */
  ctx.patchedPost = async (rows, session = null) => {
    const filtered = filterPublicRows(rows, { session });
    const warnings = filtered.warnings.map((w) => `ignored:${w.field}`);
    const summary = await worker.processPeople({ pluginId, remoteInputId: 'website', inputType: 'api', batch: filtered.rows });
    return { warnings, personIds: summary.personIds };
  };
  return ctx;
}
const none = [];

/* ================= attacks, unpatched POST, sign-in table alone ================= */
for (const [name, importRow, plant] of [
  ['A person_id', { email: ADMIN }, (pid) => ({ email: INVADER, person_id: pid })],
  ['B phone', { email: ADMIN, phone: '202-555-0143' }, () => ({ email: INVADER, phone: '(202) 555-0143' })],
  ['C remote id', { email: ADMIN, remote_person_id: `${getPluginUUID('acct', 'crm')}.1001` }, () => ({ email: INVADER, remote_person_id: `${getPluginUUID('acct', 'crm')}.1001` })],
  ['G identifiers', { email: ADMIN }, () => ({ email: INVADER, identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: emailHash(ADMIN) }] })]
]) {
  test(`attack ${name}: a poisoned graph does not reach sign-in; the invader is a new person with no role`, async () => {
    const ctx = await setup();
    const [imported] = await ctx.trustedImport([importRow]);
    await link(ctx, { email: ADMIN }, imported);
    await grant(ctx, ADMIN, ctx.admin);
    await signIn(ctx, ctx.tok(ADMIN));
    await ctx.publicPost([plant(imported)]);
    assert.equal(await graphByEmail(ctx.worker, INVADER), imported, 'graph is poisoned');
    assert.deepEqual(await rolesForEmail(ctx, INVADER), none);
    const r = await signIn(ctx, ctx.tok(INVADER));
    assert.equal(r.stop, undefined, 'no stop, and nothing about the admin');
    assert.notEqual(r.personId, imported);
    assert.deepEqual(await rolesForSession(ctx, r.session), none);
    assert.deepEqual(await rolesForSession(ctx, (await signIn(ctx, ctx.tok(ADMIN))).session), [ctx.admin]);
  });
}

test('attack D: invader already signs in, then plants their address on the admin', async () => {
  const ctx = await setup();
  const { personId: adminPid } = await grant(ctx, ADMIN, ctx.admin);
  const mine = await signIn(ctx, ctx.tok(INVADER));
  await ctx.publicPost([{ email: INVADER, person_id: adminPid }]);
  const again = await signIn(ctx, ctx.tok(INVADER));
  assert.equal(again.personId, mine.personId);
  assert.deepEqual(await rolesForSession(ctx, again.session), none);
  assert.deepEqual(await rolesForEmail(ctx, INVADER), none);
});

test("attack E: pre-plant the future admin's address on the invader's own person", async () => {
  const ctx = await setup();
  const mine = await signIn(ctx, ctx.tok(INVADER));
  await ctx.publicPost([{ email: ADMIN, person_id: mine.personId }]);
  const g = await grant(ctx, ADMIN, ctx.admin);
  assert.notEqual(g.personId, mine.personId, 'a grant never lands on a record found by the address');
  assert.match(g.note, new RegExp(`also on person ${mine.personId}`), 'the note names it, for the admin to judge');
  assert.deepEqual(await rolesForSession(ctx, (await signIn(ctx, ctx.tok(INVADER))).session), none);
  const a = await signIn(ctx, ctx.tok(ADMIN));
  assert.equal(a.personId, g.personId);
  assert.deepEqual(await rolesForSession(ctx, a.session), [ctx.admin]);
});

test("attack E': pre-plant on a person nobody signs in as; the grant makes its own person, the invader gets nothing", async () => {
  const ctx = await setup();
  const [planted] = await ctx.publicPost([{ email: INVADER }]);
  await ctx.publicPost([{ email: ADMIN, person_id: planted }]);
  const g = await grant(ctx, ADMIN, ctx.admin);
  assert.notEqual(g.personId, planted);
  const r = await signIn(ctx, ctx.tok(INVADER));
  assert.equal(r.stop, undefined);
  assert.ok(![planted, g.personId].includes(r.personId), 'the invader is a new person');
  assert.deepEqual(await rolesForSession(ctx, r.session), none);
  const a = await signIn(ctx, ctx.tok(ADMIN));
  assert.equal(a.personId, g.personId);
  assert.deepEqual(await rolesForSession(ctx, a.session), [ctx.admin]);
});

test("attack: the victim's address planted on the invader's person cannot lock the victim out", async () => {
  const ctx = await setup();
  const inv = await signIn(ctx, ctx.tok(INVADER));
  await ctx.publicPost([{ email: VICTIM, person_id: inv.personId }]);
  const v = await signIn(ctx, ctx.tok(VICTIM));
  assert.equal(v.stop, undefined, 'no stop');
  assert.notEqual(v.personId, inv.personId, "the victim never lands on the invader's person");
  assert.equal((await signIn(ctx, ctx.tok(VICTIM))).personId, v.personId, 'and stays their own');
});

test('attack: a planted phone does not carry the invader into the victim\'s record, in either order', async () => {
  const ctx = await setup();
  const [victim] = await ctx.trustedImport([{ email: VICTIM, phone: '202-555-0199' }]);
  await ctx.publicPost([{ email: INVADER, phone: '202-555-0199' }]);
  assert.equal(await graphByEmail(ctx.worker, INVADER), victim, 'dedupe joined the address by phone');
  const inv = await signIn(ctx, ctx.tok(INVADER));
  assert.notEqual(inv.personId, victim, 'sign-in never finds a record by its address');
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: victim, segment_id: ctx.admin }] });
  assert.deepEqual(await rolesForSession(ctx, inv.session), none);
  // The other order: signed in first, then the plant.
  const ctx2 = await setup();
  const first = await signIn(ctx2, ctx2.tok(INVADER));
  const [victim2] = await ctx2.trustedImport([{ email: VICTIM, phone: '202-555-0199' }]);
  await ctx2.publicPost([{ email: INVADER, phone: '202-555-0199' }]);
  assert.equal((await signIn(ctx2, ctx2.tok(INVADER))).personId, first.personId);
  assert.notEqual(first.personId, victim2);
});

test('attack: reassigned address (new Delegate account, same email) stops at login_reassigned', async () => {
  const ctx = await setup();
  const { personId: adminPid } = await grant(ctx, ADMIN, ctx.admin);
  await signIn(ctx, ctx.tok(ADMIN));
  const newHire = ctx.tok(ADMIN, { n: 1 }); // org gave the address to someone else
  const r = await signIn(ctx, newHire);
  assert.equal(r.stop, 'login_reassigned');
  assert.deepEqual(await rolesForEmail(ctx, ADMIN), [ctx.admin], 'RESIDUAL: an email-only check (server) cannot tell; it must offboard');
  await retirePerson(ctx, adminPid); // offboarding
  assert.deepEqual(await rolesForEmail(ctx, ADMIN), none);
  const n = await signIn(ctx, newHire);
  assert.notEqual(n.personId, adminPid, 'the new hire gets a new person, not the old admin');
  assert.equal(n.foundBy, 'retired-address');
  assert.deepEqual(await rolesForSession(ctx, n.session), none);
  assert.equal((await signIn(ctx, ctx.tok(ADMIN))).stop, 'login_locked', 'the old account cannot come back on its own');
});

test('attack: deleting logins never hands the person to the next holder of the address (and strands its owner: why unlink retires)', async () => {
  const ctx = await setup();
  const g = await grant(ctx, ADMIN, ctx.admin);
  await signIn(ctx, ctx.tok(ADMIN));
  await ctx.worker.query({ sql: `delete from person_login where person_id=?`, values: [g.personId] });
  const n = await signIn(ctx, ctx.tok(ADMIN, { n: 1 }));
  assert.notEqual(n.personId, g.personId, 'a new person');
  assert.deepEqual(await rolesForSession(ctx, n.session), none);
});

test('use: an admin with several addresses from before the release (a herd of cats)', async () => {
  const ctx = await setup();
  const [adminPid] = await ctx.trustedImport([{ email: ADMIN }]);
  await ctx.worker.upsertArray({ table: 'person_email', array: [{ person_id: adminPid, email: 'admin@home.example' }] });
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: adminPid, segment_id: ctx.admin }] });
  const rep = await backfill(ctx);
  assert.equal(rep.conflicts.length, 0);
  for (const e of [ADMIN, 'admin@home.example']) {
    const r = await signIn(ctx, ctx.tok(e)); // two different Delegate accounts
    assert.equal(r.personId, adminPid, `${e} signs in as the admin`);
    assert.deepEqual(await rolesForSession(ctx, r.session), [ctx.admin]);
  }
});

test('use: an address two role holders share is a backfill conflict, left for an admin', async () => {
  const ctx = await setup();
  const [a] = await ctx.trustedImport([{ email: ADMIN }]);
  const [b] = await ctx.trustedImport([{ email: 'other-admin@example.com' }]);
  await ctx.worker.upsertArray({ table: 'person_email', array: [{ person_id: b, email: ADMIN }] });
  await ctx.worker.upsertArray({ table: 'person_segment', array: [a, b].map((person_id) => ({ person_id, segment_id: ctx.admin })) });
  const rep = await backfill(ctx);
  assert.deepEqual(rep.conflicts, [ADMIN]);
  assert.equal(await rowOf(ctx.worker, 'email', ADMIN), null);
  await link(ctx, { email: ADMIN }, a);
  assert.equal((await signIn(ctx, ctx.tok(ADMIN))).personId, a);
});

test('attack: self-service add-address cannot take a login that belongs to someone else', async () => {
  const ctx = await setup();
  await grant(ctx, ADMIN, ctx.admin);
  await signIn(ctx, ctx.tok(ADMIN));
  const inv = await signIn(ctx, ctx.tok(INVADER));
  // the invader cannot produce a token for ADMIN; the best they can do is replay their own
  const r = await addSignInAddress(ctx, inv.session, ctx.tok(ADMIN));
  assert.equal(r.refused, 'login_belongs_to_another_account', '(in reality Delegate would never issue it)');
});

/* ================= use cases ================= */
test('use: imported person: link the address, then grant; the first sign-in lands there (subject bound on first sign-in)', async () => {
  const ctx = await setup();
  const [pid] = await ctx.trustedImport([{ email: ADMIN, phone: '202-555-0143' }]);
  const plain = await setup();
  const [pid2] = await plain.trustedImport([{ email: ADMIN }]);
  const g2 = await grant(plain, ADMIN, plain.admin);
  assert.notEqual(g2.personId, pid2, 'a grant alone makes its own person');
  assert.match(g2.note, new RegExp(`signin link --email ${ADMIN} --person ${pid2}`));

  await link(ctx, { email: ADMIN }, pid);
  assert.equal((await grant(ctx, ADMIN, ctx.admin)).personId, pid);
  const s = await signIn(ctx, ctx.tok(ADMIN));
  assert.equal(s.personId, pid);
  assert.deepEqual(await rolesForSession(ctx, s.session), [ctx.admin]);
  assert.equal((await rowOf(ctx.worker, 'delegate', s.session.sub)).how, 'granted');
});

test('use: admin changes their address inside the same Delegate account', async () => {
  const ctx = await setup();
  await grant(ctx, 'old@example.com', ctx.admin);
  const first = await signIn(ctx, ctx.tok('old@example.com'));
  const sameAccount = { email: 'new@example.com', sub: first.session.sub, level: 3 };
  ctx.delegate.set(first.session.sub, 'new@example.com');
  const s = await signIn(ctx, sameAccount);
  assert.equal(s.personId, first.personId);
  assert.deepEqual(await rolesForSession(ctx, s.session), [ctx.admin]);
  assert.deepEqual(await rolesForEmail(ctx, 'new@example.com'), [ctx.admin], 'the new address is a login now');
  assert.deepEqual(await rolesForEmail(ctx, 'old@example.com'), [ctx.admin], 'the old one stays a login until locked (lastlog shows it)');
});

test('use: admin moves to a new Delegate account and adds it from the old session', async () => {
  const ctx = await setup();
  await grant(ctx, 'old@example.com', ctx.admin);
  const old = await signIn(ctx, ctx.tok('old@example.com'));
  const fresh = ctx.tok('new@example.com');
  const r = await addSignInAddress(ctx, old.session, fresh);
  assert.ok(r.ok);
  const s = await signIn(ctx, fresh);
  assert.equal(s.personId, old.personId);
  assert.deepEqual(await rolesForSession(ctx, s.session), [ctx.admin]);
  await ctx.worker.query({ sql: `update person_login set state='retired' where type='email' and value_hash=?`, values: [emailHash('old@example.com')] });
  assert.deepEqual(await rolesForEmail(ctx, 'old@example.com'), none, 'old address retired');
  assert.deepEqual(await rolesForSession(ctx, (await signIn(ctx, fresh)).session), [ctx.admin], 'new one still works');
});

test('use: admin lost the old account; another admin links the new address', async () => {
  const ctx = await setup();
  const g = await grant(ctx, 'old@example.com', ctx.admin);
  await signIn(ctx, ctx.tok('old@example.com'));
  const fresh = await signIn(ctx, ctx.tok('new@example.com'));
  assert.notEqual(fresh.personId, g.personId, 'unknown address: a new, empty person');
  assert.deepEqual(await rolesForSession(ctx, fresh.session), none);
  await link(ctx, { subject: fresh.session.sub }, g.personId); // e9core signin link --subject (moves the row)
  await link(ctx, { email: 'new@example.com' }, g.personId);
  const s = await signIn(ctx, ctx.tok('new@example.com'));
  assert.equal(s.personId, g.personId);
  assert.deepEqual(await rolesForSession(ctx, s.session), [ctx.admin]);
});

test('use: work and personal address on one record: an admin links one, the person adds the other', async () => {
  const ctx = await setup();
  const crm = getPluginUUID('acct', 'crm');
  const [pid] = await ctx.trustedImport([{ email: 'pat@work.example', remote_person_id: `${crm}.7` }]);
  await ctx.trustedImport([{ email: 'pat@home.example', remote_person_id: `${crm}.7` }]);
  await link(ctx, { email: 'pat@work.example' }, pid);
  const work = await signIn(ctx, ctx.tok('pat@work.example'));
  assert.equal(work.personId, pid);
  assert.ok((await addSignInAddress(ctx, work.session, ctx.tok('pat@home.example'))).ok);
  assert.equal((await signIn(ctx, ctx.tok('pat@home.example'))).personId, pid);
});

test('use: household on one imported record: each partner signs in to a record of their own', async () => {
  const ctx = await setup();
  const crm = getPluginUUID('acct', 'crm');
  const [pid] = await ctx.trustedImport([{ email: 'john@example.com', remote_person_id: `${crm}.9` }]);
  await ctx.trustedImport([{ email: 'jane@example.com', remote_person_id: `${crm}.9` }]);
  const john = await signIn(ctx, ctx.tok('john@example.com'));
  const jane = await signIn(ctx, ctx.tok('jane@example.com'));
  assert.equal(jane.stop, undefined);
  assert.ok(![pid, john.personId].includes(jane.personId));
  assert.notEqual(john.personId, pid);
  assert.equal((await signIn(ctx, ctx.tok('jane@example.com'))).personId, jane.personId);
});

test('use: Facebook/Microsoft admin with no verified email, through the upgrade', async () => {
  const ctx = await setup();
  const fb = ctx.tok('fb@example.com', { verified: false });
  const pid = await ctx.legacySignIn(fb); // today: found by delegate_id
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: pid, segment_id: ctx.admin }] });
  const rep = await backfill(ctx);
  assert.deepEqual(rep.noAddress, [pid], 'listed under login.review');
  // No login: a new person, never the record a Domain UNID is filed under
  // (a people:write key can file one anywhere). The admin grants the role again.
  const s = await signIn(ctx, fb);
  assert.notEqual(s.personId, pid);
  assert.equal(s.foundBy, 'new');
  assert.deepEqual(await rolesForSession(ctx, s.session), none, 'no role until an admin grants it to the new record');
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: s.personId, segment_id: ctx.admin }] });
  const again = await signIn(ctx, fb);
  assert.equal(again.personId, s.personId);
  assert.deepEqual(await rolesForSession(ctx, again.session), [ctx.admin]);
});

test('use: Delegate merged two accounts (merged_from)', async () => {
  const ctx = await setup();
  const fb = ctx.tok('fb2@example.com', { verified: false });
  const first = await signIn(ctx, fb);
  const merged = { sub: subFor('merged'), mergedFrom: fb.sub, level: 3 };
  const s = await signIn(ctx, merged);
  assert.equal(s.personId, first.personId);
  assert.equal(s.foundBy, 'merged_from');
  assert.equal((await signIn(ctx, { sub: merged.sub, level: 3 })).personId, first.personId, 'the new subject has its own row now');
});

test('use: same Delegate account through Microsoft (unverified) after Google (verified)', async () => {
  const ctx = await setup();
  await grant(ctx, ADMIN, ctx.admin);
  const g = await signIn(ctx, ctx.tok(ADMIN));
  const ms = await signIn(ctx, { sub: g.session.sub, level: 3 });
  assert.equal(ms.personId, g.personId);
  assert.deepEqual(await rolesForSession(ctx, ms.session), [ctx.admin]);
});

test('use: typo in a grant; diagnosis and fix', async () => {
  const ctx = await setup();
  const typo = await grant(ctx, 'pta@example.com', ctx.admin);
  const real = await signIn(ctx, ctx.tok('pat@example.com'));
  assert.notEqual(real.personId, typo.personId);
  assert.deepEqual(await rolesForSession(ctx, real.session), none);
  await retirePerson(ctx, typo.personId);
  await ctx.worker.query({ sql: `delete from person_segment where person_id=?`, values: [typo.personId] });
  await grant(ctx, 'pat@example.com', ctx.admin);
  assert.deepEqual(await rolesForSession(ctx, (await signIn(ctx, ctx.tok('pat@example.com'))).session), [ctx.admin]);
});

const rowCount = async (ctx) => Number((await ctx.worker.query({ sql: 'select count(*) as n from person_login' })).data[0].n);
const personCount = async (ctx) => Number((await ctx.worker.query({ sql: 'select count(*) as n from person' })).data[0].n);

test('level: a session below Level 2 holds no role, not even a self-join one', async () => {
  const ctx = await setup();
  const s = await signIn(ctx, ctx.tok('pat@example.com', { level: 2 }));
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: s.personId, segment_id: ctx.member }] });
  assert.deepEqual(await rolesForSession(ctx, s.session), [ctx.member]);
  assert.deepEqual(await rolesForSession(ctx, { ...s.session, level: 1 }), none);
  assert.deepEqual(await rolesForSession(ctx, { ...s.session, level: 0 }), none);
});

test('level: Level 0 and Level 1 tokens are refused and write nothing', async () => {
  const ctx = await setup();
  await ctx.trustedImport([{ email: 'pat@example.com' }]);
  const t = ctx.tok('pat@example.com');
  const people = await personCount(ctx);
  assert.equal((await signIn(ctx, { sub: t.sub, level: 0 })).stop, 'level_too_low');
  assert.equal((await signIn(ctx, { ...t, level: 1 })).stop, 'level_too_low', 'even with a verified address (max_level=1)');
  assert.equal(await rowCount(ctx), 0);
  assert.equal(await personCount(ctx), people, 'no person, no Domain UNID filed');
  const real = await signIn(ctx, t);
  assert.ok(real.personId);
  assert.equal(await rowCount(ctx), 2);
});

test('level: an existing login below Level 2 is refused too', async () => {
  const ctx = await setup();
  const g = await grant(ctx, ADMIN, ctx.admin);
  const t = ctx.tok(ADMIN);
  assert.equal((await signIn(ctx, t)).personId, g.personId);
  const before = await rowCount(ctx);
  assert.equal((await signIn(ctx, { sub: t.sub, level: 1 })).stop, 'level_too_low');
  assert.equal(await rowCount(ctx), before);
  assert.deepEqual(await rolesForSession(ctx, { personId: g.personId, sub: t.sub, email: ADMIN, level: 1 }), none);
});

test('use: Microsoft (unverified) before Google (verified) for a granted admin', async () => {
  const ctx = await setup();
  const g = await grant(ctx, ADMIN, ctx.admin);
  const t = ctx.tok(ADMIN);
  const ms = await signIn(ctx, { sub: t.sub, level: 3 });
  assert.notEqual(ms.personId, g.personId, 'no verified address: a new, empty person');
  const google = await signIn(ctx, t);
  assert.equal(google.personId, g.personId, 'the granted address claims the subject');
  assert.equal(google.foundBy, 'granted-email');
  assert.deepEqual(await rolesForSession(ctx, google.session), [ctx.admin]);
  assert.equal((await signIn(ctx, { sub: t.sub, level: 3 })).personId, g.personId, 'Microsoft now reaches the admin too');
});

test('attack: a subject does not move when the granted address already has a subject, or the subject person holds a role', async () => {
  const ctx = await setup();
  const g = await grant(ctx, ADMIN, ctx.admin);
  await signIn(ctx, ctx.tok(ADMIN)); // the real admin binds their subject
  const other = ctx.tok(ADMIN, { n: 1 });
  const ms = await signIn(ctx, { sub: other.sub, level: 3 });
  const r = await signIn(ctx, other);
  assert.equal(r.personId, ms.personId, 'a second account with the address stays on its own person');
  assert.deepEqual(await rolesForSession(ctx, r.session), none);

  const ctx2 = await setup();
  const g2 = await grant(ctx2, ADMIN, ctx2.admin);
  const t2 = ctx2.tok(ADMIN);
  const ms2 = await signIn(ctx2, { sub: t2.sub, level: 3 });
  await ctx2.worker.upsertArray({ table: 'person_segment', array: [{ person_id: ms2.personId, segment_id: ctx2.member }] });
  assert.equal((await signIn(ctx2, t2)).personId, ms2.personId, 'a person who holds a role keeps its subject; an admin links');
  assert.notEqual(ms2.personId, g2.personId);
  void g;
});

test('use: a session from before the upgrade (no row) holds no roles', async () => {
  const ctx = await setup();
  const [pid] = await ctx.trustedImport([{ email: 'pat@example.com' }]);
  await ctx.worker.upsertArray({ table: 'person_segment', array: [{ person_id: pid, segment_id: ctx.member }] });
  assert.deepEqual(await rolesForSession(ctx, { personId: pid, sub: subFor('pat@example.com'), email: 'pat@example.com', level: 3 }), none);
});

test('use: erasing a person removes the logins; the next sign-in is a new person', async () => {
  const ctx = await setup();
  const s = await signIn(ctx, ctx.tok('pat@example.com'));
  await ctx.worker.query({ sql: `delete from person_login where person_id=?`, values: [s.personId] });
  await ctx.worker.query({ sql: `delete from person_email where person_id=?`, values: [s.personId] });
  await ctx.worker.query({ sql: `delete from person where id=?`, values: [s.personId] });
  const again = await signIn(ctx, ctx.tok('pat@example.com'));
  assert.ok(again.personId);
});

test('use: one Delegate User holds both addresses and signs in with the other one first; an admin links the account', async () => {
  const ctx = await setup();
  const g = await grant(ctx, 'pat@work.example', ctx.admin);
  const sub = subFor('pat'); // one Delegate User, two addresses
  const home = await signIn(ctx, { email: 'pat@home.example', sub, level: 3 });
  assert.notEqual(home.personId, g.personId, 'a new person: the address it used has no login');
  const picked = await signIn(ctx, { email: 'pat@work.example', sub, level: 3 });
  assert.equal(picked.personId, home.personId, 'subject first: the account stays on its person');
  assert.deepEqual(await rolesForSession(ctx, picked.session), none);
  await link(ctx, { subject: sub }, g.personId); // e9core signin link --subject
  const after = await signIn(ctx, { email: 'pat@work.example', sub, level: 3 });
  assert.equal(after.personId, g.personId);
  assert.deepEqual(await rolesForSession(ctx, after.session), [ctx.admin]);
});

/* ================= the input filter =================
   A pure filter of the fields that point a row at a record. Dedupe runs as
   always on everything else, phone included. What keeps a public write from
   raising anyone's roles is person_login, not the filter: the fuzz below
   posts unfiltered rows. */
test('filter: normal anonymous form for a known address updates that person and adds a phone', async () => {
  const ctx = await setup();
  const [pid] = await ctx.trustedImport([{ email: 'donor@example.com' }]);
  const r = await ctx.patchedPost([{ email: 'donor@example.com', given_name: 'Dana', phone: '202-555-0101' }]);
  assert.equal(r.personIds[0], pid);
  assert.deepEqual(r.warnings, []);
});

test('filter: a new address with a known phone joins that person, as dedupe always has', async () => {
  const ctx = await setup();
  const [pid] = await ctx.trustedImport([{ email: 'donor@example.com', phone: '202-555-0101' }]);
  const r = await ctx.patchedPost([{ email: 'donor.new@example.com', phone: '202-555-0101' }]);
  assert.equal(r.personIds[0], pid);
  assert.deepEqual(r.warnings, []);
});

test('filter: phone-only form (SMS signup) is filed by its own phone', async () => {
  const ctx = await setup();
  const [pid] = await ctx.trustedImport([{ email: 'donor@example.com', phone: '202-555-0101' }]);
  const r = await ctx.patchedPost([{ phone: '202-555-0101', given_name: 'Dana' }]);
  assert.equal(r.personIds[0], pid);
});

test('filter: signed-in profile form with its own person_id writes to the session person', async () => {
  const ctx = await setup();
  const s = await signIn(ctx, ctx.tok('pat@example.com'));
  const r = await ctx.patchedPost([{ person_id: s.personId, given_name: 'Pat', email: 'pat@example.com' }], s.session);
  assert.equal(r.personIds[0], s.personId);
  assert.deepEqual(r.warnings, []);
});

for (const [name, importRow, plant] of [
  ['A person_id', { email: ADMIN }, (pid) => ({ email: INVADER, person_id: pid })],
  ['C remote id', { email: ADMIN, remote_person_id: `${getPluginUUID('acct', 'crm')}.1001` }, () => ({ email: INVADER, remote_person_id: `${getPluginUUID('acct', 'crm')}.1001` })],
  ['G identifiers', { email: ADMIN }, () => ({ email: INVADER, identifiers: [{ path: 'person_email', type: 'email_hash_v1', value: emailHash(ADMIN) }] })]
]) {
  test(`filter: attack ${name} no longer poisons the graph`, async () => {
    const ctx = await setup();
    const [adminPid] = await ctx.trustedImport([importRow]);
    const r = await ctx.patchedPost([plant(adminPid)]);
    assert.notEqual(r.personIds[0], adminPid);
    assert.notEqual(await graphByEmail(ctx.worker, INVADER), adminPid);
    assert.ok(r.warnings.length > 0, `warned: ${r.warnings}`);
  });
}

test('filter: a phone on the admin record joins the graph, but sign-in never reaches it', async () => {
  const ctx = await setup();
  const [adminPid] = await ctx.trustedImport([{ email: ADMIN, phone: '202-555-0143' }]);
  await link(ctx, { email: ADMIN }, adminPid);
  await grant(ctx, ADMIN, ctx.admin);
  await signIn(ctx, ctx.tok(ADMIN));
  await ctx.patchedPost([{ email: INVADER, phone: '(202) 555-0143' }]);
  assert.equal(await graphByEmail(ctx.worker, INVADER), adminPid, 'dedupe joins by phone, as before');
  const r = await signIn(ctx, ctx.tok(INVADER));
  assert.equal(r.stop, undefined);
  assert.notEqual(r.personId, adminPid);
  assert.deepEqual(await rolesForSession(ctx, r.session), none);
  assert.deepEqual(await rolesForEmail(ctx, INVADER), none);
});

test("filter: the victim's address cannot be put on the invader's person", async () => {
  const ctx = await setup();
  const inv = await signIn(ctx, ctx.tok(INVADER));
  const r = await ctx.patchedPost([{ email: VICTIM, person_id: inv.personId }], inv.session);
  assert.deepEqual(r.warnings, ['ignored:person_id']);
  assert.notEqual(await graphByEmail(ctx.worker, VICTIM), inv.personId);
  const victim = await signIn(ctx, ctx.tok(VICTIM));
  assert.equal(victim.stop, undefined, 'the victim signs in normally');
});

test('closed: a planted phone no longer reaches a person nobody signs in as (the gap before every first sign-in was a new person)', async () => {
  const ctx = await setup();
  const [victim] = await ctx.trustedImport([{ email: VICTIM, phone: '202-555-0199' }]);
  await ctx.patchedPost([{ email: INVADER, phone: '202-555-0199' }]);
  const inv = await signIn(ctx, ctx.tok(INVADER));
  assert.notEqual(inv.personId, victim);
  const v = await signIn(ctx, ctx.tok(VICTIM));
  assert.equal(v.stop, undefined, 'and the owner is not locked out');
  assert.notEqual(v.personId, inv.personId);
});

/* ================= randomized invariants ================= */
function prng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
for (const seed of [1, 2, 3, 4, 5, 6]) {
  test(`fuzz seed ${seed}: no public write raises anyone's roles; no sign-in lands on an imported record; no two humans share a person; stops leak no address`, async () => {
    const ctx = await setup();
    const rnd = prng(seed);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const humans = ['h0', 'h1', 'h2', 'h3', 'h4'].map((h) => ({ email: `${h}@example.com`, verified: rnd() > 0.2 }));
    const phones = ['202-555-0001', '202-555-0002', '202-555-0003'];
    const crm = getPluginUUID('acct', 'crm');
    const granted = new Set();
    const personOf = new Map();
    const knownPids = new Set();
    const importedNew = new Set(); // people an import created
    const ops = [];
    const N = Number(process.env.FUZZ_OPS || 45);
    for (let i = 0; i < N; i++) {
      const op = pick(['public', 'public', 'public', 'signin', 'signin', 'grant', 'import']);
      const h = pick(humans);
      if (op === 'public') {
        const row = { email: pick([h.email, `${h.email},${pick(humans).email}`]) };
        const k = pick(['person_id', 'phone', 'remote', 'identifiers', 'none']);
        if (k === 'person_id' && knownPids.size) row.person_id = pick([...knownPids]);
        if (k === 'phone') row.phone = pick(phones);
        if (k === 'remote') row.remote_person_id = `${crm}.${Math.floor(rnd() * 3)}`;
        if (k === 'identifiers') row.identifiers = [{ path: 'person_email', type: 'email_hash_v1', value: emailHash(pick(humans).email) }];
        ops.push(['public', row]);
        (await ctx.publicPost([row])).forEach((p) => p && knownPids.add(p));
      } else if (op === 'import') {
        const row = { email: h.email, phone: pick(phones), remote_person_id: `${crm}.${Math.floor(rnd() * 3)}` };
        ops.push(['import', row]);
        (await ctx.trustedImport([row])).forEach((p) => {
          if (p && !knownPids.has(p)) importedNew.add(p);
          if (p) knownPids.add(p);
        });
      } else if (op === 'grant') {
        if (!h.verified) continue;
        ops.push(['grant', h.email]);
        const g = await grant(ctx, h.email, ctx.admin);
        granted.add(h.email);
        knownPids.add(g.personId);
      } else {
        const level = pick([0, 1, 2, 3, 3, 3]);
        const microsoft = h.verified && rnd() < 0.2; // same Delegate account, no verified address
        const t0 = ctx.tok(h.email, { verified: h.verified && !microsoft });
        const t = { ...t0, level };
        const rowsBefore = await rowCount(ctx);
        let r = await signIn(ctx, t);
        if (r.stop) assertStopLeaksNothing(r, ...humans.map((x) => x.email));
        ops.push(['signin', h.email, level, microsoft ? 'ms' : '', r.stop || r.personId]);
        if (level < 2) {
          assert.equal(r.stop, 'level_too_low', `a Level ${level} sign-in was not refused\n${JSON.stringify(ops)}`);
          assert.equal(await rowCount(ctx), rowsBefore, `a Level ${level} sign-in wrote a login\n${JSON.stringify(ops)}`);
        }
        if (r.stop) continue;
        knownPids.add(r.personId);
        const roles = await rolesForSession(ctx, r.session);
        if (roles.includes(ctx.admin)) assert.ok(granted.has(h.email) && level >= 2, `${h.email} is admin without a grant, or below Level 2\n${JSON.stringify(ops)}`);
        assert.ok(!importedNew.has(r.personId), `I2: ${h.email} signed in to a person an import created\n${JSON.stringify(ops)}`);
        if (personOf.has(h.email) && r.foundBy !== 'granted-email') assert.equal(r.personId, personOf.get(h.email), `${h.email} changed person\n${JSON.stringify(ops)}`);
        personOf.set(h.email, r.personId);
        for (const [other, pid] of personOf) if (other !== h.email) assert.notEqual(pid, r.personId, `${h.email} and ${other} share a person\n${JSON.stringify(ops)}`);
      }
    }
    if (process.env.FUZZ_STATS) {
      const c = {}; for (const o of ops) c[o[0]] = (c[o[0]] || 0) + 1;
      const admins = []; for (const [e, pid] of personOf) { const t = ctx.tok(e, { verified: humans.find((x) => x.email === e).verified }); const r = await signIn(ctx, t); if (!r.stop && (await rolesForSession(ctx, r.session)).includes(ctx.admin)) admins.push(e); }
      console.log('seed', seed, JSON.stringify(c), 'stops', ops.filter((o) => o[0] === 'signin' && typeof o[2] === 'string').length, 'admins', admins.length, 'granted', granted.size);
    }
  });
}
