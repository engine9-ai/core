/*
  Inbound people pipeline weaver: the chain is built from installed plugins.
  Standard stack must equal the historical hardcoded chain; limited-pii must
  contain no plaintext contact plugin; guards fail loudly instead of skipping.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { describeInboundTransforms, normalizeInboundSpec } from '../lib/peoplePipeline/getInboundTransforms.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';

const I = '@engine9/interfaces';
const LIMITED_PII = `${I}/stacks/limited-pii`;

function newWorker() {
  return new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
}
const paths = (steps) => steps.map((s) => s.path);

test('standard stack weave equals the historical hardcoded chain', async () => {
  const worker = newWorker();
  try {
    await applyStandardStack(worker);
    const steps = await worker.getInboundTransforms({ pluginId: 'p1' });
    assert.deepEqual(paths(steps), [
      `${I}/person:transforms:normalizeFieldNames`,
      `${I}/person_email:transforms:extractEmailHashes`,
      `${I}/person_phone:transforms:extractPhoneHashes`,
      `${I}/person_remote:transforms:extractRemotePersonIds`,
      'person.extractDelegateIdentifiers',
      'person.appendInputId',
      'person.appendPersonId',
      'person.appendEntryTypeId',
      'person.validateSourceCodeAscii',
      'person.appendSourceCodeId',
      `${I}/person:transforms:upsertPerson`,
      `${I}/person_address:transforms:upsertPersonAddress`,
      `${I}/person_email:transforms:upsertPersonEmail`,
      `${I}/person_phone:transforms:upsertPersonPhone`,
      `${I}/person_remote:transforms:upsertPersonRemote`
    ]);
    // person_remote upsert bindings need the plugin id
    const remoteUpsert = steps.find((s) => s.path === `${I}/person_remote:transforms:upsertPersonRemote`);
    assert.equal(remoteUpsert.options.pluginId, 'p1');
    assert.ok(steps.every((s) => s.slot && s.source), 'every step is labeled with slot and source');

    const described = await worker.getInboundTransforms({ pluginId: 'p1', describe: true });
    assert.equal(described, describeInboundTransforms(steps));
    assert.match(described, /^normalize woven {2}@engine9\/interfaces\/person:transforms:normalizeFieldNames$/m);
    assert.match(described, /^assign {4}core {3}person\.appendPersonId$/m);

    const identifyOnly = await worker.getInboundTransforms({ doNotUpsert: true });
    assert.ok(!identifyOnly.some((s) => s.slot === 'upsert'), 'doNotUpsert drops the upsert slot');
  } finally {
    await worker.destroy();
  }
});

test('limited-pii stack weaves person_hash and no plaintext contact plugin', async () => {
  const worker = newWorker();
  try {
    await worker.installStandard({ path: LIMITED_PII });
    const pluginId = getPluginUUID('engine9.test', 'pii-free-site');
    await ensurePluginRow(worker, { id: pluginId, path: 'pii-free-site', name: 'PII free site' });

    const described = await worker.getInboundTransforms({ pluginId, describe: true });
    assert.doesNotMatch(described, /person_email|person_phone|person_address/, described);
    assert.match(described, /^id {8}woven {2}@engine9\/interfaces\/person_hash:transforms:extractContactHashes$/m);
    assert.match(described, /^upsert {4}woven {2}@engine9\/interfaces\/person_hash:transforms:upsertPersonHash$/m);

    const summary = await worker.processPeople({
      pluginId,
      remoteInputId: 'signup',
      inputType: 'api',
      batch: [{ email: 'Someone@Example.com', phone: '202-555-0143', given_name: 'Some' }]
    });
    assert.equal(summary.recordsWithPersonIds, 1);
    const { data: hashes } = await worker.query('select person_id, email_hash_v1 from person_hash_email');
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0].person_id, summary.personIds[0]);
    const { tables } = await worker.tables();
    assert.ok(!tables.includes('person_email') && !tables.includes('person_phone'), 'no plaintext tables exist');
  } finally {
    await worker.destroy();
  }
});

test('omitTransforms drops a woven step for one job; extraTransforms append by slot', async () => {
  const worker = newWorker();
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'omit-site');
    await ensurePluginRow(worker, { id: pluginId, path: 'omit-site', name: 'Omit site' });
    const emailUpsert = `${I}/person_email:transforms:upsertPersonEmail`;

    const steps = await worker.getInboundTransforms({
      pluginId,
      omitTransforms: [emailUpsert],
      extraTransforms: { afterAll: [{ path: 'custom.afterAll' }], id: 'custom.id' }
    });
    assert.ok(!paths(steps).includes(emailUpsert));
    const idSlot = steps.filter((s) => s.slot === 'id');
    assert.equal(idSlot.at(-1).path, 'custom.id', 'extras run after woven steps in the same slot');
    assert.equal(idSlot.at(-1).source, 'extra');
    assert.equal(steps.at(-1).path, 'custom.afterAll');

    await worker.processPeople({
      pluginId,
      remoteInputId: 'signup',
      inputType: 'api',
      omitTransforms: emailUpsert,
      batch: [{ email: 'skip@example.com', given_name: 'Skip' }]
    });
    const { data: emails } = await worker.query('select * from person_email');
    assert.equal(emails.length, 0, 'omitted upsert wrote nothing');
    const { data: people } = await worker.query('select given_name from person');
    assert.equal(people[0].given_name, 'Skip', 'other upserts still ran');

    await assert.rejects(
      worker.getInboundTransforms({ pluginId, extraTransforms: { beforeIdentity: 'x' } }),
      /slot 'beforeIdentity' is not allowed/
    );
  } finally {
    await worker.destroy();
  }
});

test('guards: no inbound plugins installed fails loudly', async () => {
  const worker = newWorker();
  try {
    await worker.deploy({ schema: `${I}/plugin` });
    await ensurePluginRow(worker, { path: 'some-bot', name: 'Bot only' });
    await assert.rejects(worker.getInboundTransforms({ doNotUpsert: true }), /No inbound people plugins are installed/);
  } finally {
    await worker.destroy();
  }
});

test('normalizeInboundSpec validates slots and transform keys', () => {
  assert.equal(normalizeInboundSpec(undefined), null);
  assert.deepEqual(normalizeInboundSpec({ id: 'id', upsert: ['upsert'] }), { id: ['id'], upsert: ['upsert'] });
  assert.throws(() => normalizeInboundSpec({ beforeUpsert: ['upsert'] }), /slot 'beforeUpsert' is not allowed/);
  assert.throws(
    () => normalizeInboundSpec({ id: ['nope'] }, { path: 'p', transforms: { id: {} } }),
    /names transform 'nope' which is not exported/
  );
  assert.throws(
    () => normalizeInboundSpec({ id: ['upsert'] }, { path: 'p', transforms: { upsert: { type: 'upsert' } } }),
    /declares type 'upsert' but is listed in slot 'id'/
  );
});
