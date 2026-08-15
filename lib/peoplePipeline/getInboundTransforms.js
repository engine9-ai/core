import JSON5 from 'json5';
import { getStringArray } from '../utilities.js';

/** Caller-facing extraTransforms slots. Named after pipeline phases, not plugins. */
const EXTRA_TRANSFORM_SLOTS = ['beforeAll', 'beforeIdentity', 'beforeUpsert', 'afterAll'];

/**
 * Append person_custom field upserts when that interface is installed.
 * Shared by core processPeople and server loadPeople.
 */
export async function extendWithPersonCustomUpserts(worker, transforms) {
  let customPlugins = [];
  try {
    ({ data: customPlugins } = await worker.query(
      "select * from plugin where path='@engine9/interfaces/person_custom'"
    ));
  } catch {
    return transforms;
  }
  if (!customPlugins.length) return transforms;
  for (const plugin of customPlugins) {
    const table = `${plugin.table_prefix}field`;
    try {
      const desc = await worker.describe({ table });
      transforms.push({
        path: '@engine9/interfaces/person_custom:transforms:upsert',
        options: { table, schema: plugin.schema, columns: desc.columns }
      });
    } catch {
      // table may not exist
    }
  }
  return transforms;
}

function parseExtraTransforms(options) {
  const extraTransforms = Object.fromEntries(EXTRA_TRANSFORM_SLOTS.map((key) => [key, []]));
  if (!options.extraTransforms) return extraTransforms;
  let o = options.extraTransforms;
  if (typeof o === 'string') o = JSON5.parse(o);
  if (typeof o !== 'object') throw new Error('extraTransforms must be an object');
  if (Array.isArray(o)) throw new Error('extraTransforms must be an object, not an array');
  Object.entries(o).forEach(([key, transforms]) => {
    if (!extraTransforms[key]) {
      throw new Error(
        `The attribute ${key} is not an allowed extraTransforms attribute.  Please use one of ${Object.keys(extraTransforms).join(',')}`
      );
    }
    let arr = transforms;
    if (typeof arr === 'string') arr = getStringArray(arr).map((path) => ({ path, options: {} }));
    if (!Array.isArray(arr)) arr = [arr];
    extraTransforms[key].push(...arr);
  });
  return extraTransforms;
}

/**
 * Shared inbound person transform chain for server loadPeople and client processPeople.
 *
 * Optional plugins (e.g. person_hash) must not be listed here. They declare
 * `metadata.inbound` slots and are passed in via extraTransforms / config hooks:
 *   beforeIdentity — after standard *:id extracts, before person_id assignment
 *   beforeUpsert   — after person_id assignment, before standard table upserts
 *
 * @param {object} worker
 * @param {object} options
 * @param {{
 *   interfacePathPrefix?: string,
 *   beforeIdentityTransforms?: object[],
 *   extendBeforeUpserts?: (worker: object, transforms: object[], options: object) => Promise<object[]>|object[]
 * }} [config]
 */
export async function buildInboundTransforms(worker, options = {}, config = {}) {
  const {
    interfacePathPrefix = '@engine9/interfaces',
    beforeIdentityTransforms = [],
    extendBeforeUpserts = async (w, transforms) => transforms
  } = config;
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
  const extraTransforms = parseExtraTransforms(options);
  const p = interfacePathPrefix;
  let transforms = extraTransforms.beforeAll.concat([
    { path: `${p}/person:transforms:normalizeFieldNames`, options: {} },
    { path: `${p}/person_remote:transforms:id`, options: {} },
    { path: `${p}/person_email:transforms:id`, options: {} },
    { path: `${p}/person_phone:transforms:id`, options: {} },
    ...beforeIdentityTransforms,
    ...extraTransforms.beforeIdentity,
    {
      path: 'person.appendInputId',
      options: {
        pluginId,
        defaultInputId,
        remoteInputId,
        doNotUpsert,
        inputType: inputType ?? options.input_type,
        inputMetadata: inputMetadata ?? options.input_metadata
      }
    },
    { path: 'person.appendPersonId', options: { doNotUpsert } },
    { path: 'person.appendEntryTypeId', options: { defaultEntryType } }
  ]);
  if (appendSourceCodeId) {
    const validateSourceCodeOpts = { table: 'source_code_dictionary' };
    if (options.sourceTable) validateSourceCodeOpts.sourceTable = options.sourceTable;
    transforms.push({ path: 'person.validateSourceCodeAscii', options: validateSourceCodeOpts });
    transforms.push({ path: 'person.appendSourceCodeId', options: { defaultSourceCode, doNotUpsert } });
  }
  if (doNotUpsert) {
    return transforms.concat(extraTransforms.afterAll);
  }
  transforms = await extendBeforeUpserts(worker, transforms, options);
  transforms = transforms.concat(extraTransforms.beforeUpsert).concat([
    { path: `${p}/person:transforms:upsert`, options: {} },
    { path: `${p}/person_remote:transforms:upsert`, options: { pluginId } },
    { path: `${p}/person_email:transforms:upsert`, options: {} },
    { path: `${p}/person_phone:transforms:upsert`, options: {} },
    { path: `${p}/person_address:transforms:upsert`, options: {} }
  ]);
  return transforms.concat(extraTransforms.afterAll);
}

export { EXTRA_TRANSFORM_SLOTS };
