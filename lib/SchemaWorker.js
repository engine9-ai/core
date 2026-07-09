/*
  Engine9 client schema worker: standardize/diff/deploy interface schemas and
  install plugins into the plugin table.

  Mirrors the server SchemaWorker's deploy pipeline, but resolves schemas from
  the static registry in ./schemas.js (bundler-friendly, works on Cloudflare
  Workers) instead of the filesystem.  Unknown @engine9/interfaces/* names fall
  back to fetching from GitHub, which also works in Workers.
*/
import debug$0 from 'debug';
import JSON5 from 'json5';
import SQLWorker from './SQLWorker.js';
import { SCHEMAS, STANDARD_INSTALL_SCHEMAS } from './schemas.js';
import { getPluginUUID, getVersionedUUID } from './ids.js';

const debug = debug$0('client:SchemaWorker');

function Worker(config) {
  SQLWorker.call(this, config);
}
Worker.prototype = Object.create(SQLWorker.prototype);
Worker.prototype.constructor = Worker;

const defaultStandardColumn = {
  name: '',
  type: '',
  length: null,
  nullable: true,
  default_value: undefined, // null would actually mean something here
  auto_increment: false
};

Worker.prototype.resolveSchema = async function (_schema) {
  if (typeof _schema === 'object') return _schema;
  if (typeof _schema !== 'string') throw new Error('schema is required');
  const name = _schema.replace(/^local\$/, '');
  if (SCHEMAS[name]) return SCHEMAS[name];
  if (name.indexOf('@engine9/interfaces/') === 0) {
    const shortName = name.slice('@engine9/interfaces/'.length);
    if (!shortName.match(/^[a-z0-9_/-]+$/)) throw new Error('Invalid schema name');
    const uri = `https://raw.githubusercontent.com/engine9-io/interfaces/main/${shortName}/schema.js`;
    debug('Schema not in static registry, fetching', uri);
    const r = await fetch(uri);
    if (r.status >= 300) throw new Error(`Could not find schema ${_schema}`);
    let content = (await r.text()).trim();
    if (content.indexOf('module.exports = ') === 0) content = content.slice(17);
    if (content.slice(-1) === ';') content = content.slice(0, -1);
    try {
      return JSON5.parse(content);
    } catch (error) {
      throw new Error(`Error attempting to parse schema file at ${_schema}, ${error.message}`);
    }
  }
  throw new Error(`Unknown schema ${_schema} -- not in the client schema registry`);
};

Worker.prototype.standardize = async function ({ schema: _schema }) {
  if (!_schema) throw new Error('schema is required');
  const schema = await this.resolveSchema(_schema);
  await this.connect(); // dialect may be lazily set for mysql connections
  // Deep copy, clearing out functions -- this method is for database work
  const standardSchema = structuredClone({ tables: schema.tables || [] });
  const invalidTables = [];
  standardSchema.tables = (standardSchema.tables || [])
    .map((table) => {
      const invalidColumns = [];
      const columns = table.columns || [];
      table.columns = Object.keys(columns)
        .map((key) => {
          let col = columns[key];
          if (typeof col === 'string') col = { type: col };
          let name = key;
          if (Array.isArray(columns)) name = col.name;
          if (col.column_type) {
            invalidColumns.push({ ...col, name, error: 'column_type is reserved for sql dialect' });
          }
          const typeDetails = this.dialect.getType(col.type) || {};
          return {
            ...defaultStandardColumn,
            ...typeDetails,
            ...col,
            name
          };
        })
        .filter(Boolean);
      if (invalidColumns.length > 0) {
        invalidTables.push({ ...table }, { invalidColumns });
        return false;
      }
      table.indexes = (table.indexes || []).map((d) => ({
        columns: typeof d.columns === 'string' ? d.columns.split(',').map((x) => x.trim()) : d.columns,
        primary: d.primary || false,
        unique: d.unique || d.primary || false
      }));
      return table;
    })
    .filter(Boolean);
  if (invalidTables.length > 0) {
    throw new Error('Invalid table definitions: ' + invalidTables.map((d) => JSON.stringify(d)));
  }
  return standardSchema;
};

Worker.prototype.diff = async function (opts) {
  const schema = await this.standardize(opts);
  const { prefix = '' } = opts;
  if (prefix && prefix.slice(-1) !== '_') throw new Error(`A prefix should end with '_', it is ${prefix}`);
  const diffTables = await Promise.all(
    schema.tables.map(async (tableDefinition) => {
      const { name: table, columns: schemaColumns = [], indexes: schemaIndexes = [] } = tableDefinition;
      // A table can opt out of the plugin prefix with `prefix: false` in the schema
      const tablePrefix = tableDefinition.prefix === false ? '' : prefix;
      let desc = null;
      try {
        desc = await this.describe({ table: tablePrefix + table });
      } catch (e) {
        if (e?.code === 'DOES_NOT_EXIST') {
          tableDefinition.differences = ['missing'];
          return tableDefinition;
        }
        throw e;
      }
      if (!desc.columns) throw new Error('No columns in describe table');
      const indexes = await this.indexes({ table: tablePrefix + table });
      const missingIndexes = schemaIndexes.filter(
        (x) =>
          !indexes.find((tableIndex) => {
            if (x.unique !== tableIndex.unique) return false;
            if (!Array.isArray(x.columns)) throw new Error('Non-array columns in indexes');
            if (x.columns.join() !== tableIndex.columns.join()) return false;
            return true;
          })
      );
      const dbLookup = desc.columns.reduce((o, col) => Object.assign(o, { [col.name]: col }), {});
      const columnDifferences = schemaColumns
        .map((c) => {
          const dbColumn = dbLookup[c.name];
          if (!dbColumn) return { differences: 'new', ...c };
          // legacy hack -- don't change this column by hand
          if (c.name === 'source_code_id') return null;
          const differenceKeys = Object.keys(c).reduce((out, k) => {
            if (['type', 'description', 'knex_method', 'knex_args', 'values'].indexOf(k) >= 0) return out;
            // enum/json lengths are not really standardized
            if (c.type === 'enum' && k === 'length') return out;
            if (c.type === 'json' && k === 'length') return out;
            if (k === 'default_value') {
              // databases coerce undefined to NULL default values
              if (dbColumn[k] === null && c[k] === undefined) return out;
            }
            if ((c[k] || dbColumn[k]) && c[k] !== dbColumn[k]) {
              out[k] = { schema: c[k], db: dbColumn[k] };
            }
            return out;
          }, {});
          if (Object.keys(differenceKeys).length > 0) {
            return { differences: differenceKeys, ...c };
          }
          return null;
        })
        .filter(Boolean);
      const out = { name: table, differences: [] };
      if (tableDefinition.prefix === false) out.prefix = false;
      if (columnDifferences.length > 0) {
        out.differences.push('columns');
        out.columns = columnDifferences;
      }
      if (missingIndexes.length > 0) {
        out.differences.push('indexes');
        out.indexes = missingIndexes;
      }
      if (out.differences.length === 0) return null;
      return out;
    })
  );
  const tables = diffTables.filter(Boolean);
  return { tables };
};

Worker.prototype.deploy = async function (opts) {
  const worker = this;
  const { tables } = await this.diff(opts);
  if (tables.length === 0) return { no_changes: true };
  const { prefix = '' } = opts;
  debug(`Deploying ${tables.length} tables`);
  async function processTable(tableDefinition) {
    const { name: table, type, differences, columns = [], indexes = [] } = tableDefinition;
    if (!table) throw new Error('Invalid definition of table, no name');
    const tablePrefix = tableDefinition.prefix === false ? '' : prefix;
    const diffs = Array.isArray(differences) ? differences : [differences];
    return Promise.all(
      diffs.map(async (difference) => {
        if (difference === 'missing') {
          if (type === 'view') return worker.createView(tableDefinition);
          debug(`Creating table ${tablePrefix}${table}`);
          return worker.createTable({ table: tablePrefix + table, columns, indexes });
        }
        if (difference === 'columns' || difference === 'indexes') {
          const databaseType = await worker.tableType({ table: tablePrefix + table });
          if (databaseType === 'view') return { name: table, difference, did_nothing_because_view: true };
          debug(`Altering table ${tablePrefix}${table} with difference: ${difference}`);
          if (difference === 'columns') return worker.alterTable({ table: tablePrefix + table, columns });
          return worker.alterTable({ table: tablePrefix + table, indexes });
        }
        return { table, difference, did_nothing: true };
      })
    );
  }
  const output = await Promise.all(tables.filter((d) => d.type !== 'view').map(processTable));
  const views = await Promise.all(tables.filter((d) => d.type === 'view').map(processTable));
  return { tables: output.concat(views) };
};

function accountScopedPluginId(worker, pluginPath) {
  return getPluginUUID(`engine9.${worker.accountId}`, pluginPath);
}

/*
  Install a plugin: insert/find the plugin row and deploy its schema.
  The client supports interface schemas from the static registry and inline
  local plugins (type:'local' with an explicit id and schema object).  Dynamic
  plugin compilation (@engine9/plugins/*) is server-only.
*/
Worker.prototype.install = async function (options) {
  let { id, type, path: pluginPath, name, schema, remote_plugin_id } = options;
  if (!pluginPath)
    throw new Error("A path is required, either 'local' for an inline plugin, or an @engine9/interfaces path");
  if (type === 'local') {
    if (typeof schema === 'string') throw new Error('For local paths, schema must be an object');
    if (!id) throw new Error('For local paths, you must specify an id');
  }
  const isInterface = pluginPath.indexOf('@engine9/interfaces/') === 0;
  if (!isInterface && type !== 'local' && !schema && !SCHEMAS[pluginPath]) {
    throw new Error(`The client can only install @engine9/interfaces/* schemas or local plugins, not ${pluginPath}`);
  }
  if (!id && type !== 'local' && !isInterface) {
    id = accountScopedPluginId(this, pluginPath);
  }
  let installedPlugins = [];
  ({ data: installedPlugins } = await this.query({
    sql: 'select * from plugin where path=? order by created_at',
    values: [pluginPath]
  }));
  if (installedPlugins.length === 0 && id) {
    ({ data: installedPlugins } = await this.query({ sql: 'select * from plugin where id=?', values: [id] }));
  }
  let plugin = installedPlugins[0] || {};
  let prefix = installedPlugins[0]?.table_prefix;
  if (installedPlugins.length === 0) {
    // Interfaces deploy without a table prefix
    prefix = '';
    schema = schema || SCHEMAS[pluginPath];
    plugin = {
      id: id || getVersionedUUID(),
      path: pluginPath,
      name: name || pluginPath.split('/').pop(),
      table_prefix: prefix,
      remote_plugin_id: remote_plugin_id ?? null
    };
    if (schema && typeof schema === 'object') {
      // functions can't be serialized -- store only table structure
      plugin.schema = JSON.stringify({ tables: structuredClone(schema.tables || []) });
    }
    const columns = Object.keys(plugin);
    const desc = await this.describe({ table: 'plugin' });
    const insertable = desc.columns.filter((c) => columns.indexOf(c.name) >= 0);
    const row = `(${insertable
      .map((def) => {
        const v = this.stringToType(plugin[def.name], def.column_type, def.length, def.nullable, def.default_value);
        return String(this.escapeValue(v)).replace(/\?/g, '\\u003F');
      })
      .join(',')})`;
    const sql = this.buildInsertSql({
      table: 'plugin',
      columns: insertable,
      rows: [row],
      ignoreDupes: true
    });
    await this.query({ sql });
  }
  plugin.tablePrefix = prefix;
  if (!schema) schema = SCHEMAS[pluginPath];
  if (schema) await this.deploy({ schema, prefix: prefix || '' });
  const out = { ...plugin };
  delete out.table_prefix;
  return out;
};

/*
  Bootstrap a database from scratch: deploy the plugin schema first so the
  plugin table exists, then install every standard interface schema.
*/
Worker.prototype.installStandard = async function () {
  await this.deploy({ schema: '@engine9/interfaces/plugin' });
  const results = [];
  for (const path of STANDARD_INSTALL_SCHEMAS) {
    results.push(await this.install({ path }));
  }
  return { complete: true, installed: results.map((p) => p.path) };
};

export { STANDARD_INSTALL_SCHEMAS };
export default Worker;
