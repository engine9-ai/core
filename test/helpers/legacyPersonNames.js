/*
  Test helper: put an account in the layout from before @engine9/schemas/person_name:
  names are columns on person, no person_name plugin or table, and the person
  plugin's inbound snapshot still weaves upsertPerson.
*/
const LEGACY_PERSON_SNAPSHOT = { inbound: { normalize: ['normalizeFieldNames'], upsert: ['upsertPerson'] } };

export async function makeLegacyPersonNames(worker, { stack = '@engine9/schemas/stacks/standard' } = {}) {
  await worker.installDefaultPlugins({ path: stack });
  await worker.query('alter table person add column given_name varchar(255)');
  await worker.query('alter table person add column family_name varchar(255)');
  await worker.query("delete from plugin where path='@engine9/schemas/person_name'");
  await worker.drop({ table: 'person_name' });
  await worker.query({
    sql: 'update plugin set transforms=? where path=?',
    values: [JSON.stringify(LEGACY_PERSON_SNAPSHOT), '@engine9/schemas/person']
  });
}

export async function personColumns(worker) {
  const { columns } = await worker.describe({ table: 'person' });
  return columns.map((c) => c.name);
}
