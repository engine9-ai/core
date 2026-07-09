/*
  Static registry of the standard Engine9 interface schemas.

  The server resolves schemas dynamically from the filesystem or GitHub; that
  doesn't work in bundled runtimes (Cloudflare Workers), so the client imports
  the interface schema modules statically.  Bundlers tree-shake anything a
  deployment doesn't reference.
*/
import pluginSchema from '@engine9/interfaces/plugin/schema.js';
import personSchema from '@engine9/interfaces/person/schema.js';
import personRemoteSchema from '@engine9/interfaces/person_remote/schema.js';
import segmentSchema from '@engine9/interfaces/segment/schema.js';
import personEmailSchema from '@engine9/interfaces/person_email/schema.js';
import personPhoneSchema from '@engine9/interfaces/person_phone/schema.js';
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
  '@engine9/interfaces/person_address': personAddressSchema,
  '@engine9/interfaces/timeline': timelineSchema,
  '@engine9/interfaces/source_code': sourceCodeSchema,
  '@engine9/interfaces/transaction/core': transactionCoreSchema,
  '@engine9/interfaces/transaction/profile': transactionProfileSchema
};

/* Deployment order matters: plugin first, segment before interfaces that export segments */
export const STANDARD_INSTALL_SCHEMAS = [
  '@engine9/interfaces/plugin',
  '@engine9/interfaces/person',
  '@engine9/interfaces/person_remote',
  '@engine9/interfaces/segment',
  '@engine9/interfaces/person_email',
  '@engine9/interfaces/person_phone',
  '@engine9/interfaces/person_address',
  '@engine9/interfaces/timeline',
  '@engine9/interfaces/source_code',
  '@engine9/interfaces/transaction/core',
  '@engine9/interfaces/transaction/profile'
];

export default { SCHEMAS, STANDARD_INSTALL_SCHEMAS };
