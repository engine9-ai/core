/*
  Plugin settings: declared in the package (settings export or sibling
  settings.js, both attached by the plugin registry at compile), stored per
  installed plugin row in warehouse `setting`.

  Distinct from marketplace authorization (`auth_fields` / credentials).
  Discovery follows the same compile-and-aggregate path as inbound weaving,
  searchOptions, and report list: list installed plugins, compilePlugin each
  path, read the feature export, group by plugin.
*/
import { equivalentPluginPaths } from './pluginPaths.js';
import { isMissingTableError } from './sql/shared.js';

const SETTING_METADATA_KEYS = [
  'type',
  'description',
  'label',
  'values',
  'required',
  'secret',
  'hidden',
  'section',
  'placeholder',
  'help',
  'format',
  'min',
  'max'
];

function settingDefaultValue(def) {
  if (def && Object.prototype.hasOwnProperty.call(def, 'default') && def.default != null) {
    return String(def.default);
  }
  if (def && Object.prototype.hasOwnProperty.call(def, 'default_value') && def.default_value != null) {
    return String(def.default_value);
  }
  return '';
}

function normalizePluginSettings(settings) {
  if (!settings) return [];
  if (Array.isArray(settings)) {
    return settings
      .filter((row) => row && typeof row === 'object' && row.name)
      .map((row) => ({
        ...row,
        name: String(row.name)
      }));
  }
  if (typeof settings === 'object') {
    return Object.entries(settings).map(([name, def]) => {
      if (def && typeof def === 'object') return { name, ...def };
      return { name, default: def };
    });
  }
  return [];
}

function jsonSchemaType(type) {
  const t = String(type || 'string').toLowerCase();
  if (t === 'int' || t === 'integer') return 'integer';
  if (t === 'number' || t === 'float' || t === 'double') return 'number';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'json' || t === 'object') return 'object';
  if (t === 'array') return 'array';
  return 'string';
}

function jsonSchemaFormat(def) {
  if (def.format) return def.format;
  const t = String(def.type || '').toLowerCase();
  if (t === 'email') return 'email';
  if (t === 'url' || t === 'uri') return 'uri';
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'date-time') return 'date-time';
  if (t === 'password') return 'password';
  return undefined;
}

function publicSettingDefinition(def) {
  const out = { name: String(def.name), declared: true };
  for (const key of SETTING_METADATA_KEYS) {
    if (def[key] != null) out[key] = def[key];
  }
  if (!out.type) out.type = 'string';
  if (Object.prototype.hasOwnProperty.call(def, 'default') || Object.prototype.hasOwnProperty.call(def, 'default_value')) {
    out.default = settingDefaultValue(def);
  }
  return out;
}

function settingFormFromDefs(defs = []) {
  const properties = {};
  const required = [];
  for (const def of defs) {
    if (!def?.name || def.hidden) continue;
    const property = {
      type: jsonSchemaType(def.type)
    };
    const format = jsonSchemaFormat(def);
    if (format) property.format = format;
    if (def.description) property.description = def.description;
    if (def.label) property.title = def.label;
    if (def.placeholder) property.placeholder = def.placeholder;
    if (Array.isArray(def.values) && def.values.length) property.enum = def.values;
    if (def.default != null) property.default = def.default;
    else if (def.default_value != null) property.default = def.default_value;
    if (def.min != null) property.minimum = def.min;
    if (def.max != null) property.maximum = def.max;
    if (def.secret) property.writeOnly = true;
    properties[def.name] = property;
    if (def.required) required.push(def.name);
  }
  const form = {
    title: 'Settings',
    type: 'object',
    properties
  };
  if (required.length) form.required = required;
  return form;
}

function stringifySettingValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function coerceSettingValue(def, raw) {
  if (raw == null) return null;
  const type = String(def?.type || 'string').toLowerCase();
  if (type === 'int' || type === 'integer') {
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : raw;
  }
  if (type === 'number' || type === 'float' || type === 'double') {
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'boolean' || type === 'bool') {
    if (raw === true || raw === 'true' || raw === '1' || raw === 1) return true;
    if (raw === false || raw === 'false' || raw === '0' || raw === 0 || raw === '') return false;
    return raw;
  }
  if (type === 'json' || type === 'object' || type === 'array') {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return String(raw);
}

function validateSettingValue(def, value) {
  if (!def) return stringifySettingValue(value);
  if (def.required && (value == null || value === '')) {
    throw new Error(`Setting ${def.name} is required`);
  }
  if (Array.isArray(def.values) && def.values.length && value != null && value !== '') {
    const allowed = def.values.map((v) => String(v));
    if (!allowed.includes(String(value))) {
      throw new Error(`Setting ${def.name} must be one of: ${allowed.join(', ')}`);
    }
  }
  const type = String(def.type || 'string').toLowerCase();
  if ((type === 'int' || type === 'integer') && value != null && value !== '') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error(`Setting ${def.name} must be an integer`);
  }
  if ((type === 'number' || type === 'float' || type === 'double') && value != null && value !== '') {
    if (!Number.isFinite(Number(value))) throw new Error(`Setting ${def.name} must be a number`);
  }
  if ((type === 'json' || type === 'object' || type === 'array') && typeof value === 'string' && value !== '') {
    try {
      JSON.parse(value);
    } catch {
      throw new Error(`Setting ${def.name} must be valid JSON`);
    }
  }
  return stringifySettingValue(value);
}

function isSecretDef(def) {
  if (!def) return false;
  if (def.secret) return true;
  const type = String(def.type || '').toLowerCase();
  return type === 'password' || type === 'secret';
}

function settingValueForUi(def, raw) {
  if (isSecretDef(def)) {
    const hasValue = raw != null && String(raw) !== '';
    return { value: null, has_value: hasValue };
  }
  const value = raw == null || raw === '' ? null : coerceSettingValue(def, raw);
  return { value, has_value: raw != null && String(raw) !== '' };
}

function instanceSettingRow(pluginId, raw, def) {
  const ui = settingValueForUi(def, raw);
  return { plugin_id: pluginId, ...ui };
}

function filterPluginRows(plugins, { plugin_id, path } = {}) {
  let rows = plugins || [];
  if (plugin_id) {
    const id = String(plugin_id);
    rows = rows.filter((row) => String(row.id) === id);
  }
  if (path) {
    const aliases = new Set(equivalentPluginPaths(path));
    rows = rows.filter((row) => aliases.has(row.path));
  }
  return rows;
}

async function loadSettingValuesByPluginId(worker, pluginIds) {
  const byId = new Map();
  if (!pluginIds.length) return byId;
  const placeholders = pluginIds.map(() => '?').join(',');
  let rows = [];
  try {
    const result = await worker.query({
      sql: `select plugin_id, name, value from setting where plugin_id in (${placeholders})`,
      values: pluginIds
    });
    rows = result?.data || [];
  } catch (e) {
    if (isMissingTableError(e)) return byId;
    throw e;
  }
  for (const row of rows) {
    if (!byId.has(row.plugin_id)) byId.set(row.plugin_id, {});
    byId.get(row.plugin_id)[row.name] = row.value;
  }
  return byId;
}

/**
 * Account-scoped settings catalog grouped by installed plugin path.
 * Same discovery shape as PersonWorker.searchOptions / ReportWorker.list.
 */
async function listAccountPluginSettings(worker, { plugin_id, path, include_hidden = false } = {}) {
  const account_id = worker.accountId;
  let plugins = [];
  try {
    plugins = await worker.list({ fields: '*' });
  } catch (e) {
    return {
      account_id,
      plugins: [],
      errors: [{ path: null, error: e.message || String(e) }]
    };
  }

  plugins = filterPluginRows(plugins, { plugin_id, path });
  const instancesByPath = new Map();
  for (const plugin of plugins) {
    const pluginPath = plugin?.path;
    if (!pluginPath || typeof pluginPath !== 'string') continue;
    if (!instancesByPath.has(pluginPath)) instancesByPath.set(pluginPath, []);
    instancesByPath.get(pluginPath).push({
      id: plugin.id,
      name: plugin.name ?? null,
      table_prefix: plugin.table_prefix ?? plugin.tablePrefix ?? null
    });
  }

  const errors = [];
  const valuesByPluginId = await loadSettingValuesByPluginId(
    worker,
    [...instancesByPath.values()].flat().map((row) => row.id).filter(Boolean)
  );

  const catalog = [];
  for (const [pluginPath, instances] of instancesByPath) {
    let defs = [];
    let compiledName = null;
    if (typeof worker.compilePlugin === 'function') {
      try {
        const compiled = await worker.compilePlugin({ path: pluginPath });
        defs = normalizePluginSettings(compiled?.settings);
        compiledName = compiled?.metadata?.name || compiled?.name || null;
      } catch (e) {
        errors.push({ path: pluginPath, error: e.message || String(e) });
      }
    }

    const defsByName = new Map(defs.map((def) => [def.name, def]));
    const visibleDefs = include_hidden ? defs : defs.filter((def) => !def.hidden);
    const settings = visibleDefs.map((def) => {
      const publicDef = publicSettingDefinition(def);
      const instanceRows = instances.map((instance) =>
        instanceSettingRow(instance.id, valuesByPluginId.get(instance.id)?.[def.name], def)
      );
      const entry = { ...publicDef, instances: instanceRows };
      if (instanceRows.length === 1) {
        entry.value = instanceRows[0].value;
        entry.has_value = instanceRows[0].has_value;
      }
      return entry;
    });

    const declaredNames = new Set(defs.map((def) => def.name));
    for (const instance of instances) {
      const stored = valuesByPluginId.get(instance.id) || {};
      for (const [name, raw] of Object.entries(stored)) {
        if (declaredNames.has(name)) continue;
        let extra = settings.find((row) => row.name === name && row.declared === false);
        if (!extra) {
          extra = {
            name,
            type: 'string',
            declared: false,
            instances: []
          };
          settings.push(extra);
        }
        extra.instances.push(instanceSettingRow(instance.id, raw, { name, type: 'string' }));
        if (extra.instances.length === 1) {
          extra.value = extra.instances[0].value;
          extra.has_value = extra.instances[0].has_value;
        } else {
          delete extra.value;
          delete extra.has_value;
        }
      }
    }

    if (!settings.length) continue;

    catalog.push({
      path: pluginPath,
      name: instances.find((row) => row.name)?.name || compiledName || pluginPath.split('/').pop(),
      plugin: { path: pluginPath, instances },
      form: settingFormFromDefs(visibleDefs),
      settings
    });
  }

  catalog.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { account_id, plugins: catalog, errors };
}

async function updateAccountPluginSetting(worker, { pluginId, plugin_id, name, value } = {}) {
  const id = pluginId || plugin_id;
  const settingName = name != null ? String(name) : '';
  if (!id) throw new Error('plugin_id is required');
  if (!settingName) throw new Error('name is required');

  const { data: rows } = await worker.query({
    sql: 'select id, path from plugin where id=?',
    values: [id]
  });
  const plugin = rows?.[0];
  if (!plugin) throw new Error(`Plugin not found: ${id}`);

  let def = null;
  if (typeof worker.compilePlugin === 'function') {
    try {
      const compiled = await worker.compilePlugin({ path: plugin.path });
      def = normalizePluginSettings(compiled?.settings).find((row) => row.name === settingName) || null;
    } catch {
      def = null;
    }
  }
  const stored = validateSettingValue(def, value);
  await worker.setSetting({ pluginId: id, name: settingName, value: stored });
  return {
    plugin_id: id,
    path: plugin.path,
    name: settingName,
    value: isSecretDef(def) ? null : coerceSettingValue(def, stored),
    has_value: stored !== ''
  };
}

export {
  SETTING_METADATA_KEYS,
  coerceSettingValue,
  listAccountPluginSettings,
  normalizePluginSettings,
  publicSettingDefinition,
  settingDefaultValue,
  settingFormFromDefs,
  stringifySettingValue,
  updateAccountPluginSetting,
  validateSettingValue
};
