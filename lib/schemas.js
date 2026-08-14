/*
  Static registry of the standard Engine9 interface schemas the person pipeline
  knows how to use.

  Live schema deploy is @engine9/server SchemaWorker (filesystem / GitHub).
  Core uses this registry for sqlite-ddl and tests (SQLWorker.createTable).
*/
import pluginSchema from '@engine9/interfaces/plugin/schema.js';
import personSchema from '@engine9/interfaces/person/schema.js';
import personRemoteSchema from '@engine9/interfaces/person_remote/schema.js';
import segmentSchema from '@engine9/interfaces/segment/schema.js';
import personEmailSchema from '@engine9/interfaces/person_email/schema.js';
import personPhoneSchema from '@engine9/interfaces/person_phone/schema.js';
import personHashSchema from '@engine9/interfaces/person_hash/schema.js';
import personAddressSchema from '@engine9/interfaces/person_address/schema.js';
import timelineSchema from '@engine9/interfaces/timeline/schema.js';
import sourceCodeSchema from '@engine9/interfaces/source_code/schema.js';
import transactionCoreSchema from '@engine9/interfaces/transaction/core/schema.js';
import transactionProfileSchema from '@engine9/interfaces/transaction/profile/schema.js';

export const SCHEMAS = {
  '@engine9/interfaces/plugin': pluginSchema,
  '@engine9/interfaces/person': personSchema,
  '@engine9/interfaces/person_remote': personRemoteSchema,
  '@engine9/interfaces/segment': segmentSchema,
  '@engine9/interfaces/person_email': personEmailSchema,
  '@engine9/interfaces/person_phone': personPhoneSchema,
  '@engine9/interfaces/person_hash': personHashSchema,
  '@engine9/interfaces/person_address': personAddressSchema,
  '@engine9/interfaces/timeline': timelineSchema,
  '@engine9/interfaces/source_code': sourceCodeSchema,
  '@engine9/interfaces/transaction/core': transactionCoreSchema,
  '@engine9/interfaces/transaction/profile': transactionProfileSchema
};

export default { SCHEMAS };
