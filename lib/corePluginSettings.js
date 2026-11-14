/*
  The warehouse setting that guards plaintext-PII installs.
  Read from the account DB — not accounts.d.

  - exclude_pii: `@engine9/schemas/utilities/limited-pii` (only when that plugin is installed)

  exclude_pii refuses plaintext contact plugins, including any plugin that
  includes one. It does not choose what to install.
*/
import { isMissingTableError } from './sql/shared.js';
import { getPluginSettings } from './pluginSettings.js';

const CORE_PLUGIN_PATH = '@engine9/schemas/plugin';
const LIMITED_PII_PLUGIN_PATH = '@engine9/schemas/utilities/limited-pii';

/** Plugins that store plaintext names, email, phone, or postal address. */
const PLAINTEXT_PII_INSTALL_PATHS = [
  '@engine9/schemas/person_name',
  '@engine9/schemas/person_email',
  '@engine9/schemas/person_phone',
  '@engine9/schemas/person_address',
  '@engine9/schemas/transaction/contact_details'
];

function isTruthyExcludePii(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

async function settingsForPluginPath(worker, pluginPath) {
  const { data: plugins } = await worker.query({
    sql: 'select id from plugin where path=? limit 1',
    values: [pluginPath]
  });
  const pluginId = plugins?.[0]?.id;
  if (!pluginId) return null;
  return getPluginSettings(worker, { pluginId });
}

/**
 * Read `exclude_pii` (utilities/limited-pii).
 * Missing tables / rows → { exclude_pii: false }.
 */
async function readCorePluginSettings(worker) {
  try {
    const { tables } = await worker.tables();
    if (!tables.includes('plugin') || !tables.includes('setting')) return { exclude_pii: false };
    const limitedSettings = await settingsForPluginPath(worker, LIMITED_PII_PLUGIN_PATH);
    return { exclude_pii: isTruthyExcludePii(limitedSettings?.exclude_pii) };
  } catch (e) {
    if (isMissingTableError(e)) return { exclude_pii: false };
    throw e;
  }
}

export {
  CORE_PLUGIN_PATH,
  LIMITED_PII_PLUGIN_PATH,
  PLAINTEXT_PII_INSTALL_PATHS,
  isTruthyExcludePii,
  readCorePluginSettings
};
