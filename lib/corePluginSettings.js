/*
  Warehouse settings on `@engine9/interfaces/plugin` that steer installDefaultPlugins
  and plaintext-PII installs. Read from the account DB — not accounts.d.
*/
import { isMissingTableError } from './sql/shared.js';

const CORE_PLUGIN_PATH = '@engine9/interfaces/plugin';
const LIMITED_PII_STACK_PATH = '@engine9/interfaces/stacks/limited-pii';
const STANDARD_STACK_PATH = '@engine9/interfaces/stacks/standard';

/** Plugins / stacks that store or install plaintext email, phone, or postal address. */
const PLAINTEXT_PII_INSTALL_PATHS = [
  STANDARD_STACK_PATH,
  '@engine9/interfaces/person_email',
  '@engine9/interfaces/person_phone',
  '@engine9/interfaces/person_address'
];

function isTruthyExcludePii(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

/**
 * Read `default_stack` and `exclude_pii` from the core plugin row.
 * Missing tables / row → { default_stack: null, exclude_pii: false }.
 */
async function readCorePluginSettings(worker) {
  try {
    const { tables } = await worker.tables();
    if (!tables.includes('plugin') || !tables.includes('setting')) {
      return { default_stack: null, exclude_pii: false };
    }
    const { data: plugins } = await worker.query({
      sql: 'select id from plugin where path = ? limit 1',
      values: [CORE_PLUGIN_PATH]
    });
    const pluginId = plugins?.[0]?.id;
    if (!pluginId) return { default_stack: null, exclude_pii: false };
    const settings =
      typeof worker.getSettings === 'function'
        ? await worker.getSettings({ pluginId })
        : (
            await worker.query({
              sql: 'select name, value from setting where plugin_id=?',
              values: [pluginId]
            })
          ).data?.reduce((s, r) => {
            s[r.name] = r.value;
            return s;
          }, {}) || {};
    const rawStack = settings?.default_stack;
    const trimmed = rawStack == null ? '' : String(rawStack).trim();
    return {
      default_stack: trimmed || null,
      exclude_pii: isTruthyExcludePii(settings?.exclude_pii)
    };
  } catch (e) {
    if (isMissingTableError(e)) return { default_stack: null, exclude_pii: false };
    throw e;
  }
}

export {
  CORE_PLUGIN_PATH,
  LIMITED_PII_STACK_PATH,
  STANDARD_STACK_PATH,
  PLAINTEXT_PII_INSTALL_PATHS,
  isTruthyExcludePii,
  readCorePluginSettings
};
