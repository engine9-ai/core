/*
  Database schema worker: load an interface schema, standardize it, diff against
  live tables, and create/alter tables.

  Plugin install (plugin rows, native compile, prefixes, stacks, bootstrap)
  lives on PluginWorker, which extends this class and calls deploy().
*/
import debug$0 from 'debug';
import JSON5 from 'json5';
import SQLWorker from './SQLWorker.js';
import { ObjectError } from './utilities.js';
import { normalizePluginInstallPath } from './pluginPaths.js';
import { standardizeSchema } from './sql/standardizeSchema.js';

const debug = debug$0('SchemaWorker');

function Worker(config = {}) {
  SQLWorker.call(this, config);
}
Worker.prototype = Object.create(SQLWorker.prototype);
Worker.prototype.constructor = Worker;
Worker.metadata = {
  alias: 'schema'
};

function resolvePluginModuleFn(worker) {
  return worker.resolvePluginModule || Worker.resolvePluginModule;
}

Worker.prototype.compilePlugin = async function ({ path, source } = {}) {
  const packagePath = normalizePluginInstallPath(path);
  const resolve = resolvePluginModuleFn(this);
  if (typeof resolve === 'function') {
    const { resolvedFsEntry, href } = await resolve({ path: packagePath, source });
    const mod = await import(href);
    const plugin = Object.assign({}, mod.default || mod);
    plugin.path = packagePath;
    plugin.resolvedFsEntry = resolvedFsEntry;
    [].concat(Object.values(plugin.transforms || {}))
      .filter(Boolean)
      .forEach((f) => {
        f.path = packagePath;
      });
    return plugin;
  }
  const spec = source || `${packagePath}/index.js`;
  const mod = await import(spec);
  const plugin = Object.assign({}, mod.default || mod);
  plugin.path = packagePath;
  return plugin;
};

Worker.prototype.resolveLocalSchemaPath = async function (schema) {
  if (!schema) throw new Error(`Could not resolve local schema path for schema:${schema}`);
  const { default: path } = await import('node:path');
  const fs = await import('node:fs');
  const base = path.resolve(process.cwd());
  const localPath =
    path.isAbsolute(schema) || path.extname(schema)
      ? path.isAbsolute(schema)
        ? path.resolve(schema)
        : path.resolve(base, schema)
      : path.resolve(base, `${schema}${schema.slice(-1) === '/' ? '' : '/'}schema.js`);
  await fs.promises.access(localPath, fs.constants.R_OK);
  return localPath;
};

Worker.prototype.standardize = async function ({ schema: _schema, source } = {}) {
  if (!_schema) throw new Error('schema is required');
  await this.connect();
  let schema = null;
  if (typeof _schema === 'object') {
    schema = _schema;
  } else if (typeof _schema === 'string') {
    const packagePath = normalizePluginInstallPath(_schema);
    if (packagePath.startsWith('@engine9/')) {
      const resolve = resolvePluginModuleFn(this);
      if (typeof resolve === 'function') {
        const { resolvedFsEntry, href } = await resolve({
          path: packagePath,
          source,
          entry: 'schema'
        });
        debug('Loading schema module:', resolvedFsEntry);
        const schemaMod = await import(href);
        schema = Object.assign({}, schemaMod.default);
      } else {
        const schemaMod = await import(`${packagePath}/schema.js`);
        schema = Object.assign({}, schemaMod.default);
      }
    } else {
      debug('schema is a filesystem path, trying local file');
      const fs = await import('node:fs');
      const { pathToFileURL } = await import('node:url');
      const content = (await fs.promises.readFile(await this.resolveLocalSchemaPath(_schema))).toString().trim();
      let parsed = content;
      if (parsed.indexOf('module.exports = ') === 0) {
        parsed = parsed.slice(17);
      }
      if (parsed.slice(-1) === ';') {
        parsed = parsed.slice(0, -1);
      }
      try {
        schema = JSON5.parse(parsed);
      } catch (error) {
        try {
          const p = await this.resolveLocalSchemaPath(_schema);
          const schemaMod = await import(pathToFileURL(p).href);
          schema = Object.assign({}, schemaMod.default);
        } catch {
          debug(content);
          throw new Error(`Error attempting to parse schema file at ${_schema}, ${error.message}`);
        }
      }
    }
  }
  try {
    return standardizeSchema(schema, this.dialect);
  } catch (e) {
    debug('Invalid parsed schema:', schema);
    throw e;
  }
};
Worker.prototype.standardize.metadata = {
  options: {
    schema: { description: 'Schema object,file path, or @engine9/interfaces/<interface_name>' }
  }
};

Worker.prototype.diff = async function (opts) {
  const schema = await this.standardize(opts);
  const { prefix = '' } = opts;
  if (prefix && prefix.slice(-1) !== '_') throw new Error(`A prefix should end with '_', it is ${prefix}`);
  const diffTables = await Promise.all(
    schema.tables.map(async (tableDefinition) => {
      const { name: table, columns: schemaColumns = [], indexes: schemaIndexes = [] } = tableDefinition;
      const tablePrefix = tableDefinition.prefix === false ? '' : prefix;
      debug(`Checking table ${table}`);
      let desc = null;
      try {
        desc = await this.describe({ table: tablePrefix + table });
      } catch (e) {
        if (e?.code === 'DOES_NOT_EXIST') {
          desc = { columns: [], indexes: [] };
          tableDefinition.differences = ['missing'];
          return tableDefinition;
        }
        throw e;
      }
      if (!desc.columns) {
        debug(desc);
        throw new Error('No columns in describe table');
      }
      const indexes = await this.indexes({ table: tablePrefix + table });
      const missingIndexes = schemaIndexes.filter(
        (x) =>
          !indexes.find((tableIndex) => {
            if (x.unique !== tableIndex.unique) return false;
            if (!Array.isArray(x.columns)) throw new Error('Non-array columns in indexes', schema);
            if (x.columns.join() !== tableIndex.columns.join()) return false;
            return true;
          })
      );
      const dbLookup = desc.columns.reduce((o, col) => Object.assign(o, { [col.name]: col }), {});
      const columnDifferences = schemaColumns
        .map((c) => {
          const dbColumn = dbLookup[c.name];
          if (!dbColumn) return { differences: 'new', ...c };
          if (c.name === 'source_code_id') return null;
          const differenceKeys = Object.keys(c).reduce((out, k) => {
            if (['type', 'description', 'knex_method', 'knex_args', 'values'].indexOf(k) >= 0) return out;
            if (c.type === 'enum' && k === 'length') return out;
            if (c.type === 'json' && k === 'length') return out;
            if (k === 'default_value') {
              if (dbColumn[k] === null && c[k] === undefined) {
                return out;
              }
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
  debug(`Returning ${tables.length} diff tables for schema ${opts.schema}`);
  return { tables };
};
Worker.prototype.diff.metadata = {
  options: {
    table: {},
    schema: { description: 'Either a schema object, or a path to a schema file' }
  }
};

Worker.prototype.deploy = async function (opts) {
  const worker = this;
  const { tables } = await this.diff(opts);
  if (tables.length === 0) return { no_changes: true };
  const { prefix = '' } = opts;
  debug(`Deploying ${tables.length} tables, including`, JSON.stringify(tables[0], null, 4));
  async function processTable(tableDefinition) {
    const { name: table, type, differences, columns = [], indexes = [] } = tableDefinition;
    if (!table) {
      debug(tableDefinition);
      throw new Error('Invalid definition of table, no name');
    }
    const tablePrefix = tableDefinition.prefix === false ? '' : prefix;
    const diffs = Array.isArray(differences) ? differences : [differences];
    const diffResults = await Promise.all(
      diffs.map(async (difference) => {
        if (difference === 'missing') {
          if (type === 'view') {
            return worker.createView(tableDefinition);
          }
          debug(`Creating table ${tablePrefix}${table}`);
          return worker.createTable({ table: tablePrefix + table, columns, indexes });
        }
        if (difference === 'columns') {
          const databaseType = await worker.tableType({ table: tablePrefix + table });
          if (databaseType === 'view') return { name: table, difference, did_nothing_because_view: true };
          debug(`Altering table ${tablePrefix}${table} with difference: ${difference}`);
          return worker.alterTable({ table: tablePrefix + table, columns });
        }
        if (difference === 'indexes') {
          const databaseType = await worker.tableType({ table: tablePrefix + table });
          if (databaseType === 'view') return { name: table, difference, did_nothing_because_view: true };
          debug(`Altering table ${tablePrefix}${table} with difference: ${difference}`);
          return worker.alterTable({ table: tablePrefix + table, indexes });
        }
        return { table, difference, did_nothing: true };
      })
    );
    return diffResults;
  }
  const output = await Promise.all(tables.filter((d) => d.type !== 'view').map(processTable));
  const views = await Promise.all(tables.filter((d) => d.type === 'view').map(processTable));
  return { tables: output.concat(views) };
};
Worker.prototype.deploy.metadata = {
  options: {
    schema: { description: 'Either a schema object, or a path to a schema file' }
  }
};

export default Worker;
export { ObjectError };
