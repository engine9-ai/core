import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { getPluginUUID } from '../lib/utilities.js';

test('client PersonWorker: processPeople runs the inbound pipeline end to end', async () => {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await worker.installStandard();
    const pluginId = getPluginUUID('engine9.test', 'test-web-plugin');
    await worker.install({ type: 'local', id: pluginId, path: 'test-web-plugin', name: 'Test Web Plugin' });

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

    const { data: identifiers } = await worker.query('select id_type, person_id from person_identifier order by person_id');
    assert.ok(identifiers.find((i) => i.id_type === 'email_hash_v1' && i.person_id === aliceId));
    assert.ok(identifiers.find((i) => i.id_type === 'phone_hash_v1' && i.person_id === aliceId));

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
