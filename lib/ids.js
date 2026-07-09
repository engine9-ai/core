/*
  Portable Engine9 ID helpers.

  These are byte-for-byte the same algorithms as @engine9/input-tools
  (getPluginUUID, getInputUUID, getVersionedUUID, getTimelineEntryUUID, ...)
  but without importing the input-tools index, which drags in server-only
  dependencies (AWS SDK, archiver, googleapis) that cannot ship in a
  Cloudflare Worker bundle.  Only `uuid` and Buffer are required.
*/
import { Buffer } from 'node:buffer';
import { v4 as uuidv4, v5 as uuidv5, v7 as uuidv7, validate as uuidIsValid } from 'uuid';
import { TIMELINE_ENTRY_TYPES } from '@engine9/input-tools/timelineTypes.js';

// Dates before ~2001-09-09 in ms are ambiguous with second timestamps
const UNIX_MS_MIN = 1000000000000;

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

export function getPluginUUID(uniqueNamespaceLikeDomainName, valueWithinNamespace) {
  // Random custom namespace for plugins -- not cryptographically secure, just a unique namespace
  return uuidv5(`${uniqueNamespaceLikeDomainName}::${valueWithinNamespace}`, 'f9e1024d-21ac-473c-bac6-64796dd771dd');
}

export function getInputUUID(a, b) {
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

export function dateFromString(s) {
  if (typeof s === 'number') return new Date(s);
  if (typeof s === 'string' && /^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= UNIX_MS_MIN) return new Date(n);
  }
  return new Date(s);
}

export function getVersionedUUID(date, reqUuid) {
  /* optional date and input UUID */
  const uuid = reqUuid || uuidv7();
  const bytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  if (date !== undefined) {
    const d = dateFromString(date);
    // isNaN behaves differently than Number.isNaN -- we want attempted conversion
    if (isNaN(d)) throw new Error(`getVersionedUUID got an invalid date:${date || '<blank>'}`);
    const dateBytes = intToByteArray(d.getTime()).reverse();
    dateBytes.slice(2, 8).forEach((b, i) => {
      bytes[i] = b;
    });
  }
  const result = uuidv4({ random: bytes });
  // The version MUST be a supported UUID number, and the variant matters as well - 8,9,a,b
  return result.substring(0, 14) + '1' + result.substring(15, 19) + '8' + result.substring(20);
}

/* Returns a date from a given uuid (assumed to be a v7, otherwise the results are ... weird) */
export function getUUIDTimestamp(uuid) {
  const ts = parseInt(`${uuid}`.replace(/-/g, '').slice(0, 12), 16);
  return new Date(ts);
}

export function getEntryTypeId(o, { defaults = {} } = {}) {
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

export function getEntryType(o, defaults = {}) {
  let etype = o.entry_type || defaults.entry_type;
  if (etype) return etype;
  const id = o.entry_type_id ?? defaults.entry_type_id;
  etype = TIMELINE_ENTRY_TYPES[id];
  if (etype === undefined) throw new Error(`Invalid entry_type: ${etype}`);
  return etype;
}

const requiredTimelineEntryFields = ['ts', 'entry_type_id', 'plugin_id', 'person_id'];
export function getTimelineEntryUUID(inputObject, { defaults = {} } = {}) {
  const o = { ...defaults, ...inputObject };
  /* Outside systems CAN specify a unique UUID as remote_entry_uuid */
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
  // Per-row input_id / message_id disambiguates entries that share ts/person/entry_type/source_code
  const rowInputId = inputObject.message_id ?? inputObject.input_id;
  const inputSuffix = rowInputId !== undefined && rowInputId !== null && rowInputId !== '' ? `-${rowInputId}` : '';
  const idString = `${ts.toISOString()}-${o.person_id}-${o.entry_type_id}-${o.source_code_id || 0}${inputSuffix}`;
  if (!uuidIsValid(o.plugin_id)) {
    throw new Error(`Invalid plugin_id:'${o.plugin_id}', type ${typeof o.plugin_id} -- should be a uuid`);
  }
  const uuid = uuidv5(idString, o.plugin_id);
  return getVersionedUUID(ts, uuid);
}

export { uuidv4, uuidv5, uuidv7, uuidIsValid, TIMELINE_ENTRY_TYPES };
export default {
  getPluginUUID,
  getInputUUID,
  getVersionedUUID,
  getUUIDTimestamp,
  getEntryTypeId,
  getEntryType,
  getTimelineEntryUUID,
  dateFromString,
  uuidv4,
  uuidv5,
  uuidv7,
  uuidIsValid,
  TIMELINE_ENTRY_TYPES
};
