/*
  Test helper: put an account in the layout from before @engine9/schemas/person_name:
  names are columns on person, no person_name plugin or table, and the person
  plugin's inbound snapshot still weaves upsertPerson.
*/
const LEGACY_PERSON_SNAPSHOT = { inbound: { normalize: ['normalizeFieldNames'], upsert: ['upsertPerson'] } };
const LIMITED_PII_PLUGIN_PATH = '@engine9/schemas/utilities/limited-pii';

export async function enableExcludePii(worker) {
  await worker.install({ path: LIMITED_PII_PLUGIN_PATH, unique: true });
  const { data } = await worker.query({
    sql: 'select id from plugin where path=? limit 1',
    values: [LIMITED_PII_PLUGIN_PATH]
  });
  await worker.setSetting({ pluginId: data[0].id, name: 'exclude_pii', value: true });
}

export async function makeLegacyPersonNames(
  worker,
  { stack = '@engine9/schemas/stacks/standard', excludePii = false } = {}
) {
  await worker.installDefaultPlugins({ path: stack });
  if (excludePii) await enableExcludePii(worker);
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
