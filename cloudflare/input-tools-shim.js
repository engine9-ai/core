/*
  Cloudflare bundling shim for @engine9/input-tools.

  The real @engine9/input-tools index imports server-only dependencies
  (@aws-sdk/client-s3, archiver, unzipper, googleapis) that cannot ship in a
  Worker bundle.  The interface transforms used by the client only need the
  small portable pieces below, which are implemented in @engine9/client
  without those dependencies.

  Alias it in wrangler.toml (see cloudflare/README.md):

    [alias]
    "@engine9/input-tools" = "@engine9/client/cloudflare/input-tools-shim"
*/
export {
  uuidIsValid,
  uuidv4,
  uuidv5,
  uuidv7,
  getPluginUUID,
  getInputUUID,
  getVersionedUUID,
  getUUIDTimestamp,
  getTimelineEntryUUID,
  getEntryType,
  getEntryTypeId,
  TIMELINE_ENTRY_TYPES
} from '../lib/utilities.js';
export { bool, getStringArray, relativeDate, isValidDate, ObjectError } from '../lib/utilities.js';
