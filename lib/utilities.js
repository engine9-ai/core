/*
  Shared Engine9 utilities.

  Utilities shared by @engine9/core and @engine9/server -- the server
  re-exports from here. Helpers every engine9 package needs (values, ids)
  live once in @engine9/input-tools (values.js, uuidTools.js) and are
  re-exported below; add new ones there. Keep this file free of
  server-only dependencies (filesystem stores, workers, etc.) so it can run in
  constrained runtimes such as Cloudflare Workers (with nodejs_compat).
*/
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import crypto from 'node:crypto';
import { v4 as uuidv4, v5 as uuidv5, v7 as uuidv7, validate as uuidIsValid } from 'uuid';
import { TIMELINE_ENTRY_TYPES } from '@engine9/input-tools/timelineTypes.js';
// The one copy of these lives in @engine9/input-tools; core re-exports them.
import {
  bool,
  chunkArray,
  getStringArray,
  isValidDate,
  ObjectError,
  parseJSONValue,
  relativeDate,
  stableStringify
} from '@engine9/input-tools/values.js';
import {
  dateFromString,
  getEntryType,
  getEntryTypeId,
  getInputUUID,
  getPluginUUID,
  getTimelineEntryUUID,
  getUUIDTimestamp,
  getVersionedUUID
} from '@engine9/input-tools/uuidTools.js';
dayjs.extend(customParseFormat);


class CircularBuffer {
  constructor(bufferLength) {
    this.buffer = [];
    this.pointer = 0;
    this.bufferLength = bufferLength;
  }
  push(element) {
    if (this.buffer.length === this.bufferLength) {
      this.buffer[this.pointer] = element;
    } else {
      this.buffer.push(element);
    }
    this.pointer = (this.pointer + 1) % this.bufferLength;
  }
  get(i) {
    return this.buffer[i];
  }
  //Gets the ith element before last one
  getLast(i) {
    return this.buffer[this.pointer + this.bufferLength - 1 - i];
  }
}
class FixedQueue {
  constructor(maxSize) {
    this.queue = [];
    this.maxSize = maxSize;
  }
  enqueue(item) {
    this.queue.push(item);
    if (this.queue.length > this.maxSize) {
      this.queue.shift(); // Remove the oldest item
    }
  }
  dequeue() {
    return this.queue.shift();
  }
  get length() {
    return this.queue.length;
  }
}
let cc = null;
function camelCase(o) {
  if (cc === null) throw new Error('Run async camelCase.init() before using camelCase');
  if (typeof o === 'string') return cc.default(o);
  if (typeof o !== 'object') return o;
  if (Array.isArray(o)) {
    return o.map((x) => camelCase(x));
  }
  const out = {};
  Object.entries(o).forEach(([k, v]) => {
    out[cc.default(k)] = v;
  });
  return out;
}
camelCase.init = async function () {
  cc = await import('camelcase');
};
function zeds(i) {
  let s = i;
  while (s.length < 2) s = `0${s}`;
  return s;
}
const dateRegex = [
  { regex: /^[0-9]{1,2}\/[0-9]{2}$/, clean: (s) => `01/${s.split('/').map(zeds).join('/')}`, format: 'DD/MM/YY' },
  { regex: /^[0-9]{1,2}\/[0-9]{4}$/, clean: (s) => `01/${s.split('/').map(zeds).join('/')}`, format: 'DD/MM/YYYY' },
  {
    regex: /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2}$/,
    clean: (s) => s.split('/').map(zeds).join(','),
    format: 'MM/DD/YY'
  },
  {
    regex: /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}$/,
    clean: (s) => s.split('/').map(zeds).join(','),
    format: 'MM/DD/YYYY'
  },
  { regex: /^[0-9]{4}$/, clean: (s) => `01/01/${s}`, format: 'DD/MM/YYYY' },
  { regex: /^.*$/ } // try the normal parser
];
// Smart date parsing based on a few key heuristics
// Returns a valid ISO date string, or NULL -- if you want invalid dates, parse them yourself
function parseDate(d) {
  if (!d) return null;
  if (typeof d !== 'string') {
    const o = dayjs(d);
    if (Number.isNaN(o)) return null;
    return o.toISOString();
  }
  const matching = dateRegex.find((r) => {
    const m = d.match(r.regex);
    return !!m;
  });
  if (!matching) return null; // not a valid date
  const input = matching.clean ? matching.clean(d) : d;
  const o = dayjs(input, matching.format);
  if (!o.isValid()) return null;
  return o.toISOString();
}




/** Schema plugins that may be installed more than once per account (own table prefix per row). */
const NON_UNIQUE_SCHEMA_PATHS = new Set(['@engine9/schemas/person_custom']);

/**
 * Whether PluginWorker.install should reuse an existing plugin row for this path.
 *
 * Precedence:
 * 1. metadata.unique (or top-level pluginConfiguration.unique) when defined
 * 2. known non-unique schema plugins (person_custom)
 * 3. @engine9/schemas/* default unique (one row per account)
 * 4. options.unique, otherwise false — third-party plugins may install multiple times
 */
function resolvePluginInstallUnique({
  path: pluginPath,
  metadata,
  unique: optionsUnique,
  pluginConfiguration
} = {}) {
  const meta = metadata || pluginConfiguration?.metadata;
  if (meta?.unique !== undefined) return Boolean(meta.unique);
  if (pluginConfiguration?.unique !== undefined) return Boolean(pluginConfiguration.unique);
  const normalized = String(pluginPath || '');
  if (NON_UNIQUE_SCHEMA_PATHS.has(normalized)) return false;
  if (normalized.startsWith('@engine9/schemas/')) return true;
  return Boolean(optionsUnique);
}







function parseRegExp(o, opts) {
  if (o instanceof RegExp) return o;
  try {
    const tempObject = {};
    switch (typeof o) {
      case 'object':
        Object.keys(o).forEach((k) => {
          tempObject[k] = parseRegExp(o[k], k);
        });
        return tempObject;
      case 'string':
        if (o.indexOf('/') === 0 && o.lastIndexOf('/') > 0) {
          const r = o.slice(1, o.lastIndexOf('/'));
          const g = o.slice(o.lastIndexOf('/') + 1);
          const flags = (g + (opts || '')).split('').join('');
          const re = new RegExp(r, flags);
          return re;
        }
        return new RegExp(o, opts || 'i');
      default:
        return o;
    }
  } catch {
    return o;
  }
}
function toCharCodes(x) {
  if (!x) return [];
  return Array.from(x)
    .filter(Boolean)
    .map((d) => d.charCodeAt(0));
}
function getIntArray(s, nonZeroLength) {
  let a = s || [];
  if (typeof a === 'number') a = [a];
  if (typeof s === 'string') a = s.split(',');
  a = a.filter((x) => parseInt(x, 10) == x).map((x) => parseInt(x, 10));
  if (nonZeroLength && a.length === 0) a = [0];
  return a;
}
/*
        generate a unique hexadecimal key
*/
function generateUniqueKey(_opts) {
  const opts = _opts || {};
  const method = opts.method || 'sha1';
  const encoding = opts.encoding || 'hex';
  const bytes = opts.bytes || 2048;
  return crypto.createHash(method).update(crypto.randomBytes(bytes)).digest(encoding);
}
function cleanColumnName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}
/*
An error that can take an object as a constructor, that can be dereferenced later.
The object should have a 'message' property for the parent error.
*/
function analyzeTypeToParquet(t) {
  switch (t) {
    case 'date':
    case 'datetime':
      return { type: 'TIMESTAMP_MILLIS', map: (v) => (v ? new Date(v) : null) };
    case 'boolean':
      return { type: 'BOOLEAN', map: (v) => bool(v) };
    case 'int':
      return { type: 'INT64', map: (v) => parseInt(v, 10) };
    case 'decimal':
    case 'double':
      return { type: 'DOUBLE', map: (v) => parseFloat(v, 10) };
    case 'uuid':
    case 'string':
    default:
      return { type: 'UTF8', map: (v) => v };
  }
}
/* Useful for adding to database */
function makeJSONString(o, defaultVal) {
  if (!o) {
    if (typeof defaultVal === 'string') return defaultVal;
    return JSON.stringify(defaultVal);
  }
  if (typeof o === 'string') return o;
  return JSON.stringify(o);
}
/*
  A JSON column's value as an object. SQLite and D1 return JSON columns as
  text, MySQL as objects. null, '', and text that is not JSON give fallback.
*/
/* JSON with object keys sorted, so equal values stringify (and hash) equally. Functions and undefined are dropped, as JSON.stringify does. */
/* [1,2,3,4,5], 2 -> [[1,2],[3,4],[5]] */
async function resolveObject(obj, limit) {
  const pLimit = await import('p-limit');
  const limitedMethod = pLimit.default(limit || 5);
  return Promise.all(Object.entries(obj).map(([k, v]) => limitedMethod(async () => [k, await v]))).then(
    Object.fromEntries
  );
}

function omitKeys(source, keys) {
  const omit = new Set(keys);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !omit.has(key)));
}

/*
  identity deduplication relies on lower case AND no accent
*/
function lowerCaseAndRemoveAccents(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function diffObjectKeysAcrossSamples(objects, opts = {}) {
  const array = Array.isArray(objects) ? objects : [];

  if (array.length === 0) {
    return {
      sampleIndexes: [],
      baselineKeys: [],
      samples: [],
      mismatches: []
    };
  }
  const sampleIndexes = [0];
  if (array.length > 1) sampleIndexes.push(1);
  const lastIndex = array.length - 1;
  if (lastIndex > 1) sampleIndexes.push(lastIndex);

  //This is all just for logging keys, which are typically in the object itself
  const includeKeys = Array.isArray(opts.includeKeys) ? new Set(opts.includeKeys) : null;
  const ignoreKeys = new Set(Array.isArray(opts.ignoreKeys) ? opts.ignoreKeys : []);
  const getKeysForObject = (obj) => {
    const source = obj || {};
    const keys = Object.keys(source).filter((key) => !ignoreKeys.has(key));
    if (!includeKeys) return keys;
    return keys.filter((key) => includeKeys.has(key));
  };

  const samples = sampleIndexes.map((index) => {
    const obj = array[index];
    return {
      index,
      object: obj,
      keys: getKeysForObject(obj)
    };
  });
  const baselineSet = new Set(samples[0].keys);
  const mismatches = samples
    .slice(1)
    .map((sample) => {
      const sampleSet = new Set(sample.keys);
      const missingFromRecord = [...baselineSet].filter((key) => !sampleSet.has(key));
      const extraInRecord = [...sampleSet].filter((key) => !baselineSet.has(key));
      if (!missingFromRecord.length && !extraInRecord.length) return null;
      return {
        index: sample.index,
        missingFromRecord,
        extraInRecord
      };
    })
    .filter(Boolean);
  return {
    sampleIndexes,
    baselineKeys: samples[0].keys,
    samples,
    mismatches
  };
}

/** SHA-256 hex digest of an empty string — must never be stored as a person identifier value. */
const BLANK_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function assertValidPersonIdentifierIdValue(identifier, context = {}) {
  const id_value = identifier.id_value ?? identifier.value;
  const id_type = identifier.id_type ?? identifier.type;
  if (id_value === BLANK_SHA256_HEX) {
    const source_table = context.source_table ?? context.identifier_path;
    const tablePart = source_table ? `, source_table=${source_table}` : '';
    throw new ObjectError({
      message: `Refusing person identifier value (SHA-256 of blank): id_type=${id_type}${tablePart}`,
      reason: 'blank_sha256_hash',
      id_type,
      id_value,
      ...(source_table ? { source_table } : {}),
      ...context
    });
  }
}

export { analyzeTypeToParquet };
export { bool };
export { camelCase };
export { cleanColumnName };
export { parseRegExp };
export { parseDate };
export { dateFromString };
export { relativeDate };
export { resolveObject };
export { omitKeys };
export { isValidDate };
export { toCharCodes };
export { getIntArray };
export { getStringArray };
export { diffObjectKeysAcrossSamples };
export { generateUniqueKey };
export { lowerCaseAndRemoveAccents };
export { makeJSONString };
export { parseJSONValue };
export { stableStringify };
export { chunkArray };
export { BLANK_SHA256_HEX };
export { assertValidPersonIdentifierIdValue };
export { ObjectError };
export { CircularBuffer };
export { FixedQueue };
export { getPluginUUID };
export { NON_UNIQUE_SCHEMA_PATHS };
export { resolvePluginInstallUnique };
export { getInputUUID };
export { getVersionedUUID };
export { getUUIDTimestamp };
export { getEntryTypeId };
export { getEntryType };
export { getTimelineEntryUUID };
export { uuidv4 };
export { uuidv5 };
export { uuidv7 };
export { uuidIsValid };
export { TIMELINE_ENTRY_TYPES };
export default {
  analyzeTypeToParquet,
  bool,
  camelCase,
  cleanColumnName,
  parseRegExp,
  parseDate,
  dateFromString,
  relativeDate,
  resolveObject,
  omitKeys,
  isValidDate,
  toCharCodes,
  getIntArray,
  getStringArray,
  diffObjectKeysAcrossSamples,
  generateUniqueKey,
  lowerCaseAndRemoveAccents,
  makeJSONString,
  parseJSONValue,
  stableStringify,
  chunkArray,
  BLANK_SHA256_HEX,
  assertValidPersonIdentifierIdValue,
  ObjectError,
  CircularBuffer,
  FixedQueue,
  getPluginUUID,
  NON_UNIQUE_SCHEMA_PATHS,
  resolvePluginInstallUnique,
  getInputUUID,
  getVersionedUUID,
  getUUIDTimestamp,
  getEntryTypeId,
  getEntryType,
  getTimelineEntryUUID,
  uuidv4,
  uuidv5,
  uuidv7,
  uuidIsValid,
  TIMELINE_ENTRY_TYPES
};
