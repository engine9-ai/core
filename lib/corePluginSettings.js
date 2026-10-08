/*
  Warehouse settings that steer installDefaultPlugins and plaintext-PII installs.
  Read from the account DB — not accounts.d.

  - default_stack: `@engine9/schemas/plugin`
  - exclude_pii: `@engine9/schemas/utilities/limited-pii` (only when that plugin is installed)
*/
import { isMissingTableError } from './sql/shared.js';

const CORE_PLUGIN_PATH = '@engine9/schemas/plugin';
const LIMITED_PII_STACK_PATH = '@engine9/schemas/stacks/limited-pii';
const LIMITED_PII_PLUGIN_PATH = '@engine9/schemas/utilities/limited-pii';
const STANDARD_STACK_PATH = '@engine9/schemas/stacks/standard';

/** Plugins / stacks that store or install plaintext email, phone, or postal address. */
const PLAINTEXT_PII_INSTALL_PATHS = [
  STANDARD_STACK_PATH,
  '@engine9/schemas/person_email',
  '@engine9/schemas/person_phone',
  '@engine9/schemas/person_address'
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
  if (typeof worker.getSettings === 'function') {
    return worker.getSettings({ pluginId });
  }
  return (
    (
      await worker.query({
        sql: 'select name, value from setting where plugin_id=?',
        values: [pluginId]
      })
    ).data?.reduce((s, r) => {
      s[r.name] = r.value;
      return s;
    }, {}) || {}
  );
}

/**
 * Read `default_stack` (core plugin) and `exclude_pii` (utilities/limited-pii).
 * Missing tables / rows → { default_stack: null, exclude_pii: false }.
 */
async function readCorePluginSettings(worker) {
  try {
    const { tables } = await worker.tables();
    if (!tables.includes('plugin') || !tables.includes('setting')) {
      return { default_stack: null, exclude_pii: false };
    }
    const coreSettings = await settingsForPluginPath(worker, CORE_PLUGIN_PATH);
    const rawStack = coreSettings?.default_stack;
    const trimmed = rawStack == null ? '' : String(rawStack).trim();
    const limitedSettings = await settingsForPluginPath(worker, LIMITED_PII_PLUGIN_PATH);
    return {
      default_stack: trimmed || null,
      exclude_pii: isTruthyExcludePii(limitedSettings?.exclude_pii)
    };
  } catch (e) {
    if (isMissingTableError(e)) return { default_stack: null, exclude_pii: false };
    throw e;
  }
}

export {
  CORE_PLUGIN_PATH,
  LIMITED_PII_STACK_PATH,
  LIMITED_PII_PLUGIN_PATH,
  STANDARD_STACK_PATH,
  PLAINTEXT_PII_INSTALL_PATHS,
  isTruthyExcludePii,
  readCorePluginSettings
};
