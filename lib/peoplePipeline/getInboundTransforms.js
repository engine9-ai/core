/*
  Inbound people pipeline weaver.

  The chain is woven from the plugins installed in the account (the `plugin`
  table), not from a list in core. Each people plugin declares
  `metadata.inbound = { <slot>: [<transform export key>, ...] }` and core places
  those transforms in the matching slot. Core owns only the `assign` phase.

    beforeAll -> normalize -> id -> assign -> upsert -> afterAll

  Every step carries { path, options, slot, source } where source is
  'woven' (installed plugin), 'core' (PersonWorker method) or 'extra'
  (caller extraTransforms). describeInboundTransforms() prints that.

  Plugin-author guide: ./README.md
*/
import JSON5 from 'json5';
import { getStringArray } from '../utilities.js';

/** Slots a plugin may declare in metadata.inbound */
export const PLUGIN_INBOUND_SLOTS = ['normalize', 'id', 'upsert'];
/** Slots a caller may append to via extraTransforms */
export const EXTRA_TRANSFORM_SLOTS = ['beforeAll', 'normalize', 'id', 'upsert', 'afterAll'];
/** Full slot order, including the core-only `assign` phase */
export const INBOUND_SLOTS = ['beforeAll', 'normalize', 'id', 'assign', 'upsert', 'afterAll'];

const PERSON_CUSTOM_PATH = '@engine9/interfaces/person_custom';

/**
 * Validate and normalize a plugin's metadata.inbound.
 * When `transforms` is supplied (install time) every key must exist, and a
 * transform that declares `type` ('id' | 'upsert') must sit in that slot.
 */
export function normalizeInboundSpec(inbound, { path = 'plugin', transforms } = {}) {
  if (inbound == null) return null;
  if (typeof inbound !== 'object' || Array.isArray(inbound)) {
    throw new Error(`${path}: metadata.inbound must be an object of { slot: [transformKey] }`);
  }
  const spec = {};
  for (const [slot, value] of Object.entries(inbound)) {
    if (!PLUGIN_INBOUND_SLOTS.includes(slot)) {
      throw new Error(
        `${path}: metadata.inbound slot '${slot}' is not allowed. Use one of ${PLUGIN_INBOUND_SLOTS.join(', ')}`
      );
    }
    const keys = typeof value === 'string' ? getStringArray(value) : value;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k)) {
      throw new Error(`${path}: metadata.inbound.${slot} must be an array of transform export keys`);
    }
    if (transforms) {
      for (const key of keys) {
        const t = transforms[key];
        if (!t) {
          throw new Error(
            `${path}: metadata.inbound.${slot} names transform '${key}' which is not exported (have ${Object.keys(transforms).join(', ')})`
          );
        }
        if ((slot === 'id' || slot === 'upsert') && t.type && t.type !== slot) {
          throw new Error(`${path}: transform '${key}' declares type '${t.type}' but is listed in slot '${slot}'`);
        }
      }
    }
    if (keys.length) spec[slot] = [...keys];
  }
  return Object.keys(spec).length ? spec : null;
}

function parseJsonColumn(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Inbound spec snapshot written to plugin.transforms at install, if any */
function inboundFromRow(row) {
  const transforms = parseJsonColumn(row.transforms);
  return transforms?.inbound ? normalizeInboundSpec(transforms.inbound, { path: row.path }) : null;
}

/*
  Rows installed before snapshots existed have no plugin.transforms. Fall back to
  the package metadata when this runtime can load it (Node core / server). The
  result is cached per worker; a path that cannot be compiled is not a people
  plugin (bots, stacks) and is skipped.
*/
async function inboundFromPackage(worker, path) {
  if (typeof worker.compilePlugin !== 'function') return null;
  worker._inboundSpecCache = worker._inboundSpecCache || new Map();
  const cache = worker._inboundSpecCache;
  if (cache.has(path)) return cache.get(path);
  let spec = null;
  try {
    const compiled = await worker.compilePlugin({ path });
    spec = normalizeInboundSpec(compiled?.metadata?.inbound, { path, transforms: compiled?.transforms });
  } catch {
    spec = null;
  }
  cache.set(path, spec);
  return spec;
}

/**
 * Installed plugins that take part in the inbound pipeline.
 * Returns { pluginTable, plugins: [{ id, path, tablePrefix, schema, inbound }] }
 */
export async function loadInboundPlugins(worker, { knownPluginPaths = [] } = {}) {
  try {
    await worker.describe({ table: 'plugin' });
  } catch (e) {
    if (e?.code !== 'DOES_NOT_EXIST') throw e;
    // No plugin table: dev/test only (upserts need plugin rows anyway).
    // Treat every package this runtime knows how to run as installed.
    const plugins = [];
    for (const path of knownPluginPaths) {
      const inbound = await inboundFromPackage(worker, path);
      if (inbound) plugins.push({ id: null, path, tablePrefix: '', schema: null, inbound });
    }
    return { pluginTable: false, plugins };
  }
  // `schema` is reserved in MySQL (synonym for DATABASE); select * avoids quoting it.
  const { data: rows } = await worker.query('select * from plugin');
  const plugins = [];
  for (const row of rows) {
    const inbound = inboundFromRow(row) || (await inboundFromPackage(worker, row.path));
    if (!inbound) {
      if (knownPluginPaths.includes(row.path)) {
        throw new Error(
          `Plugin ${row.path} is installed but has no inbound snapshot and its package could not be loaded. Re-run install (installStandard) to refresh plugin.transforms.`
        );
      }
      continue;
    }
    plugins.push({
      id: row.id,
      path: row.path,
      tablePrefix: row.table_prefix ?? '',
      schema: parseJsonColumn(row.schema),
      inbound
    });
  }
  if (!plugins.length) {
    throw new Error(
      'No inbound people plugins are installed (plugin table has no rows with metadata.inbound). Run installStandard for this account.'
    );
  }
  return { pluginTable: true, plugins };
}

/*
  person_custom is installed once per custom field table (table_prefix). Its
  upsert needs the live column list, so one declared step becomes one step per
  row. The only path-specific code in the weaver.
*/
async function expandStep(worker, plugin, step) {
  if (plugin.path !== PERSON_CUSTOM_PATH || step.slot !== 'upsert') return [step];
  const table = `${plugin.tablePrefix}field`;
  try {
    const desc = await worker.describe({ table });
    return [{ ...step, options: { ...step.options, table, schema: plugin.schema, columns: desc.columns } }];
  } catch {
    return []; // table not deployed yet
  }
}

function parseExtraTransforms(options) {
  const extra = Object.fromEntries(EXTRA_TRANSFORM_SLOTS.map((slot) => [slot, []]));
  if (!options.extraTransforms) return extra;
  let o = options.extraTransforms;
  if (typeof o === 'string') o = JSON5.parse(o);
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('extraTransforms must be an object keyed by slot');
  for (const [slot, value] of Object.entries(o)) {
    if (!extra[slot]) {
      throw new Error(
        `extraTransforms slot '${slot}' is not allowed. Use one of ${EXTRA_TRANSFORM_SLOTS.join(', ')}`
      );
    }
    let arr = value;
    if (typeof arr === 'string') arr = getStringArray(arr).map((path) => ({ path, options: {} }));
    if (!Array.isArray(arr)) arr = [arr];
    arr.forEach((t) => {
      if (!t?.path) throw new Error(`extraTransforms.${slot} entries need a path`);
      extra[slot].push({ path: t.path, options: t.options || {}, slot, source: 'extra' });
    });
  }
  return extra;
}

function parseOmit(options) {
  let o = options.omitTransforms;
  if (!o) return new Set();
  if (typeof o === 'string') o = o.trim().startsWith('[') ? JSON5.parse(o) : getStringArray(o);
  if (!Array.isArray(o)) throw new Error('omitTransforms must be an array of transform paths');
  return new Set(o);
}

/**
 * Weave the inbound person transform chain for this account.
 *
 * options: pluginId, defaultInputId, remoteInputId, defaultEntryType, doNotUpsert,
 *          appendSourceCodeId, defaultSourceCode, sourceTable, inputType, inputMetadata,
 *          extraTransforms { slot: [{ path, options }] }, omitTransforms [path]
 * config:  beforeIdentityTransforms — core-only id steps (e.g. delegate ids)
 *          knownPluginPaths — packages this runtime can execute (fail-open without a plugin table)
 */
export async function buildInboundTransforms(worker, options = {}, config = {}) {
  const { beforeIdentityTransforms = [], knownPluginPaths = [] } = config;
  const {
    pluginId,
    defaultInputId,
    remoteInputId,
    defaultEntryType,
    doNotUpsert = false,
    appendSourceCodeId = true,
    defaultSourceCode,
    inputType,
    inputMetadata
  } = options;
  if (!pluginId && !doNotUpsert) {
    throw new Error('pluginId is required for transforms -- you can use doNotUpsert for an append');
  }
  const extra = parseExtraTransforms(options);
  const omit = parseOmit(options);

  const { plugins } = await loadInboundPlugins(worker, { knownPluginPaths });
  const woven = Object.fromEntries(PLUGIN_INBOUND_SLOTS.map((slot) => [slot, []]));
  for (const plugin of [...plugins].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const slot of PLUGIN_INBOUND_SLOTS) {
      for (const key of plugin.inbound[slot] || []) {
        const step = {
          path: `${plugin.path}:transforms:${key}`,
          options: slot === 'upsert' ? { pluginId } : {},
          slot,
          source: 'woven'
        };
        woven[slot].push(...(await expandStep(worker, plugin, step)));
      }
    }
  }

  const core = (path, opts = {}, slot = 'assign') => ({ path, options: opts, slot, source: 'core' });
  const steps = [
    ...extra.beforeAll,
    ...woven.normalize,
    ...extra.normalize,
    ...woven.id,
    ...beforeIdentityTransforms.map((t) => core(t.path, t.options || {}, 'id')),
    ...extra.id,
    core('person.appendInputId', {
      pluginId,
      defaultInputId,
      remoteInputId,
      doNotUpsert,
      inputType: inputType ?? options.input_type,
      inputMetadata: inputMetadata ?? options.input_metadata
    }),
    core('person.appendPersonId', { doNotUpsert }),
    core('person.appendEntryTypeId', { defaultEntryType })
  ];
  if (appendSourceCodeId) {
    const validateOpts = { table: 'source_code_dictionary' };
    if (options.sourceTable) validateOpts.sourceTable = options.sourceTable;
    steps.push(core('person.validateSourceCodeAscii', validateOpts));
    steps.push(core('person.appendSourceCodeId', { defaultSourceCode, doNotUpsert }));
  }
  if (!doNotUpsert) {
    steps.push(...woven.upsert, ...extra.upsert);
  }
  steps.push(...extra.afterAll);

  // Extras that repeat a woven path (e.g. legacy person_hash extraTransforms) run once.
  const wovenPaths = new Set(steps.filter((s) => s.source === 'woven').map((s) => s.path));
  return steps.filter((s) => !omit.has(s.path) && !(s.source === 'extra' && wovenPaths.has(s.path)));
}

/** One line per step: slot, source, path (and table for expanded steps). */
export function describeInboundTransforms(steps = []) {
  return steps
    .map((s) => {
      const table = s.options?.table ? ` table=${s.options.table}` : '';
      return `${(s.slot || '-').padEnd(9)} ${(s.source || '-').padEnd(6)} ${s.path}${table}`;
    })
    .join('\n');
}
