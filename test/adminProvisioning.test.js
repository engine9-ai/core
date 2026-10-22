import { test } from 'node:test';
import assert from 'node:assert';
import PersonWorker from '../lib/PersonWorker.js';
import { applyStandardStack } from './helpers/applySchemas.js';
import {
  ROLE_NAMES,
  addPeopleToSegment,
  ensureRoleSegment,
  listSegmentMembers,
  normalizeEmail,
  roleSegmentId,
  rolesForEmail,
  rolesPluginId
} from '../auth/roles.js';

// The recipe in docs/admin-provisioning.md, run against a database with no
// site plugin (an account that core never deployed, like a server account).
async function provisionAdmins({ worker, accountId, emails }) {
  await ensureRoleSegment({ worker, accountId, name: ROLE_NAMES.ADMIN, description: 'Administrative access to this account' });
  return addPeopleToSegment({
    worker,
    pluginId: rolesPluginId(accountId),
    segmentId: roleSegmentId(accountId, ROLE_NAMES.ADMIN),
    emails
  });
}

test('admin provisioning: creates the role, the people and the membership, and is safe to repeat', async () => {
  const accountId = 'acme';
  const worker = new PersonWorker({ accountId, auth: { database_connection: 'sqlite://:memory:' } });
  try {
    await applyStandardStack(worker);
    const roleId = roleSegmentId(accountId, ROLE_NAMES.ADMIN);

    const listed = ['  Owner@Example.com ', 'sam@example.com', 'not an email', 'OWNER@example.com'];
    const emails = [...new Set(listed.map(normalizeEmail).filter(Boolean))];
    assert.deepEqual(emails, ['owner@example.com', 'sam@example.com'], 'invalid dropped, case and padding folded');
    await assert.rejects(provisionAdmins({ worker, accountId, emails: ['not an email'] }), /Not an email address/);

    const first = await provisionAdmins({ worker, accountId, emails });
    assert.equal(first.added.length, 2);
    assert.deepEqual(await rolesForEmail({ worker, email: 'owner@example.com', roleIds: [roleId] }), [roleId]);
    assert.deepEqual(await rolesForEmail({ worker, email: 'nobody@example.com', roleIds: [roleId] }), []);

    const again = await provisionAdmins({ worker, accountId, emails });
    assert.deepEqual(again.added, [], 'a second run changes nothing');
    assert.deepEqual(again.personIds, first.personIds, 'and resolves the same people');

    const members = await listSegmentMembers({ worker, segmentId: roleId });
    assert.deepEqual(members.flatMap((m) => m.emails).sort(), ['owner@example.com', 'sam@example.com']);
  } finally {
    await worker.destroy();
  }
});
