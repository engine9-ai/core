/*
  Shared Engine9 utilities.

  This is the canonical home of utilities shared between @engine9/core and
  @engine9/server -- the server re-exports from here.  Keep this file free of
  server-only dependencies (filesystem stores, workers, etc.) so it can run in
  constrained runtimes such as Cloudflare Workers (with nodejs_compat).
*/
import { Buffer } from 'node:buffer';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import crypto from 'node:crypto';
import { v4 as uuidv4, v5 as uuidv5, v7 as uuidv7, validate as uuidIsValid } from 'uuid';
import { TIMELINE_ENTRY_TYPES } from '@engine9/input-tools/timelineTypes.js';
dayjs.extend(customParseFormat);

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

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
function relativeDate(s, _initialDate) {
  let initialDate = _initialDate;
  if (!s || s === 'none') return null;
  if (typeof s.getMonth === 'function') return s;
  // We actually want a double equals here to test strings as well
  if (parseInt(s, 10) == s) {
    const r = new Date(parseInt(s, 10));
    if (!isValidDate(r)) throw new Error(`Invalid integer date:${s}`);
    return r;
  }
  if (initialDate) {
    initialDate = new Date(initialDate);
  } else {
    initialDate = new Date();
  }
  let r = s.match(/^([+-]{1})([0-9]+)([YyMwdhms]{1})([.a-z]*)$/);
  if (r) {
    let period = null;
    switch (r[3]) {
      case 'Y':
      case 'y':
        period = 'years';
        break;
      case 'M':
        period = 'months';
        break;
      case 'w':
        period = 'weeks';
        break;
      case 'd':
        period = 'days';
        break;
      case 'h':
        period = 'hours';
        break;
      case 'm':
        period = 'minutes';
        break;
      case 's':
        period = 'seconds';
        break;
      default:
        period = 'minutes';
        break;
    }
    let d = dayjs(initialDate);
    if (r[1] === '+') {
      d = d.add(parseInt(r[2], 10), period);
    } else {
      d = d.subtract(parseInt(r[2], 10), period);
    }
    if (!isValidDate(d.toDate())) throw new Error(`Invalid date configuration:${r}`);
    if (r[4]) {
      const opts = r[4].split('.').filter(Boolean);
      if (opts[0] === 'start') d = d.startOf(opts[1] || 'day');
      else if (opts[0] === 'end') d = d.endOf(opts[1] || 'day');
      else throw new Error(`Invalid relative date,unknown options:${r[4]}`);
    }
    return d.toDate();
  }
  if (s === 'now') {
    r = dayjs(new Date()).toDate();
    return r;
  }
  r = dayjs(new Date(s)).toDate();
  if (!isValidDate(r)) throw new Error(`Invalid Date: ${s}`);
  return r;
}
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
// Dates before ~2001-09-09 in ms are ambiguous with second timestamps
const UNIX_MS_MIN = 1000000000000;

function dateFromString(s) {
  if (typeof s === 'number') return new Date(s);
  if (typeof s === 'string' && /^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= UNIX_MS_MIN) return new Date(n);
  }
  return new Date(s);
}

function intToByteArray(int) {
  let v = int;
  const byteArray = new Array(8).fill(0);
  for (let index = 0; index < byteArray.length; index += 1) {
    const byte = v & 0xff;
    byteArray[index] = byte;
    v = (v - byte) / 256;
  }
  return byteArray;
}

function getPluginUUID(uniqueNamespaceLikeDomainName, valueWithinNamespace) {
  return uuidv5(`${uniqueNamespaceLikeDomainName}::${valueWithinNamespace}`, 'f9e1024d-21ac-473c-bac6-64796dd771dd');
}

function getInputUUID(a, b) {
  let pluginId = a;
  let remoteInputId = b;
  if (typeof a === 'object') {
    pluginId = a.pluginId;
    remoteInputId = a.remoteInputId;
  }
  if (!pluginId) throw new Error('getInputUUID: Cowardly rejecting a blank plugin_id');
  if (!uuidIsValid(pluginId)) throw new Error(`Invalid pluginId:${pluginId}, should be a UUID`);
  const rid = (remoteInputId || '').trim();
  if (!rid) throw new Error('getInputUUID: Cowardly rejecting a blank remote_input_id, set a default');
  return uuidv5(`${pluginId}:${rid}`, '3d0e5d99-6ba9-4fab-9bb2-c32304d3df8e');
}

function getVersionedUUID(date, reqUuid) {
  const uuid = reqUuid || uuidv7();
  const bytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  if (date !== undefined) {
    const d = dateFromString(date);
    if (isNaN(d)) throw new Error(`getVersionedUUID got an invalid date:${date || '<blank>'}`);
    const dateBytes = intToByteArray(d.getTime()).reverse();
    dateBytes.slice(2, 8).forEach((b, i) => {
      bytes[i] = b;
    });
  }
  const result = uuidv4({ random: bytes });
  return result.substring(0, 14) + '1' + result.substring(15, 19) + '8' + result.substring(20);
}

function getUUIDTimestamp(uuid) {
  const ts = parseInt(`${uuid}`.replace(/-/g, '').slice(0, 12), 16);
  return new Date(ts);
}

function getEntryTypeId(o, { defaults = {} } = {}) {
  let id = o.entry_type_id ?? defaults.entry_type_id;
  if (id !== undefined && id !== null) return id;
  const etype = o.entry_type || defaults.entry_type;
  if (!etype) {
    throw new Error('No entry_type, nor entry_type_id specified, specify one to generate a timeline suitable ID');
  }
  id = TIMELINE_ENTRY_TYPES[etype];
  if (id === undefined) throw new Error(`Invalid entry_type: ${etype}`);
  return id;
}

function getEntryType(o, defaults = {}) {
  let etype = o.entry_type || defaults.entry_type;
  if (etype) return etype;
  const id = o.entry_type_id ?? defaults.entry_type_id;
  etype = TIMELINE_ENTRY_TYPES[id];
  if (etype === undefined) throw new Error(`Invalid entry_type: ${etype}`);
  return etype;
}

const requiredTimelineEntryFields = ['ts', 'entry_type_id', 'plugin_id', 'person_id'];

function getTimelineEntryUUID(inputObject, { defaults = {} } = {}) {
  const o = { ...defaults, ...inputObject };
  if (o.remote_entry_uuid) {
    if (!uuidIsValid(o.remote_entry_uuid)) throw new Error('Invalid remote_entry_uuid, it must be a UUID');
    return o.remote_entry_uuid;
  }
  if (o.remote_entry_id) {
    if (!o.plugin_id)
      throw new Error('Error generating timeline entry uuid -- remote_entry_id specified, but no plugin_id');
    if (!uuidIsValid(o.plugin_id))
      throw new Error(`Invalid plugin_id:'${o.plugin_id}', type ${typeof o.plugin_id} -- should be a uuid`);
    const uuid = uuidv5(String(o.remote_entry_id), o.plugin_id);
    return getVersionedUUID(o.ts, uuid);
  }
  o.entry_type_id = getEntryTypeId(o);
  const missing = requiredTimelineEntryFields.filter((d) => o[d] === undefined);
  if (missing.length > 0) throw new Error(`Missing required fields to append an entry_id:${missing.join(',')}`);
  const ts = dateFromString(o.ts);
  if (isNaN(ts)) throw new Error(`getTimelineEntryUUID got an invalid date:${o.ts || '<blank>'}`);
  const rowInputId = inputObject.message_id ?? inputObject.input_id;
  const inputSuffix = rowInputId !== undefined && rowInputId !== null && rowInputId !== '' ? `-${rowInputId}` : '';
  const idString = `${ts.toISOString()}-${o.person_id}-${o.entry_type_id}-${o.source_code_id || 0}${inputSuffix}`;
  if (!uuidIsValid(o.plugin_id)) {
    throw new Error(`Invalid plugin_id:'${o.plugin_id}', type ${typeof o.plugin_id} -- should be a uuid`);
  }
  const uuid = uuidv5(idString, o.plugin_id);
  return getVersionedUUID(ts, uuid);
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
function bool(x, _defaultVal) {
  const defaultVal = _defaultVal === undefined ? false : _defaultVal;
  if (x === undefined || x === null || x === '') return defaultVal;
  if (typeof x !== 'string') return !!x;
  if (x === '1') return true; // 0 will return false, but '1' is true
  const y = x.toLowerCase();
  return !!(y.indexOf('y') + 1) || !!(y.indexOf('t') + 1);
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
class ObjectError extends Error {
  constructor(data) {
    if (typeof data === 'string') {
      // normal behavior
      super(data);
    } else if (typeof data === 'object') {
      super(data.message);
      Object.keys(data).forEach((k) => {
        this[k] = data[k];
      });
      this.status = data.status;
    } else {
      super('(No error message)');
    }
  }
}
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
function getStringArray(s, nonZeroLength) {
  let a = s || [];
  if (typeof a === 'number') a = String(a);
  if (typeof a === 'string') a = [a];
  if (typeof s === 'string') a = s.split(',');
  a = a.map((x) => x.toString().trim()).filter(Boolean);
  if (nonZeroLength && a.length === 0) a = [0];
  return a;
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
async function resolveObject(obj, limit) {
  const pLimit = await import('p-limit');
  const limitedMethod = pLimit.default(limit || 5);
  return Promise.all(Object.entries(obj).map(([k, v]) => limitedMethod(async () => [k, await v]))).then(
    Object.fromEntries
  );
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

/** SHA-256 hex digest of an empty string — must never be stored as person_identifier.id_value. */
const BLANK_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function assertValidPersonIdentifierIdValue(identifier, context = {}) {
  const id_value = identifier.id_value ?? identifier.value;
  const id_type = identifier.id_type ?? identifier.type;
  if (id_value === BLANK_SHA256_HEX) {
    const source_table = context.source_table ?? context.identifier_path;
    const tablePart = source_table ? `, source_table=${source_table}` : '';
    throw new ObjectError({
      message: `Refusing person_identifier id_value (SHA-256 of blank): id_type=${id_type}${tablePart}`,
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
export { isValidDate };
export { toCharCodes };
export { getIntArray };
export { getStringArray };
export { diffObjectKeysAcrossSamples };
export { generateUniqueKey };
export { lowerCaseAndRemoveAccents };
export { makeJSONString };
export { BLANK_SHA256_HEX };
export { assertValidPersonIdentifierIdValue };
export { ObjectError };
export { CircularBuffer };
export { FixedQueue };
export { getPluginUUID };
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
  isValidDate,
  toCharCodes,
  getIntArray,
  getStringArray,
  diffObjectKeysAcrossSamples,
  generateUniqueKey,
  lowerCaseAndRemoveAccents,
  makeJSONString,
  BLANK_SHA256_HEX,
  assertValidPersonIdentifierIdValue,
  ObjectError,
  CircularBuffer,
  FixedQueue,
  getPluginUUID,
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
