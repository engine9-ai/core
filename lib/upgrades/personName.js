/*
  Upgrades: person.given_name / person.family_name -> @engine9/schemas/person_name.

  Names are PII, so they moved off `person` (which every account installs) into
  their own schema plugin that PII-free accounts leave out.

  person_name (every run): install person_name, copy the names into it, and
  refresh the person plugin's inbound snapshot (it still names the old
  upsertPerson step), so new loads write person_name. The person columns stay;
  code that still reads them sees the names as of the upgrade.

  person_name_columns (opt-in, drop_name_columns): drop both columns from
  person once nothing reads them. A PII-free account has nowhere to copy its
  names to, so dropping them there also needs discard_names.

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

function countUncopied(worker, columns) {
  return count(
    worker,
    `select count(*) as n from person p where ${hasName(worker, columns, 'p')}
      and not exists (select 1 from person_name n where n.person_id = p.id)`
  );
}

async function inspect(worker) {
  const desc = await describePerson(worker);
  if (!desc) return null;
  const personColumns = desc.columns.map((c) => c.name);
  const columns = NAME_COLUMNS.filter((c) => personColumns.includes(c));
  const plugins = await worker.list();
  const installed = plugins.some((row) => row.path === PERSON_NAME_PATH);
  const personInstalled = plugins.some((row) => row.path === PERSON_PATH);
  const piiFree = await isPiiFree(worker);
  const peopleWithNames = columns.length
    ? await count(worker, `select count(*) as n from person p where ${hasName(worker, columns, 'p')}`)
    : 0;
  let uncopied = 0;
  if (!piiFree && peopleWithNames) uncopied = installed ? await countUncopied(worker, columns) : peopleWithNames;
  const personIsView = columns.length > 0 && (await worker.tableType?.({ table: 'person' })) === 'view';
  return { personColumns, columns, installed, personInstalled, piiFree, peopleWithNames, uncopied, personIsView };
}

function report(state) {
  return {
    pii_free: state.piiFree,
    ...(state.personIsView ? { person_is_view: true } : {}),
    ...(state.personInstalled ? {} : { person_plugin_installed: false }),
    person_name_installed: state.installed,
    person_columns: state.columns,
    people_with_names: state.peopleWithNames
  };
}

const VIEW_BLOCKED = 'person is a view over an older table. Replace the view with a person table, then re-run.';

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

/** options: dryRun (report the plan, change nothing). */
export async function upgradePersonName(worker, options = {}) {
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const state = await inspect(worker);
  if (!state) return { pending: false, changed: false, skipped: 'no person table' };
  const { piiFree, installed, uncopied } = state;

  const pending = !piiFree && (!installed || uncopied > 0);
  let blocked = null;
  if (pending && state.personIsView) blocked = VIEW_BLOCKED;
  else if (pending && !state.personInstalled) {
    blocked = `The person table exists but the ${PERSON_PATH} plugin is not installed, so ${PERSON_NAME_PATH} cannot be installed. Install the account's stack (or ${PERSON_PATH}), then re-run.`;
  }
  const plan = [];
  if (pending) {
    plan.push(installed ? `reinstall ${PERSON_NAME_PATH}` : `install ${PERSON_NAME_PATH}`);
    if (uncopied) plan.push(`copy names for ${uncopied} people into person_name`);
    plan.push(`refresh the ${PERSON_PATH} inbound snapshot`);
  }
  const result = { pending, ...report(state), plan };
  if (dryRun) return { ...result, dry_run: true, ...(blocked ? { blocked } : {}) };
  if (blocked) throw new Error(blocked);
  if (!pending) return { ...result, changed: false };

  await worker.install({ path: PERSON_NAME_PATH, unique: true });
  let copied = 0;
  if (state.columns.length) {
    copied = await copyNames(worker, state.columns, state.personColumns);
    const missing = await countUncopied(worker, state.columns);
    if (missing) throw new Error(`${missing} people still have a name on person that is not in person_name.`);
  }
  // The old snapshot weaves upsertPerson, which writes the person columns.
  await worker.install({ path: PERSON_PATH, unique: true });
  return { ...result, changed: true, copied };
}

/**
 * options: dryRun, discardNames (a PII-free account with names on person
 * drops them without copying).
 */
export async function dropPersonNameColumns(worker, options = {}) {
  const dryRun = bool(options.dryRun ?? options.dry_run, false);
  const discardNames = bool(options.discardNames ?? options.discard_names, false);
  const state = await inspect(worker);
  if (!state) return { pending: false, changed: false, skipped: 'no person table' };
  const { columns, piiFree, peopleWithNames } = state;

  const pending = columns.length > 0;
  let blocked = null;
  if (pending && state.personIsView) blocked = VIEW_BLOCKED;
  else if (pending && piiFree && peopleWithNames && !discardNames) {
    blocked = `This account is PII-free, so ${PERSON_NAME_PATH} is not installed and names have nowhere to go. ${peopleWithNames} people have a name on person. Re-run with discard_names to drop those columns without copying.`;
  } else if (pending && !piiFree && (!state.installed || state.uncopied)) {
    blocked = `${state.uncopied} people have a name on person that is not in person_name yet. Run the person_name upgrade first.`;
  }
  const plan = [];
  if (pending) {
    if (piiFree && peopleWithNames) plan.push(`discard names for ${peopleWithNames} people (PII-free account)`);
    plan.push(`refresh the ${PERSON_PATH} inbound snapshot`);
    columns.forEach((c) => plan.push(`drop person.${c}`));
  }
  const result = { pending, ...report(state), plan };
  if (dryRun) return { ...result, dry_run: true, ...(blocked ? { blocked } : {}) };
  if (blocked) throw new Error(blocked);
  if (!pending) return { ...result, changed: false };

  // Before the drop: the old snapshot weaves upsertPerson, which writes these columns.
  await worker.install({ path: PERSON_PATH, unique: true });
  for (const column of columns) {
    await worker.query(`alter table person drop column ${worker.escapeColumn(column)}`);
  }
  return { ...result, changed: true, dropped: columns.map((c) => `person.${c}`) };
}

export default {
  id: 'person_name',
  since: '1.10.1',
  description: 'Copy person.given_name / family_name into person_name. The person columns stay.',
  run: upgradePersonName
};

export const dropNameColumns = {
  id: 'person_name_columns',
  since: '1.10.1',
  optIn: 'drop_name_columns',
  description: 'Drop person.given_name / family_name once nothing reads them (opt-in: drop_name_columns).',
  run: dropPersonNameColumns
};
