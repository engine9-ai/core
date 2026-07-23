/*
  Engine9 client person worker.

  Runs the exact same inbound person pipeline as the server's loadPeople --
  identifier extraction, input resolution, person id assignment (deduplication),
  source code resolution, and table upserts -- but restructured for real-time
  web requests:

    - operates on a single in-memory batch (no node:stream pipeline), so it
      runs on Cloudflare Workers as well as node
    - interface transforms are resolved from a static registry (bundler
      friendly) instead of dynamic plugin compilation

  The interface transform modules themselves (person, person_email,
  person_phone, person_remote) are the same files the server uses, imported
  from @engine9/interfaces.
*/
import debug$0 from 'debug';
import JSON5 from 'json5';
import SchemaWorker from './SchemaWorker.js';
import {
  bool,
  relativeDate,
  getInputUUID,
  TIMELINE_ENTRY_TYPES,
  uuidIsValid
} from './utilities.js';
import { appendPersonId as appendPersonIdFromLib, assignPersonIds } from './id/index.js';
import { buildInboundTransforms } from './peoplePipeline/getInboundTransforms.js';
import { runPeopleBatchPipeline } from './peoplePipeline/runPeopleBatchPipeline.js';

import personNormalizeFieldNames from '@engine9/interfaces/person/transforms/inbound/normalize_field_names.js';
import personUpsert from '@engine9/interfaces/person/transforms/inbound/upsert_tables.js';
import personRemoteId from '@engine9/interfaces/person_remote/transforms/inbound/extract_identifiers.js';
import personRemoteUpsert from '@engine9/interfaces/person_remote/transforms/inbound/upsert_tables.js';
import personEmailId from '@engine9/interfaces/person_email/transforms/inbound/extract_identifiers.js';
import personEmailUpsert from '@engine9/interfaces/person_email/transforms/inbound/upsert_tables.js';
import personPhoneId from '@engine9/interfaces/person_phone/transforms/inbound/extract_identifiers.js';
import personPhoneUpsert from '@engine9/interfaces/person_phone/transforms/inbound/upsert_tables.js';
import personAddressNormalize from '@engine9/interfaces/person_address/transforms/inbound/normalize.js';
import personAddressUpsert from '@engine9/interfaces/person_address/transforms/inbound/upsert_tables.js';

const debug = debug$0('client:PersonWorker');

/* Static registry keyed by the same transform paths the server uses */
const TRANSFORM_REGISTRY = {
  '@engine9/interfaces/person:transforms:normalizeFieldNames': personNormalizeFieldNames,
  '@engine9/interfaces/person:transforms:upsert': personUpsert,
  '@engine9/interfaces/person_remote:transforms:id': personRemoteId,
  '@engine9/interfaces/person_remote:transforms:upsert': personRemoteUpsert,
  '@engine9/interfaces/person_email:transforms:id': personEmailId,
  '@engine9/interfaces/person_email:transforms:upsert': personEmailUpsert,
  '@engine9/interfaces/person_phone:transforms:id': personPhoneId,
  '@engine9/interfaces/person_phone:transforms:upsert': personPhoneUpsert,
  '@engine9/interfaces/person_address:transforms:normalize': personAddressNormalize,
  '@engine9/interfaces/person_address:transforms:upsert': personAddressUpsert
};

function Worker(config) {
  SchemaWorker.call(this, config);
}
Worker.prototype = Object.create(SchemaWorker.prototype);
Worker.prototype.constructor = Worker;

Worker.prototype.assignIdsBlocking = async function (opts) {
  return assignPersonIds({ worker: this, ...opts });
};

Worker.prototype.appendPersonId = async function ({ batch, inputId, options = {} }) {
  return appendPersonIdFromLib({ worker: this, batch, inputId, options });
};

/*
  Extract the delegate universal id (unid from the shared delegate auth
  service) as a "delegate" identifier, so delegate logins recognize/dedupe
  through the normal person identifier pipeline (person_id_delegate on
  SQLite/D1, person_identifier id_type 'delegate' on MySQL).
*/
Worker.prototype.extractDelegateIdentifiers = async function ({ batch }) {
  batch.forEach((o) => {
    o.identifiers = o.identifiers || [];
    const value = o.delegate_id;
    if (value != null && String(value).trim() !== '') {
      o.identifiers.push({
        path: 'person_delegate',
        type: 'delegate',
        value: String(value).trim().toLowerCase()
      });
    }
  });
};

/* The input id is either stored in the database, or generated and stored */
Worker.prototype.getInputId = async function (opts) {
  const { inputId, pluginId, remoteInputId, remoteInputName, inputType, inputMetadata = null } = opts;
  if (inputId) return inputId;
  if (!pluginId || !remoteInputId)
    throw new Error(
      `getInputId: pluginId and remoteInputId are both required to create an inputId, not specified in ${JSON5.stringify(opts)}`
    );
  const { data } = await this.query({
    sql: 'select * from input where plugin_id=? and remote_input_id=?',
    values: [pluginId, remoteInputId]
  });
  if (data.length > 0) {
    const row = data[0];
    if (row.input_type == null || String(row.input_type).trim() === '') {
      throw new Error(
        `Input row has null input_type: ${JSON5.stringify({
          id: row.id,
          plugin_id: pluginId,
          remote_input_id: row.remote_input_id ?? remoteInputId,
          remote_input_name: row.remote_input_name ?? remoteInputName ?? null
        })}`
      );
    }
    return row.id;
  }
  if (!inputType) {
    throw new Error(
      `Could not find input for plugin_id ${pluginId} and remoteInputId ${remoteInputId}, inputType is required to create a new one`
    );
  }
  const { data: plugin } = await this.query({ sql: 'select * from plugin where id=?', values: [pluginId] });
  if (plugin.length === 0) throw new Error(`No such plugin:${pluginId}`);
  const id = getInputUUID(pluginId, remoteInputId);
  await this.insertArray({
    table: 'input',
    upsert: true,
    array: [
      {
        id,
        plugin_id: pluginId,
        remote_input_id: remoteInputId,
        remote_input_name: remoteInputName ?? null,
        input_type: inputType,
        metadata: inputMetadata || null
      }
    ]
  });
  return id;
};

Worker.prototype.appendInputId = async function (opts) {
  const { batch, options = {} } = opts;
  const { pluginId, defaultInputId, remoteInputId, doNotUpsert, inputType, inputMetadata } = options;
  if (doNotUpsert) return;
  const toProcess = [];
  batch.forEach((o) => {
    if (o.input_id) return;
    if (o.remote_input_id) {
      // all set
    } else if (remoteInputId) {
      o.remote_input_id = remoteInputId;
    } else if (defaultInputId) {
      o.input_id = defaultInputId;
      return;
    }
    toProcess.push(o);
  });
  if (!pluginId && !doNotUpsert) {
    throw new Error('pluginId is required to append input ids -- you can use doNotUpsert for an append');
  }
  const remoteInputGroups = new Map();
  toProcess.forEach((o) => {
    if (!o.remote_input_id) {
      throw new Error(
        'Failed appending input id -- no input_id, remote_input_id, remoteInputId, or defaultInputId, sample:' +
          JSON5.stringify(o)
      );
    }
    const key = o.remote_input_id.toLowerCase();
    if (!remoteInputGroups.has(key)) remoteInputGroups.set(key, []);
    remoteInputGroups.get(key).push(o);
  });
  for (const records of remoteInputGroups.values()) {
    const sample = records[0];
    const resolvedInputId = await this.getInputId({
      pluginId,
      remoteInputId: sample.remote_input_id,
      remoteInputName: sample.remote_input_name,
      inputType,
      inputMetadata
    });
    records.forEach((record) => {
      record.input_id = resolvedInputId;
    });
  }
  const missing = batch.filter((d) => !d.input_id);
  if (missing.length > 0) {
    throw new Error('Failed appending input id, sample records:' + JSON5.stringify(missing.slice(0, 3), 0, 4));
  }
  const inputIds = [...new Set(batch.map((d) => d.input_id).filter(Boolean))];
  if (inputIds.length === 0) return;
  const { data: inputRows } = await this.query({
    sql: `select id, plugin_id, remote_input_id, remote_input_name, input_type from input where id in (${inputIds.map(() => '?').join(',')})`,
    values: inputIds
  });
  const byId = Object.fromEntries(inputRows.map((row) => [row.id, row]));
  const invalid = batch.filter((record) => {
    if (!record.input_id) return false;
    const row = byId[record.input_id];
    return !row?.input_type || String(row.input_type).trim() === '';
  });
  if (invalid.length > 0) {
    const samples = invalid.slice(0, 3).map((record) => {
      const row = byId[record.input_id];
      return {
        input_id: record.input_id,
        plugin_id: row?.plugin_id ?? pluginId,
        remote_input_id: record.remote_input_id ?? row?.remote_input_id,
        remote_input_name: record.remote_input_name ?? row?.remote_input_name ?? null,
        input_type: row?.input_type ?? null
      };
    });
    throw new Error(
      `input_type is required on input rows; ${invalid.length} record(s) resolved to input(s) with null input_type. Samples: ${JSON5.stringify(samples, null, 2)}`
    );
  }
};

Worker.prototype.appendEntryTypeId = function ({ batch, options = {}, strict = false }) {
  const { defaultEntryType } = options;
  batch.forEach((o) => {
    if (o.entry_type_id !== undefined) return;
    const etype = o.entry_type || defaultEntryType;
    if (!etype) {
      if (!strict) return;
      throw new Error('No entry_type specified, specify a defaultEntryType');
    }
    const id = TIMELINE_ENTRY_TYPES[etype];
    if (id === undefined) throw new Error(`Invalid entry_type: ${etype}`);
    o.entry_type_id = id;
    if (!o.ts && etype === 'SOURCE_CODE_OVERRIDE') o.ts = '1970-01-01'; // this specific type gets a default date
  });
};

const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
Worker.prototype.validateSourceCodeAscii = async function ({ batch, options = {} }) {
  const table = options.table ?? 'source_code_dictionary';
  const sourceTable = options.sourceTable;
  const invalid = new Set();
  batch.forEach((o) => {
    const v = o.source_code;
    if (v == null || v === '') return;
    const s = String(v);
    if (!PRINTABLE_ASCII.test(s) || s.length > 180) invalid.add(s.slice(0, 180));
  });
  if (invalid.size === 0) return;
  const hint =
    'source_code must be printable ASCII only (U+0020 through U+007E), max 180 characters. Replace Unicode look-alikes with ordinary ASCII upstream.';
  const tableRef = sourceTable ? `[table ${table}, source ${sourceTable}]` : `[table ${table}]`;
  throw new Error(
    `${tableRef} ${hint} Invalid source_code on ${invalid.size} row(s). Samples (unique values): ${JSON.stringify([...invalid].slice(0, 5))}`
  );
};

/*
  Lookup (and optionally insert) database-assigned ids for a value column,
  with a simple in-memory cache.  Port of the server's
  appendDatabaseIdWithCaching without knex.
*/
Worker.prototype.appendDatabaseIdWithCaching = async function ({
  batch,
  table,
  inputField,
  defaultInputFieldValue,
  outputField,
  inputName,
  idColumn = 'id',
  doNotUpsert = false
}) {
  batch.forEach((o) => {
    if (typeof o[inputField] === 'string') o[inputField] = o[inputField].trim();
  });
  let itemsWithNoIds = batch.filter((o) => {
    if (o[outputField]) return false;
    o[outputField] = 0;
    const inputVal = o[inputField];
    if (inputVal === undefined || inputVal === null) {
      if (defaultInputFieldValue !== undefined && defaultInputFieldValue !== null) {
        o[inputField] = defaultInputFieldValue;
        return true;
      }
      return false;
    }
    return true;
  });
  if (itemsWithNoIds.length === 0) return batch;
  this.itemCaches = this.itemCaches || {};
  this.itemCaches[table] = this.itemCaches[table] || new Map();
  const cache = this.itemCaches[table];
  itemsWithNoIds.forEach((o) => {
    o[outputField] = cache.get(String(o[inputField]).toLowerCase());
  });
  itemsWithNoIds = itemsWithNoIds.filter((o) => !o[outputField]);
  if (itemsWithNoIds.length === 0) return batch;
  const valuesToLookup = [...new Set(itemsWithNoIds.map((o) => String(o[inputField]).toLowerCase()))];
  const col = this.escapeColumn(inputField);
  const { data: existingIds } = await this.query({
    sql: `select ${this.escapeColumn(idColumn)} as id, ${col} as lookup from ${this.escapeTable(table)} where lower(${col}) in (${valuesToLookup.map(() => '?').join(',')})`,
    values: valuesToLookup
  });
  existingIds.forEach((r) => cache.set(String(r.lookup).trim().toLowerCase(), r.id));
  itemsWithNoIds = itemsWithNoIds.filter((o) => {
    const id = cache.get(String(o[inputField]).toLowerCase());
    o[outputField] = id;
    if (!o[outputField]) {
      if (doNotUpsert) {
        o[outputField] = null;
        return false;
      }
      return true;
    }
    return false;
  });
  if (itemsWithNoIds.length === 0) return batch;
  // New values -- insert one at a time so ids resolve across engines
  const toInsert = Object.values(
    itemsWithNoIds.reduce((a, b) => {
      const lookup = String(b[inputField]).toLowerCase();
      if (!a[lookup]) {
        a[lookup] = { [inputField]: b[inputField] };
        if (inputName) a[lookup][inputName] = b[inputName];
      }
      return a;
    }, {})
  );
  for (const row of toInsert) {
    await this.insertArray({ table, array: [row], upsert: true });
  }
  const { data: newIds } = await this.query({
    sql: `select ${this.escapeColumn(idColumn)} as id, ${col} as lookup from ${this.escapeTable(table)} where lower(${col}) in (${toInsert.map(() => '?').join(',')})`,
    values: toInsert.map((d) => String(d[inputField]).toLowerCase())
  });
  newIds.forEach((r) => cache.set(String(r.lookup).trim().toLowerCase(), r.id));
  itemsWithNoIds = itemsWithNoIds.filter((o) => {
    o[outputField] = cache.get(String(o[inputField]).toLowerCase());
    return !o[outputField];
  });
  if (itemsWithNoIds.length > 0) {
    throw new Error(
      `Error assigning ${table} ids to some records, including ${JSON.stringify(itemsWithNoIds.slice(0, 3))}`
    );
  }
  return batch;
};

Worker.prototype.appendSourceCodeId = async function ({ batch, options = {} }) {
  const { defaultSourceCode, doNotUpsert } = options;
  const defaultStr =
    defaultSourceCode != null && String(defaultSourceCode).trim() !== '' ? String(defaultSourceCode).trim() : null;
  batch.forEach((row) => {
    let sc = row.source_code;
    if (typeof sc === 'string') sc = sc.trim();
    const missing = sc == null || sc === '';
    if (missing) {
      row.source_code = defaultStr != null ? defaultStr : '';
    } else {
      row.source_code = sc;
    }
  });
  return this.appendDatabaseIdWithCaching({
    batch,
    table: 'source_code_dictionary',
    inputField: 'source_code',
    defaultInputFieldValue: defaultSourceCode ?? '',
    outputField: 'source_code_id',
    idColumn: 'source_code_id',
    doNotUpsert
  });
};

/* Resolve a transform config to { transform, bindings, options, path } */
Worker.prototype.resolveTransform = async function (o) {
  if (!o) return null;
  const { bindings, transform, path, options = {} } = o;
  if (typeof transform === 'function') {
    return { bindings, options, transform, path };
  }
  if (transform) throw new Error('transform should be a function');
  const methodTransforms = {
    'person.appendInputId': (opts) => this.appendInputId(opts),
    'person.extractDelegateIdentifiers': (opts) => this.extractDelegateIdentifiers(opts),
    'person.appendPersonId': (opts) => this.appendPersonId(opts),
    'person.validateSourceCodeAscii': (opts) => this.validateSourceCodeAscii(opts),
    'person.appendSourceCodeId': (opts) => this.appendSourceCodeId(opts),
    'person.appendEntryTypeId': (opts) => this.appendEntryTypeId(opts)
  };
  if (methodTransforms[path]) {
    return { path, bindings: {}, options, transform: methodTransforms[path] };
  }
  if (path === 'sql.tables.upsert') {
    return {
      path,
      bindings: { tablesToUpsert: { path: 'sql.tables.upsert' } },
      options,
      transform: async (opts) => {
        await this.upsertTables({ tablesToUpsert: opts.tablesToUpsert });
        Object.values(opts.tablesToUpsert).forEach((a) => {
          a.length = 0;
        });
      }
    };
  }
  const registryPath = path.replace(/^local\$/, '');
  const compiledTransform = TRANSFORM_REGISTRY[registryPath];
  if (!compiledTransform) {
    throw new Error(`Invalid transform path for client:${path} -- not in the static transform registry`);
  }
  const returnOptions = { ...compiledTransform.options, ...options };
  let { bindings: transformBindings } = compiledTransform;
  if (typeof transformBindings === 'function') {
    transformBindings = transformBindings(returnOptions);
  }
  return { ...compiledTransform, bindings: transformBindings, options: returnOptions, path };
};

/* Resolve transform bindings (sql.query lookups, tablesToUpsert, tools) */
Worker.prototype.resolveBindings = async function ({ bindings = {}, path, batch, tablesToUpsert }) {
  const boundItems = {};
  await Promise.all(
    Object.keys(bindings).map(async (name) => {
      const binding = bindings[name];
      if (!binding.path) {
        throw new Error(`path is required for binding ${name}, not found in ${JSON.stringify(Object.keys(binding))}`);
      }
      if (binding.path === 'sql.query') {
        if (!Array.isArray(binding.options?.lookup)) {
          throw new Error(`lookup as an array is required as an option for binding ${name}`);
        }
        if (binding.options.lookup.length !== 1)
          throw new Error(
            `Currently only one lookup column is allowed for sql.query bindings, found ${binding.options.lookup.length} for ${name}`
          );
        let lookup = binding.options.lookup[0];
        if (typeof lookup === 'string') {
          lookup = { personIdField: lookup, tableLookupField: lookup };
        }
        const values = new Set();
        batch.forEach((b) => {
          const v = b[lookup.personIdField];
          if (v) values.add(v);
        });
        if (values.size === 0) {
          boundItems[name] = [];
          return;
        }
        const table = binding.options.table;
        if (!table) throw new Error(`table is required for sql.query binding ${name} in ${path}`);
        const lookupValues = [...values];
        const queryValues = [...lookupValues];
        let sql = `select ${this.escapeTable(table)}.* from ${this.escapeTable(table)}`;
        for (const j of binding.options.joins || []) {
          if (!j?.table || !j?.join_eql) {
            throw new Error(`Invalid join for sql.query binding ${name} in ${path}`);
          }
          const joinType = (j.type || 'inner').toLowerCase();
          sql += ` ${joinType} join ${this.escapeTable(j.table)} on ${j.join_eql}`;
        }
        sql += ` where ${this.escapeTable(table)}.${this.escapeColumn(lookup.tableLookupField)} in (${lookupValues.map(() => '?').join(',')})`;
        for (const c of binding.options.conditions || []) {
          if (c?.type === 'EQUALS' && c.values?.[0]?.ref && c.values?.[1]?.value?.value != null) {
            sql += ` and ${c.values[0].ref} = ?`;
            queryValues.push(c.values[1].value.value);
          } else if (typeof c?.eql === 'string' && c.eql.trim()) {
            sql += ` and (${c.eql})`;
          } else {
            throw new Error(`Unsupported condition for sql.query binding ${name} in ${path}`);
          }
        }
        const { data } = await this.query({ sql, values: queryValues });
        boundItems[name] = data;
      } else if (binding.path === 'sql.tables.upsert') {
        if (!tablesToUpsert) throw new Error("This series of transforms don't allow for sql.tables.upsert");
        boundItems[name] = tablesToUpsert;
      } else if (binding.path === '@engine9/input-tools:uuidIsValid') {
        boundItems[name] = uuidIsValid;
      } else if (binding.path === 'tools.relativeDate') {
        boundItems[name] = relativeDate;
      } else {
        throw new Error(`Unknown binding.path:${binding.path}`);
      }
    })
  );
  return { boundItems };
};

/* Same transform chain as the server's getInboundTransforms */
Worker.prototype.getInboundTransforms = async function (options) {
  return buildInboundTransforms(this, options, {
    interfacePathPrefix: '@engine9/interfaces',
    beforeIdentityTransforms: [{ path: 'person.extractDelegateIdentifiers', options: {} }]
  });
};

/*
  Process a batch of person records through the inbound pipeline and upsert
  the results.  This is the real-time equivalent of the server's loadPeople:
  same transforms, single in-memory batch, no filesystem or streams.

  Returns a summary: { records, recordsWithPersonIds, personIds, executionStats }
*/
Worker.prototype.processPeople = async function (opts) {
  const { batch: inputBatch, doNotUpsert = false } = opts;
  if (!Array.isArray(inputBatch)) throw new Error('processPeople requires a batch array');
  if (inputBatch.length === 0) return { records: 0, recordsWithPersonIds: 0, personIds: [] };
  const pluginId = opts.pluginId;
  const transformConfigArray = await this.getInboundTransforms(opts);
  if (!doNotUpsert) {
    transformConfigArray.push({ path: 'sql.tables.upsert' });
  }
  const { batch, executionStats } = await runPeopleBatchPipeline({
    worker: this,
    batch: inputBatch,
    transformConfigArray,
    pluginId,
    batchStallTimeoutMs: opts.batch_stall_timeout_ms ?? opts.batchStallTimeoutMs
  });
  return {
    records: batch.length,
    recordsWithPersonIds: batch.filter((o) => o.person_id).length,
    personIds: batch.map((o) => o.person_id ?? null),
    executionStats
  };
};

export default Worker;
