import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';
import { applyStandardStack, applyInterface, ensurePluginRow } from './helpers/applySchemas.js';

test('client PersonWorker: processPeople runs the inbound pipeline end to end', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'test-web-plugin');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-web-plugin', name: 'Test Web Plugin' });

    const summary = await worker.processPeople({
      pluginId,
      remoteInputId: 'signup-form',
      inputType: 'api',
      batch: [
        {
          email: 'Alice@Example.com',
          given_name: 'Alice',
          family_name: 'Anderson',
          phone: '202-555-0143',
          source_code: 'WEB_SIGNUP'
        },
        { email: 'bob@example.com', given_name: 'Bob', family_name: 'Baker' }
      ]
    });
    assert.equal(summary.records, 2);
    assert.equal(summary.recordsWithPersonIds, 2);
    const [aliceId, bobId] = summary.personIds;
    assert.ok(aliceId && bobId && aliceId !== bobId, 'both records got distinct person_ids');

    // SQLite defaults to compact person_id_<id_type> tables (not person_identifier)
    const { data: emailIds } = await worker.query(
      'select person_id from person_id_email_hash_v1 order by person_id'
    );
    const { data: phoneIds } = await worker.query(
      'select person_id from person_id_phone_hash_v1 order by person_id'
    );
    assert.ok(emailIds.find((i) => i.person_id === aliceId));
    assert.ok(phoneIds.find((i) => i.person_id === aliceId));
    const { data: legacyIds } = await worker.query('select * from person_identifier');
    assert.equal(legacyIds.length, 0);

    const { data: emails } = await worker.query('select person_id, email, subscription_status from person_email order by person_id');
    assert.equal(emails.length, 2);
    assert.equal(emails[0].email, 'Alice@Example.com');
    assert.equal(emails[0].subscription_status, 'Subscribed');

    const { data: people } = await worker.query('select id, given_name, family_name from person order by id');
    assert.equal(people.length, 2);
    assert.equal(people.find((p) => p.id === aliceId).given_name, 'Alice');

    const { data: sc } = await worker.query("select source_code_id, source_code from source_code_dictionary where source_code='WEB_SIGNUP'");
    assert.equal(sc.length, 1);

    // Re-submit Alice with an update -- should dedupe to the same person_id
    const second = await worker.processPeople({
      pluginId,
      remoteInputId: 'signup-form',
      inputType: 'api',
      batch: [{ email: 'alice@example.com', given_name: 'Alicia', family_name: 'Anderson' }]
    });
    assert.equal(second.personIds[0], aliceId, 'dedupes by email hash to the same person');
    const { data: people2 } = await worker.query('select id, given_name from person');
    assert.equal(people2.length, 2, 'no new person row created');
    assert.equal(people2.find((p) => p.id === aliceId).given_name, 'Alicia', 'name updated');

    // doNotUpsert: identifies without modification
    const readOnly = await worker.processPeople({
      doNotUpsert: true,
      batch: [{ email: 'alice@example.com' }, { email: 'unknown@example.com' }]
    });
    assert.equal(readOnly.personIds[0], aliceId);
    assert.equal(readOnly.personIds[1], null, 'unknown person not created with doNotUpsert');
    const { data: people3 } = await worker.query('select id from person');
    assert.equal(people3.length, 2, 'doNotUpsert added no people');
  } finally {
    await worker.destroy();
  }
});

test('person_hash is opt-in via extraTransforms slots after explicit install', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const { tables: before } = await worker.tables();
    assert.ok(!before.includes('person_hash_email'), 'person_hash must not be in the standard stack');

    const first = await applyInterface(worker, '@engine9/interfaces/person_hash');
    const second = await applyInterface(worker, '@engine9/interfaces/person_hash');
    assert.equal(second.id, first.id, 'person_hash plugin row is unique by path');
    const { data: pluginRows } = await worker.query(
      "select id from plugin where path='@engine9/interfaces/person_hash'"
    );
    assert.equal(pluginRows.length, 1);

    const pluginId = getPluginUUID('engine9.test', 'test-hash-plugin');
    await ensurePluginRow(worker, { id: pluginId, path: 'test-hash-plugin', name: 'Test Hash Plugin' });
    const prefix = '@engine9/interfaces';
    const summary = await worker.processPeople({
      pluginId,
      remoteInputId: 'hash-signup',
      inputType: 'api',
      extraTransforms: {
        beforeIdentity: [{ path: `${prefix}/person_hash:transforms:id` }],
        beforeUpsert: [{ path: `${prefix}/person_hash:transforms:upsert` }]
      },
      batch: [
        { email: 'Hash@Example.com', phone: '202-555-0143' },
        { email_hash_v1: createHash('sha256').update('only-hash@example.com').digest('hex') }
      ]
    });
    assert.equal(summary.records, 2);
    const [plainId, hashOnlyId] = summary.personIds;
    const { data: emailHashes } = await worker.query(
      'select person_id, email_hash_v1, email_hash_md5 from person_hash_email order by person_id'
    );
    assert.equal(emailHashes.length, 2);
    const plainHash = emailHashes.find((r) => r.person_id === plainId);
    assert.equal(plainHash.email_hash_v1.length, 64);
    assert.equal(plainHash.email_hash_md5.length, 32);
    const hashOnly = emailHashes.find((r) => r.person_id === hashOnlyId);
    assert.equal(hashOnly.email_hash_v1.length, 64);
    const { data: hashOnlyEmails } = await worker.query(
      `select email from person_email where person_id=${hashOnlyId}`
    );
    assert.equal(hashOnlyEmails.length, 0, 'hash-only import must not write person_email');
    const { data: phoneHashes } = await worker.query('select person_id from person_hash_phone');
    assert.equal(phoneHashes.length, 1);
    assert.equal(phoneHashes[0].person_id, plainId);
  } finally {
    await worker.destroy();
  }
});
