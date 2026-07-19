/*
  @engine9/core -- slim Engine9 deployment for websites.

  See README.md for the client/server responsibility split.
*/
export { default as SQLWorker } from './lib/SQLWorker.js';
export { default as SchemaWorker, STANDARD_INSTALL_SCHEMAS } from './lib/SchemaWorker.js';
export { default as PersonWorker } from './lib/PersonWorker.js';
export {
  buildInboundTransforms,
  runPeopleTransformStep,
  runPeopleBatchPipeline,
  runLoadPeopleStream
} from './lib/peoplePipeline/index.js';
export {
  batchStallKey,
  createBatchStallWatcher,
  resolveBatchStallTimeoutMs
} from './lib/batchStallWatcher.js';
export { SCHEMAS } from './lib/schemas.js';
export * as utilities from './lib/utilities.js';
export {
  assignPersonIds,
  appendPersonId,
  bulkConvertPersonIdentifiers,
  createDefaultIdentifierStore,
  createIdentifierStoreForKind,
  readIdentifierStoreKind,
  writeIdentifierStoreKind,
  defaultIdentifierStoreKind,
  IDENTIFIER_STORE_KIND_SETTING,
  IDENTIFIER_STORE_KIND_COMPACT,
  IDENTIFIER_STORE_KIND_LEGACY,
  createDurableObjectIdentifierStore,
  createPersonIdentifierSqlStore,
  createSqlIdentifierStore,
  createCompactSqlIdentifierStore,
  personIdTableName,
  PersonIdentifierDO,
  hashIdValueToU128,
  hashIdValueToU128Hex
} from './lib/id/index.js';
export * as sqlShared from './lib/sql/shared.js';
export { buildCreateTable, buildAlterTable } from './lib/sql/sqliteDDL.js';
export {
  SqlApiKeyStore,
  KVApiKeyStore,
  generateApiKey,
  hashApiKey,
  extractApiKey,
  API_KEY_SCHEMA
} from './auth/index.js';
export {
  createDelegateLoginFailure,
  normalizeDelegateLoginFailure,
  delegateAuthorizeUrl,
  exchangeDelegateCode,
  resolveDelegatePersonId,
  createSessionToken,
  verifySessionToken,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole,
  createDelegateAuth
} from './auth/delegate.js';
export { JsonlFileLogger, BatchLogger, NullLogger, r2Sink } from './logging/index.js';
export { createApi, SCOPES } from './api/index.js';
