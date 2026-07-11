import { v7 as uuidv7 } from 'uuid';
import debug$0 from 'debug';
import { bool, lowerCaseAndRemoveAccents, assertValidPersonIdentifierIdValue } from '../utilities.js';
import { personCreatedAtFromRow } from './personCreatedAt.js';
import * as sqlStore from './sqlStore.js';

const debug = debug$0('PersonId');

/*
  Assigning person ids may happen in parallel across threads, so this path
  blocks on person_identifier lookups and inserts.
*/
export async function assignPersonIds({ worker, batch, doNotUpsert: doNotUpsertOpt = false }) {
  const doNotUpsert = bool(doNotUpsertOpt, false);
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
      a[id.value] = (a[id.value] || []).concat(b);
      if (b.person_id) {
        existingIdentifierToPersonId[id.value] = b.person_id;
      }
    });
    return a;
  }, {});

  const tempIdLookup = {};
  batch.forEach((item) => {
    if (!item.person_id) {
      const matchingIdentifier = (item.identifiers || []).find((d) => existingIdentifierToPersonId[d.value]);
      if (matchingIdentifier) {
        item.person_id = existingIdentifierToPersonId[matchingIdentifier.value];
      }
    }
    (item.identifiers || []).some((id) => {
      const tempId = tempIdLookup[id.value];
      if (tempId) {
        item.temp_id = tempId;
        return true;
      }
      return false;
    });
    if (!item.temp_id) {
      item.temp_id = uuidv7();
      (item.identifiers || []).forEach((id) => {
        tempIdLookup[id.value] = item.temp_id;
      });
    }
  });

  const idArray = Object.keys(identifierMap);
  const existingIds = await sqlStore.findByIdValues(worker, idArray);

  const existsAlreadyInTableIdLookup = {};
  existingIds
    .filter((row) => row.id_type === 'remote_person_id')
    .forEach((row) => {
      existsAlreadyInTableIdLookup[row.id_value] = true;
      (identifierMap[row.id_value] || []).forEach((item) => {
        if (!item.person_id) item.person_id = row.person_id;
        delete item.temp_id;
      });
    });
  existingIds
    .filter((row) => row.id_type !== 'remote_person_id')
    .forEach((row) => {
      existsAlreadyInTableIdLookup[row.id_value] = true;
      (identifierMap[row.id_value] || []).forEach((item) => {
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
      if (existsAlreadyInTableIdLookup[id.value]) return;
      personIdentifersToInsert[id.value] = {
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
      await sqlStore.insertIdentifiers(worker, identifiersToInsert);
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

export async function appendPersonId({ worker, batch, inputId, options = {} }) {
  const { doNotUpsert = false } = options;
  batch.forEach((b) => {
    (b.identifiers || []).forEach((id) => {
      id.value = lowerCaseAndRemoveAccents(id.value);
    });
  });
  await assignPersonIds({ worker, batch, inputId, doNotUpsert });
  return batch;
}
