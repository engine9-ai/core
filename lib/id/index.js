import { v7 as uuidv7 } from 'uuid';
import debug$0 from 'debug';
import { bool, lowerCaseAndRemoveAccents, assertValidPersonIdentifierIdValue } from '../utilities.js';
import { personCreatedAtFromRow } from './personCreatedAt.js';
import * as sqlStore from './sqlStore.js';
import {
  identifierMapKey,
  hashIdValueToU128,
  hashIdValueToU128Hex,
  u128ToHexKey,
  durableObjectStorageKey
} from './hash.js';
import { bulkConvertPersonIdentifiers } from './bulkConvert.js';
import { createDurableObjectIdentifierStore } from './durableObjectStore.js';
import { PersonIdentifierDO } from './PersonIdentifierDO.js';
import {
  createCompactSqlIdentifierStore,
  personIdTableName,
  ensureCompactPersonIdTable,
  ensureCompactPersonIdTables
} from './compactSqlStore.js';
import {
  createDefaultIdentifierStore,
  createIdentifierStoreForKind,
  readIdentifierStoreKind,
  writeIdentifierStoreKind,
  defaultIdentifierStoreKind,
  normalizeIdentifierStoreKind,
  IDENTIFIER_STORE_KIND_SETTING,
  IDENTIFIER_STORE_KIND_COMPACT,
  IDENTIFIER_STORE_KIND_LEGACY,
  CORE_PLUGIN_ID
} from './storeKind.js';

const debug = debug$0('PersonId');

export {
  bulkConvertPersonIdentifiers,
  createDurableObjectIdentifierStore,
  createCompactSqlIdentifierStore,
  personIdTableName,
  ensureCompactPersonIdTable,
  ensureCompactPersonIdTables,
  PersonIdentifierDO,
  hashIdValueToU128,
  hashIdValueToU128Hex,
  u128ToHexKey,
  durableObjectStorageKey,
  identifierMapKey,
  createDefaultIdentifierStore,
  createIdentifierStoreForKind,
  readIdentifierStoreKind,
  writeIdentifierStoreKind,
  defaultIdentifierStoreKind,
  normalizeIdentifierStoreKind,
  IDENTIFIER_STORE_KIND_SETTING,
  IDENTIFIER_STORE_KIND_COMPACT,
  IDENTIFIER_STORE_KIND_LEGACY,
  CORE_PLUGIN_ID
};
export { createPersonIdentifierSqlStore, createSqlIdentifierStore } from './sqlStore.js';

/*
  Assigning person ids may happen in parallel across threads, so this path
  blocks on person_identifier lookups and inserts.
*/
export async function assignPersonIds({
  worker,
  batch,
  doNotUpsert: doNotUpsertOpt = false,
  identifierStore = null
}) {
  const doNotUpsert = bool(doNotUpsertOpt, false);
  const store = identifierStore || (await createDefaultIdentifierStore(worker));

  batch.forEach((item) => {
    (item.identifiers || []).forEach((id) => {
      assertValidPersonIdentifierIdValue(id, {
        input_id: item.input_id,
        person_id: item.person_id,
        source_input_id: item.input_id,
        source_table: id.path,
        identifier_path: id.path
      });
    });
  });

  const existingIdentifierToPersonId = {};
  const identifierMap = batch.reduce((a, b) => {
    (b.identifiers || []).forEach((id) => {
      const key = identifierMapKey(id.type, id.value);
      a[key] = (a[key] || []).concat(b);
      if (b.person_id) {
        existingIdentifierToPersonId[key] = b.person_id;
      }
    });
    return a;
  }, {});

  const tempIdLookup = {};
  batch.forEach((item) => {
    if (!item.person_id) {
      const matchingIdentifier = (item.identifiers || []).find((d) =>
        existingIdentifierToPersonId[identifierMapKey(d.type, d.value)]
      );
      if (matchingIdentifier) {
        item.person_id =
          existingIdentifierToPersonId[identifierMapKey(matchingIdentifier.type, matchingIdentifier.value)];
      }
    }
    (item.identifiers || []).some((id) => {
      const key = identifierMapKey(id.type, id.value);
      const tempId = tempIdLookup[key];
      if (tempId) {
        item.temp_id = tempId;
        return true;
      }
      return false;
    });
    if (!item.temp_id) {
      item.temp_id = uuidv7();
      (item.identifiers || []).forEach((id) => {
        tempIdLookup[identifierMapKey(id.type, id.value)] = item.temp_id;
      });
    }
  });

  const entries = Object.keys(identifierMap).map((key) => {
    const sep = key.indexOf('\0');
    return { id_type: key.slice(0, sep), id_value: key.slice(sep + 1) };
  });
  const existingIds = await store.findByIdentifiers(entries);

  const existsAlreadyInTableIdLookup = {};
  existingIds
    .filter((row) => row.id_type === 'remote_person_id')
    .forEach((row) => {
      const key = identifierMapKey(row.id_type, row.id_value);
      existsAlreadyInTableIdLookup[key] = true;
      (identifierMap[key] || []).forEach((item) => {
        if (!item.person_id) item.person_id = row.person_id;
        delete item.temp_id;
      });
    });
  existingIds
    .filter((row) => row.id_type !== 'remote_person_id')
    .forEach((row) => {
      const key = identifierMapKey(row.id_type, row.id_value);
      existsAlreadyInTableIdLookup[key] = true;
      (identifierMap[key] || []).forEach((item) => {
        if (!item.person_id) item.person_id = row.person_id;
        delete item.temp_id;
      });
    });

  const lookupByTempId = batch
    .filter((item) => item.temp_id)
    .reduce((a, b) => {
      a[b.temp_id] = b;
      return a;
    }, {});
  const tempIds = Object.keys(lookupByTempId);

  const toInsert = tempIds.map((id) => {
    const row = {};
    const createdAt = personCreatedAtFromRow(lookupByTempId[id]);
    if (createdAt) row.created_at = createdAt;
    return row;
  });

  const tempIdToPersonIdLookup = {};
  if (toInsert.length > 0 && !doNotUpsert) {
    const assignedIds = await sqlStore.insertPersons(worker, toInsert);
    tempIds.forEach((t, index) => {
      tempIdToPersonIdLookup[t] = assignedIds[index];
    });
  }

  const personIdentifersToInsert = {};
  batch.forEach((item) => {
    if (!item.person_id) {
      item.person_id = tempIdToPersonIdLookup[item.temp_id];
      if (!doNotUpsert && !item.person_id) throw new Error(`Unusual error, could not find temp_id:${item.temp_id}`);
      delete item.temp_id;
    }
    (item.identifiers || []).forEach((id) => {
      const key = identifierMapKey(id.type, id.value);
      if (existsAlreadyInTableIdLookup[key]) return;
      personIdentifersToInsert[key] = {
        person_id: item.person_id,
        source_input_id: item.input_id,
        id_type: id.type,
        id_value: id.value
      };
    });
  });

  const identifiersToInsert = Object.values(personIdentifersToInsert);
  if (identifiersToInsert.length > 0 && !doNotUpsert) {
    try {
      await store.insertIdentifiers(identifiersToInsert);
    } catch (e) {
      debug(
        'Error inserting person_identifier records, sample ids to insert:',
        JSON.stringify(identifiersToInsert.slice(0, 3), null, 4)
      );
      throw e;
    }
  }

  return batch;
}

export async function appendPersonId({ worker, batch, inputId, options = {}, identifierStore = null }) {
  const { doNotUpsert = false } = options;
  batch.forEach((b) => {
    (b.identifiers || []).forEach((id) => {
      id.value = lowerCaseAndRemoveAccents(id.value);
    });
  });
  await assignPersonIds({ worker, batch, inputId, doNotUpsert, identifierStore });
  return batch;
}
