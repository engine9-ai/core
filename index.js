/*
  @engine9/core -- slim Engine9 deployment for websites.

  See README.md for the client/server responsibility split.
*/
export { default as SQLWorker } from './lib/SQLWorker.js';
export { default as SchemaWorker } from './lib/SchemaWorker.js';
export { default as PluginWorker, DEFAULT_PLUGIN_SCHEMA_PATH } from './lib/PluginWorker.js';
export {
  listAccountPluginSettings,
  normalizePluginSettings,
  publicSettingDefinition,
  settingDefaultValue,
  settingFormFromDefs,
  updateAccountPluginSetting,
  validateSettingValue
} from './lib/pluginSettings.js';
export { default as PersonWorker } from './lib/PersonWorker.js';
export { loadStackMetadata, DEFAULT_STACK_PATH } from './lib/stackMetadata.js';
export {
  PLUGIN_CONFIG_INVALID,
  PLUGIN_PACKAGE_NOT_DECLARED,
  PLUGIN_NOT_FOUND,
  PLUGIN_IMPORT_FAILED,
  PluginLoadError,
  createPluginRegistry,
  asPluginRegistry,
  composePluginRegistries,
  setDefaultPluginRegistry,
  getDefaultPluginRegistry,
  pluginRegistryFor,
  compileRegistryPlugin,
  loadRegistrySchema,
  loadRegistryConsole
} from './lib/pluginRegistry.js';
export {
  buildInboundTransforms,
  describeInboundTransforms,
  loadInboundPlugins,
  normalizeInboundSpec,
  EXTRA_TRANSFORM_SLOTS,
  INBOUND_SLOTS,
  PLUGIN_INBOUND_SLOTS,
  runPeopleTransformStep,
  runPeopleBatchPipeline,
  runLoadPeopleStream,
  entryTypeKeyFromRecord,
  formatEntryTypeCounts,
  tallyEntryType
} from './lib/peoplePipeline/index.js';
export {
  batchStallKey,
  createBatchStallWatcher,
  resolveBatchStallTimeoutMs
} from './lib/batchStallWatcher.js';
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
export { sqlIndexName, SQL_IDENTIFIER_MAX_LENGTH } from './lib/sql/sqlIndexName.js';
export { standardizeSchema, defaultStandardColumn } from './lib/sql/standardizeSchema.js';
export {
  SqlApiKeyStore,
  KVApiKeyStore,
  generateApiKey,
  hashApiKey,
  extractApiKey,
  isEngine9ApiKeyToken,
  API_KEY_PREFIX,
  PUBLIC_API_KEY_PREFIX,
  API_KEY_SCHEMA,
  API_KEY_SCOPE_CATALOG,
  getApiKeyCatalog,
  toPublicApiKeyRecord,
  resolveAuthContext,
  hasScope,
  intersectScopes,
  meetsRequiredAuth,
  parseSharedSecrets,
  signPayload,
  verifySignedPayload
} from './auth/index.js';
export {
  createDelegateLoginFailure,
  normalizeDelegateLoginFailure,
  delegateIdentityUrl,
  verifyDelegateIdentityToken,
  isDelegateIdentityJwt,
  classifyDelegateLoginToken,
  siteOriginFromUrl,
  domainFromUrl,
  createSessionCookieHeaders,
  resolveDelegatePersonId,
  createSessionToken,
  verifySessionToken,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole,
  normalizeRoleRegistry,
  resolveRoleId,
  createDelegateAuth
} from './auth/delegate.js';
export { JsonlFileLogger, BatchLogger, NullLogger, r2Sink } from './logging/index.js';
export { createApi, SCOPES } from './api/index.js';
