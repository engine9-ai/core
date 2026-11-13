/*
  Plugin catalog entries: the published surface of one plugin.

  An entry says what a plugin is (path, package, name, publisher, display),
  what it needs (dependencies), what a person configures (credentials,
  settings), and what a caller can run (methods, submodules). It does not
  list everything a plugin does. Secrets tools, task callers, settings UIs and
  market.engine9.ai read entries; nothing reads the plugin's code to find
  these things out.

  The standard is docs/plugin-catalog.md; the JSON Schema is
  docs/plugin-catalog.schema.json. This module builds entries from a plugin
  module, validates them, bundles them, and derives the secrets definition
  for a plugin's credentials. It has no filesystem or database dependency.
*/
import { packageNameOf } from './pluginPaths.js';

const PLUGIN_CATALOG_VERSION = 1;
const PLUGIN_CATALOG_SCHEMA_URL = 'https://market.engine9.ai/schemas/plugin/v1.json';

const ENTRY_KEYS = [
  '$schema',
  'catalog_version',
  'path',
  'package',
  'name',
  'alias',
  'description',
  'categories',
  'logo',
  'homepage',
  'publisher',
  'bot_path',
  'dependencies',
  'credentials',
  'settings',
  'methods',
  'submodules'
];
const SUBMODULE_KEYS = ['description', 'settings', 'methods'];
const METHOD_KEYS = ['description', 'deprecated', 'options'];
const FIELD_KEYS = [
  'name',
  'type',
  'label',
  'description',
  'help',
  'placeholder',
  'section',
  'required',
  'hidden',
  'secret',
  'deprecated',
  'default',
  'values',
  'pattern',
  'min',
  'max'
];
const FIELD_TYPES = [
  'string',
  'text',
  'password',
  'secret_text',
  'email',
  'url',
  'number',
  'integer',
  'boolean',
  'select',
  'json',
  'array',
  'date',
  'datetime'
];
const TYPE_ALIASES = {
  textarea: 'text',
  int: 'integer',
  float: 'number',
  double: 'number',
  bool: 'boolean',
  checkbox: 'boolean',
  uri: 'url',
  key: 'password',
  secret: 'password',
  object: 'json',
  'date-time': 'datetime'
};
const SECRET_TYPES = new Set(['password', 'secret_text']);
const METHOD_METADATA_RESERVED = new Set(['options', 'alias', 'description', 'display', 'bot', 'mcp', 'deprecated', 'output']);

const PATH_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const METHOD_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SUBMODULE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isExtensionKey = (k) => typeof k === 'string' && k.startsWith('x-');

function canonicalType(type) {
  if (type == null || type === '') return undefined;
  const t = String(type).toLowerCase();
  return TYPE_ALIASES[t] || t;
}

/**
 * One canonical field from a settings, credentials or option declaration.
 * `typeDefault` fills a missing type (options leave it out: any JSON value).
 * Unknown keys are dropped, except `x-` extensions.
 */
function normalizeCatalogField(raw, name, { typeDefault } = {}) {
  const def = isObject(raw) ? raw : {};
  const out = {};
  if (name != null) out.name = String(name);
  let type = canonicalType(def.type) || typeDefault;
  const values = Array.isArray(def.values) ? def.values : Array.isArray(def.options) ? def.options : null;
  if (values && values.length && (type === 'string' || type === undefined) && name != null) type = 'select';
  if (type) out.type = type;
  for (const key of ['label', 'description', 'help', 'placeholder', 'section']) {
    if (def[key] != null && def[key] !== '') out[key] = String(def[key]);
  }
  for (const key of ['required', 'hidden']) {
    if (def[key] === true) out[key] = true;
  }
  if (def.secret === true || def.secret === false) out.secret = def.secret;
  if (def.deprecated === true || (typeof def.deprecated === 'string' && def.deprecated)) out.deprecated = def.deprecated;
  if (values && values.length) {
    out.values = values.map((v) =>
      isObject(v) ? { value: v.value ?? v.id ?? v.name, ...(v.label != null ? { label: String(v.label) } : {}) } : v
    );
  }
  if (Object.prototype.hasOwnProperty.call(def, 'default') && def.default !== undefined) out.default = def.default;
  else if (Object.prototype.hasOwnProperty.call(def, 'default_value') && def.default_value != null) out.default = def.default_value;
  if (typeof def.pattern === 'string' && def.pattern) out.pattern = def.pattern;
  for (const key of ['min', 'max']) {
    if (def[key] != null && def[key] !== '' && Number.isFinite(Number(def[key]))) out[key] = Number(def[key]);
  }
  for (const key of Object.keys(def)) {
    if (isExtensionKey(key)) out[key] = def[key];
  }
  return out;
}

/** A list of named fields from an array of `{ name, … }` or a `{ name: def }` map. */
function normalizeCatalogFields(list, opts = {}) {
  if (!list) return [];
  if (Array.isArray(list)) {
    return list.filter((row) => isObject(row) && row.name).map((row) => normalizeCatalogField(row, row.name, opts));
  }
  if (isObject(list)) {
    return Object.entries(list).map(([name, def]) =>
      normalizeCatalogField(isObject(def) ? def : { default: def }, name, opts)
    );
  }
  return [];
}

/** Credentials fields. `secret` is always written; it defaults by type, as in secrets definitions. */
function normalizeCredentialFields(list, { untypedIsSecret = false } = {}) {
  return normalizeCatalogFields(list, { typeDefault: undefined }).map((field) => {
    const out = { ...field };
    if (!out.type) out.type = untypedIsSecret && out.secret !== false ? 'password' : 'string';
    if (out.secret === undefined) out.secret = SECRET_TYPES.has(out.type);
    if (out.secret) delete out.default;
    return out;
  });
}

/** Method options map (`{ name: field }`) from method metadata, flat or wrapped in `options`. */
function catalogMethodOptions(metadata) {
  if (!isObject(metadata)) return {};
  let source = metadata.options;
  if (!isObject(source)) {
    source = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (!METHOD_METADATA_RESERVED.has(k) && isObject(v)) source[k] = v;
    }
  }
  const out = {};
  for (const [name, def] of Object.entries(source)) {
    const field = normalizeCatalogField(isObject(def) ? def : {}, null);
    out[name] = field;
  }
  return out;
}

/** A published method from method metadata, or null when the method is hidden (`display: false`). */
function catalogMethod(metadata) {
  if (!isObject(metadata) || metadata.display === false) return null;
  const out = {};
  if (typeof metadata.description === 'string' && metadata.description) out.description = metadata.description;
  if (metadata.deprecated === true || (typeof metadata.deprecated === 'string' && metadata.deprecated)) {
    out.deprecated = metadata.deprecated;
  }
  const options = catalogMethodOptions(metadata);
  if (Object.keys(options).length) out.options = options;
  return out;
}

/** Method metadata on a worker class's prototype chain; a subclass's method wins. */
function workerMethodMetadata(WorkerConstructor) {
  const methods = {};
  let current = WorkerConstructor?.prototype;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor' || methods[name]) continue;
      const fn = current[name];
      if (typeof fn === 'function' && fn.metadata) methods[name] = fn.metadata;
    }
    current = Object.getPrototypeOf(current);
  }
  return methods;
}

/**
 * The published methods of a worker class: only the names listed (a plugin's
 * `metadata.catalog_methods`). A listed name with no metadata is published with none.
 */
function catalogMethodsOf(WorkerConstructor, names) {
  const all = workerMethodMetadata(WorkerConstructor);
  const out = {};
  for (const name of [...new Set(names || [])].sort()) {
    const fn = WorkerConstructor?.prototype?.[name];
    if (typeof fn !== 'function') continue;
    const method = catalogMethod(all[name] || {});
    if (method) out[name] = method;
  }
  return out;
}

function stringList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function publisherFrom(value) {
  if (isObject(value) && value.name) {
    const out = { name: String(value.name) };
    if (value.url) out.url = String(value.url);
    if (value.email) out.email = String(value.email);
    return out;
  }
  if (typeof value === 'string' && value.trim()) {
    // npm's "Name <email> (url)"
    const m = value.match(/^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?$/);
    if (m) {
      const out = { name: m[1].trim() };
      if (m[3]) out.url = m[3].trim();
      if (m[2]) out.email = m[2].trim();
      return out;
    }
  }
  return null;
}

function submoduleEntry(value) {
  const metadata = value.metadata;
  const out = {};
  if (typeof metadata.description === 'string' && metadata.description) out.description = metadata.description;
  const settings = normalizeCatalogFields(value.settings ?? metadata.settings, { typeDefault: 'string' });
  if (settings.length) out.settings = settings;
  if (typeof value === 'function') {
    const methods = catalogMethodsOf(value, stringList(metadata.catalog_methods));
    if (Object.keys(methods).length) out.methods = methods;
  }
  return out;
}

/**
 * Build the catalog entry for a plugin module (a compiled plugin: default
 * export, with `settings` and `credentials` attached).
 *
 * - `metadata`: name, alias, description, categories, logo, homepage,
 *   publisher, dependencies, catalog_methods. Legacy `metadata.auth_fields`
 *   is read when there is no `credentials` (untyped fields are passwords).
 * - `credentials`: `{ fields, sections? }`, or just the fields.
 * - Each property that is a worker class with `metadata` is a submodule. Its
 *   methods are the ones it names in `metadata.catalog_methods`.
 *
 * @param {{ path: string, plugin: object, packageVersion?: string|null, publisher?: object|string }} opts
 */
function buildPluginCatalogEntry({ path, plugin, packageVersion = null, publisher = null }) {
  if (!path) throw new Error('A plugin path is required to build a catalog entry');
  const mod = plugin || {};
  const metadata = isObject(mod.metadata) ? mod.metadata : {};
  const entry = {
    $schema: PLUGIN_CATALOG_SCHEMA_URL,
    catalog_version: PLUGIN_CATALOG_VERSION,
    path: String(path),
    package: { name: packageNameOf(path), version: packageVersion == null ? null : String(packageVersion) },
    name: String(metadata.name || mod.name || String(path).split('/').pop())
  };
  if (metadata.alias) entry.alias = String(metadata.alias);
  if (metadata.description) entry.description = String(metadata.description);
  const categories = stringList(metadata.categories);
  if (categories.length) entry.categories = categories;
  if (metadata.logo) entry.logo = String(metadata.logo);
  if (metadata.homepage) entry.homepage = String(metadata.homepage);
  const pub = publisherFrom(metadata.publisher) || publisherFrom(publisher);
  if (pub) entry.publisher = pub;
  if (isObject(metadata.dependencies) && Object.keys(metadata.dependencies).length) {
    entry.dependencies = Object.fromEntries(
      Object.entries(metadata.dependencies).map(([k, v]) => [k, String(v)])
    );
  }

  const credentials = mod.credentials ?? metadata.credentials;
  if (credentials) {
    const fields = normalizeCredentialFields(Array.isArray(credentials) ? credentials : credentials.fields ?? credentials);
    if (fields.length) {
      entry.credentials = { fields };
      if (isObject(credentials.sections)) entry.credentials.sections = credentials.sections;
    }
  } else if (isObject(metadata.auth_fields) && Object.keys(metadata.auth_fields).length) {
    entry.credentials = { fields: normalizeCredentialFields(metadata.auth_fields, { untypedIsSecret: true }) };
  }

  const settings = normalizeCatalogFields(mod.settings ?? metadata.settings, { typeDefault: 'string' });
  if (settings.length) entry.settings = settings;

  if (typeof mod === 'function') {
    const methods = catalogMethodsOf(mod, stringList(metadata.catalog_methods));
    if (Object.keys(methods).length) entry.methods = methods;
  }

  const submodules = {};
  for (const key of Object.keys(mod).sort()) {
    if (key === 'metadata' || key === 'settings' || key === 'credentials') continue;
    const value = mod[key];
    if (typeof value !== 'function' || !isObject(value.metadata)) continue;
    const sub = submoduleEntry(value);
    if (Object.keys(sub).length) submodules[key] = sub;
  }
  if (Object.keys(submodules).length) entry.submodules = submodules;
  return entry;
}

/** Relative file for a plugin's entry: `@engine9/plugins/e9email.json`. */
function pluginCatalogFile(pluginPath) {
  const p = String(pluginPath || '');
  if (!PATH_RE.test(p) || p.split('/').includes('..')) throw new Error(`${JSON.stringify(pluginPath)} is not a plugin path`);
  return `${p}.json`;
}

/** `{ path: entry }`, sorted by path. Two entries for one path throw. */
function bundlePluginCatalog(entries) {
  const out = {};
  const list = [...(entries || [])].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  for (const entry of list) {
    if (!entry?.path) throw new Error('A catalog entry has no path');
    if (out[entry.path]) throw new Error(`Two catalog entries for ${entry.path}`);
    out[entry.path] = entry;
  }
  return out;
}

const SECRETS_TYPES = { array: 'json', date: 'string', datetime: 'string' };

/**
 * The secrets definition for a plugin's credentials (secrets.engine9.ai
 * docs/definitions.md), or null when it declares none. Published at the
 * plugin's unversioned definition URL, which secrets follows.
 */
function pluginCredentialsDefinition(entry) {
  const fields = entry?.credentials?.fields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const sections = isObject(entry.credentials.sections) ? entry.credentials.sections : {};
  const definition = {
    id: entry.path,
    label: String(entry.name || entry.path)
  };
  if (entry.description) definition.description = String(entry.description);
  definition.fields = fields
    .filter((field) => !field.deprecated)
    .map((field) => {
      const out = {};
      for (const key of FIELD_KEYS) {
        if (key === 'deprecated' || field[key] === undefined) continue;
        out[key] = field[key];
      }
      if (SECRETS_TYPES[out.type]) out.type = SECRETS_TYPES[out.type];
      if (out.section && sections[out.section]?.label) out.section = String(sections[out.section].label);
      return out;
    });
  return definition;
}

function isUrlOrRootPath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function checkKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key) && !isExtensionKey(key)) errors.push(`${where}: unknown key "${key}"`);
  }
}

function checkField(field, where, errors, warnings, { named = true } = {}) {
  if (!isObject(field)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  checkKeys(field, FIELD_KEYS, where, errors);
  if (named) {
    if (typeof field.name !== 'string' || !FIELD_NAME_RE.test(field.name)) errors.push(`${where}: name must match ${FIELD_NAME_RE}`);
  } else if (field.name !== undefined) {
    errors.push(`${where}: an option's name is its key; leave out "name"`);
  }
  if (field.type !== undefined && !FIELD_TYPES.includes(field.type)) {
    errors.push(`${where}: type "${field.type}" is not one of ${FIELD_TYPES.join(', ')}`);
  }
  for (const key of ['label', 'description', 'help', 'placeholder', 'section', 'pattern']) {
    if (field[key] !== undefined && typeof field[key] !== 'string') errors.push(`${where}: ${key} must be a string`);
  }
  for (const key of ['required', 'hidden', 'secret']) {
    if (field[key] !== undefined && typeof field[key] !== 'boolean') errors.push(`${where}: ${key} must be true or false`);
  }
  if (field.deprecated !== undefined && typeof field.deprecated !== 'boolean' && typeof field.deprecated !== 'string') {
    errors.push(`${where}: deprecated must be true, false or a note`);
  }
  for (const key of ['min', 'max']) {
    if (field[key] !== undefined && !Number.isFinite(field[key])) errors.push(`${where}: ${key} must be a number`);
  }
  if (field.pattern) {
    try {
      new RegExp(field.pattern);
    } catch {
      errors.push(`${where}: pattern is not a regular expression`);
    }
  }
  if (field.values !== undefined) {
    const ok =
      Array.isArray(field.values) &&
      field.values.every((v) => typeof v === 'string' || typeof v === 'number' || (isObject(v) && v.value != null));
    if (!ok) errors.push(`${where}: values must be strings, numbers or { value, label }`);
  }
  if (field.type === 'select' && !(Array.isArray(field.values) && field.values.length)) {
    errors.push(`${where}: a select needs values`);
  }
  const secret = field.secret ?? SECRET_TYPES.has(field.type);
  if (secret && field.default !== undefined) errors.push(`${where}: a secret field has no default`);
}

function checkFieldList(list, where, errors, warnings, seen) {
  if (!Array.isArray(list)) {
    errors.push(`${where}: must be an array of fields`);
    return [];
  }
  list.forEach((field, i) => {
    checkField(field, `${where}[${i}]`, errors, warnings);
    const name = field?.name;
    if (typeof name !== 'string') return;
    if (seen.has(name)) errors.push(`${where}[${i}]: "${name}" is also declared at ${seen.get(name)}`);
    else seen.set(name, `${where}[${i}]`);
  });
  return list;
}

function checkSettings(list, where, errors, warnings, seen) {
  checkFieldList(list, where, errors, warnings, seen).forEach((field, i) => {
    if (field?.secret === true || SECRET_TYPES.has(field?.type)) {
      warnings.push(`${where}[${i}]: "${field.name}" is secret; declare it under credentials, which secrets keeps`);
    }
  });
}

function checkMethods(methods, where, errors, warnings) {
  if (!isObject(methods)) {
    errors.push(`${where}: must be an object of { method: { … } }`);
    return;
  }
  for (const [name, method] of Object.entries(methods)) {
    const at = `${where}.${name}`;
    if (!METHOD_NAME_RE.test(name)) errors.push(`${at}: not a method name`);
    if (!isObject(method)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    checkKeys(method, METHOD_KEYS, at, errors);
    if (method.description !== undefined && typeof method.description !== 'string') errors.push(`${at}: description must be a string`);
    if (method.options === undefined) continue;
    if (!isObject(method.options)) {
      errors.push(`${at}.options: must be an object of { option: field }`);
      continue;
    }
    for (const [option, field] of Object.entries(method.options)) {
      if (!FIELD_NAME_RE.test(option)) errors.push(`${at}.options.${option}: not an option name`);
      checkField(field, `${at}.options.${option}`, errors, warnings, { named: false });
    }
  }
}

/**
 * Check an entry against the standard.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validatePluginCatalogEntry(entry) {
  const errors = [];
  const warnings = [];
  if (!isObject(entry)) return { ok: false, errors: ['An entry must be a JSON object'], warnings };
  checkKeys(entry, ENTRY_KEYS, 'entry', errors);
  if (entry.catalog_version !== PLUGIN_CATALOG_VERSION) errors.push(`catalog_version must be ${PLUGIN_CATALOG_VERSION}`);
  const path = entry.path;
  if (typeof path !== 'string' || !PATH_RE.test(path) || path.length > 214 || path.split('/').includes('..')) {
    errors.push('path must be a plugin path, such as acme-plugins/loyalty or @acme/plugins/loyalty');
  }
  if (!isObject(entry.package)) {
    errors.push('package must be { name, version }');
  } else {
    checkKeys(entry.package, ['name', 'version'], 'package', errors);
    if (typeof entry.package.name !== 'string' || !entry.package.name) errors.push('package.name is required');
    else if (typeof path === 'string' && path !== entry.package.name && !path.startsWith(`${entry.package.name}/`)) {
      errors.push(`path must start with package.name (${entry.package.name})`);
    }
    if (typeof entry.package.version !== 'string' || !VERSION_RE.test(entry.package.version)) {
      errors.push('package.version must be the package release version, such as 1.4.0');
    }
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) errors.push('name is required');
  if (entry.alias !== undefined && (typeof entry.alias !== 'string' || !ALIAS_RE.test(entry.alias))) {
    errors.push(`alias must match ${ALIAS_RE}`);
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') errors.push('description must be a string');
  if (entry.categories !== undefined && !(Array.isArray(entry.categories) && entry.categories.every((c) => typeof c === 'string' && c))) {
    errors.push('categories must be an array of strings');
  }
  for (const key of ['logo', 'homepage']) {
    if (entry[key] !== undefined && !isUrlOrRootPath(entry[key])) errors.push(`${key} must be an https URL or a path starting with /`);
  }
  if (!isObject(entry.publisher)) {
    errors.push('publisher must be { name, url?, email? }');
  } else {
    checkKeys(entry.publisher, ['name', 'url', 'email'], 'publisher', errors);
    if (typeof entry.publisher.name !== 'string' || !entry.publisher.name.trim()) errors.push('publisher.name is required');
    if (entry.publisher.url !== undefined && !isUrlOrRootPath(entry.publisher.url)) errors.push('publisher.url must be an https URL');
  }
  if (entry.bot_path !== undefined && (typeof entry.bot_path !== 'string' || !entry.bot_path)) errors.push('bot_path must be a string');
  if (entry.dependencies !== undefined) {
    if (!isObject(entry.dependencies)) errors.push('dependencies must be { "<plugin path>": "<semver range>" }');
    else {
      for (const [dep, range] of Object.entries(entry.dependencies)) {
        if (!PATH_RE.test(dep)) errors.push(`dependencies: "${dep}" is not a plugin path`);
        if (typeof range !== 'string' || !range) errors.push(`dependencies.${dep}: must be a semver range`);
      }
    }
  }
  if (entry.credentials !== undefined) {
    if (!isObject(entry.credentials)) errors.push('credentials must be { fields, sections? }');
    else {
      checkKeys(entry.credentials, ['fields', 'sections'], 'credentials', errors);
      checkFieldList(entry.credentials.fields, 'credentials.fields', errors, warnings, new Map());
      if (Array.isArray(entry.credentials.fields) && entry.credentials.fields.length === 0) {
        errors.push('credentials.fields is empty; leave credentials out');
      }
      if (entry.credentials.sections !== undefined) {
        if (!isObject(entry.credentials.sections)) errors.push('credentials.sections must be { key: { label, description? } }');
        else {
          for (const [key, section] of Object.entries(entry.credentials.sections)) {
            if (!isObject(section) || typeof section.label !== 'string') errors.push(`credentials.sections.${key}: needs a label`);
          }
        }
      }
    }
  }
  const settingNames = new Map();
  if (entry.settings !== undefined) checkSettings(entry.settings, 'settings', errors, warnings, settingNames);
  if (entry.methods !== undefined) checkMethods(entry.methods, 'methods', errors, warnings);
  if (entry.submodules !== undefined) {
    if (!isObject(entry.submodules)) errors.push('submodules must be { Name: { … } }');
    else {
      for (const [name, sub] of Object.entries(entry.submodules)) {
        const at = `submodules.${name}`;
        if (!SUBMODULE_NAME_RE.test(name)) errors.push(`${at}: not a submodule name`);
        if (!isObject(sub)) {
          errors.push(`${at}: must be an object`);
          continue;
        }
        checkKeys(sub, SUBMODULE_KEYS, at, errors);
        if (sub.description !== undefined && typeof sub.description !== 'string') errors.push(`${at}.description must be a string`);
        if (sub.settings !== undefined) checkSettings(sub.settings, `${at}.settings`, errors, warnings, settingNames);
        if (sub.methods !== undefined) checkMethods(sub.methods, `${at}.methods`, errors, warnings);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export {
  PLUGIN_CATALOG_VERSION,
  PLUGIN_CATALOG_SCHEMA_URL,
  ENTRY_KEYS,
  FIELD_KEYS,
  FIELD_TYPES,
  buildPluginCatalogEntry,
  bundlePluginCatalog,
  catalogMethod,
  catalogMethodsOf,
  normalizeCatalogField,
  normalizeCatalogFields,
  normalizeCredentialFields,
  pluginCatalogFile,
  pluginCredentialsDefinition,
  validatePluginCatalogEntry,
  workerMethodMetadata
};
