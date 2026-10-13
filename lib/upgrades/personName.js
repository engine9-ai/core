/*
  Upgrade: person.given_name / person.family_name -> @engine9/schemas/person_name.

  Names are PII, so they moved off `person` (which every account installs) into
  their own schema plugin that PII-free accounts leave out. This copies the
  names into person_name, refreshes the person plugin's inbound snapshot (it
  still names the old upsertPerson step), and drops both columns from person.

  Uses only worker.query / describe / install, so it runs on every connection
  core supports: a D1 binding inside a Cloudflare Worker (POST /admin/upgrade),
  sqlite:// and mysql:// from `e9core upgrade --db`, and the server's workers.
  Each step checks the database first, so a re-run finishes a partial upgrade.
*/
import { bool } from '../utilities.js';
import { readCorePluginSettings } from '../corePluginSettings.js';

export const PERSON_PATH = '@engine9/schemas/person';
export const PERSON_NAME_PATH = '@engine9/schemas/person_name';
const NAME_COLUMNS = ['given_name', 'family_name'];
const COPY_CHUNK = 50000;

async function describePerson(worker) {
  try {
    return await worker.describe({ table: 'person' });
  } catch (e) {
    if (e?.code === 'DOES_NOT_EXIST') return null;
    throw e;
  }
}

function hasName(worker, columns, alias) {
  return `(${columns.map((c) => `coalesce(${alias}.${worker.escapeColumn(c)},'') <> ''`).join(' or ')})`;
}

async function count(worker, sql) {
  const { data } = await worker.query(sql);
  return Number(data[0]?.n || 0);
}

/* PII-free: exclude_pii is set, or an installed stack excludes person_name. */
async function isPiiFree(worker) {
  const { exclude_pii: excludePii } = await readCorePluginSettings(worker);
  if (excludePii) return true;
  const { excludes } = await worker.aggregatedExcludes();
  return excludes.includes(PERSON_NAME_PATH);
}

async function copyNames(worker, columns, personColumns) {
  const { data } = await worker.query('select min(id) as lo, max(id) as hi from person');
  if (data[0]?.lo == null) return 0;
  const lo = Number(data[0].lo);
  const hi = Number(data[0].hi);
  const timestamps = ['created_at', 'modified_at'].filter((c) => personColumns.includes(c));
  const target = ['person_id', ...columns, ...timestamps].map((c) => worker.escapeColumn(c)).join(', ');
  const source = ['id', ...columns, ...timestamps].map((c) => `p.${worker.escapeColumn(c)}`).join(', ');
  let copied = 0;
  // D1 limits how long one statement may run; copy in id ranges.
  for (let start = lo - 1; start < hi; start += COPY_CHUNK) {
    const r = await worker.query({
      sql: `insert into person_name (${target})
        select ${source} from person p
        where p.id > ? and p.id <= ? and ${hasName(worker, columns, 'p')}
        and not exists (select 1 from person_name n where n.person_id = p.id)`,
      values: [start, start + COPY_CHUNK]
    });
    copied += Number(r.records || 0);
  }
  return copied;
}

/**
 * options: dryRun (report the plan, change nothing), discardNames (a PII-free
 * account with names on person drops them without copying).
 */
export async function upgradePersonName(worker, options = {}) {
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const discardNames = bool(options.discardNames ?? options.discard_names, false);
  const desc = await describePerson(worker);
  if (!desc) return { pending: false, changed: false, skipped: 'no person table' };
  const personColumns = desc.columns.map((c) => c.name);
  const columns = NAME_COLUMNS.filter((c) => personColumns.includes(c));
  const piiFree = await isPiiFree(worker);
  const installed = (await worker.list()).some((row) => row.path === PERSON_NAME_PATH);
  const peopleWithNames = columns.length
    ? await count(worker, `select count(*) as n from person p where ${hasName(worker, columns, 'p')}`)
    : 0;

  const plan = [];
  if (!piiFree) plan.push(installed ? `reinstall ${PERSON_NAME_PATH}` : `install ${PERSON_NAME_PATH}`);
  if (!piiFree && peopleWithNames) plan.push(`copy names for ${peopleWithNames} people into person_name`);
  if (piiFree && peopleWithNames) plan.push(`discard names for ${peopleWithNames} people (PII-free account)`);
  plan.push(`refresh the ${PERSON_PATH} inbound snapshot`);
  columns.forEach((c) => plan.push(`drop person.${c}`));

  const blocked =
    piiFree && peopleWithNames && !discardNames
      ? `This account is PII-free, so ${PERSON_NAME_PATH} is not installed and names have nowhere to go. ${peopleWithNames} people have a name on person. Re-run with discard_names to drop those columns without copying.`
      : null;
  const pending = columns.length > 0 || (!piiFree && !installed);
  const result = {
    pending,
    pii_free: piiFree,
    person_name_installed: installed,
    person_columns: columns,
    people_with_names: peopleWithNames,
    plan: pending ? plan : []
  };
  if (dryRun) return { ...result, dry_run: true, ...(blocked ? { blocked } : {}) };
  if (blocked) throw new Error(blocked);
  if (!pending) return { ...result, changed: false };

  let copied = 0;
  if (!piiFree) {
    await worker.install({ path: PERSON_NAME_PATH, unique: true });
    if (columns.length) {
      copied = await copyNames(worker, columns, personColumns);
      const missing = await count(
        worker,
        `select count(*) as n from person p where ${hasName(worker, columns, 'p')}
          and not exists (select 1 from person_name n where n.person_id = p.id)`
      );
      if (missing) throw new Error(`${missing} people still have a name on person that is not in person_name. Nothing was dropped.`);
    }
  }
  // Before the drop: the old snapshot weaves upsertPerson, which writes these columns.
  await worker.install({ path: PERSON_PATH, unique: true });
  for (const column of columns) {
    await worker.query(`alter table person drop column ${worker.escapeColumn(column)}`);
  }
  return { ...result, changed: true, copied, dropped: columns.map((c) => `person.${c}`) };
}

export default {
  id: 'person_name',
  since: '1.10.1',
  description: 'Move person.given_name / family_name into person_name, then drop them from person.',
  run: upgradePersonName
};
