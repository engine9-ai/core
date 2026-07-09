/*
  Shared SQL building blocks for Engine9 workers.

  These functions are the canonical implementation of the Engine9 table upsert
  logic.  They are written as prototype-assignable functions (they use `this`
  for worker state: dialect, escaping, describe, query) so both the
  @engine9/server SQLWorker and the @engine9/client SQLWorker use the exact
  same code:

    Worker.prototype.stringToType = sqlShared.stringToType;
    Worker.prototype.buildInsertSql = sqlShared.buildInsertSql;
    Worker.prototype.upsertArray = sqlShared.upsertArray;
    ...

  Required worker surface: this.dialect, this.escapeColumn, this.escapeValue,
  this.escapeTable, this.describe, this.query, this.tables (for error logging).
*/
import debug$0 from 'debug';
import JSON5 from 'json5';
import { bool, diffObjectKeysAcrossSamples } from '../utilities.js';

const debug = debug$0('SQLWorker');
const info = debug$0('info:SQLWorker');

export function onDuplicate() {
  if (this.dialect?.onDuplicate) return this.dialect.onDuplicate();
  return 'on duplicate key update';
}

export function onDuplicateFieldValue(f) {
  if (this.dialect?.onDuplicateFieldValue) return this.dialect.onDuplicateFieldValue(f);
  return `VALUES(${f})`;
}

export function buildInsertSql(options) {
  const worker = this;
  const {
    table,
    columns,
    rows,
    upsert = false,
    ignoreDupes = false,
    // So, returning has an issue in that not all SQL engines support it
    returning = []
  } = options;
  if (columns.length === 0) throw new Error(`no columns provided for table ${table} before createInsert was called`);
  let sql = 'INSERT';
  if (bool(ignoreDupes, false)) {
    sql += ` ${worker.dialect?.insertIgnoreModifier || 'ignore'} `;
  }
  sql += ` into ${table} (${columns.map((v) => worker.escapeColumn(v.name)).join(',')}) values ${rows.join(',')}`;
  if (bool(upsert, false)) {
    sql += ` ${worker.onDuplicate()} ${columns
      .map((column) => {
        const n = worker.escapeColumn(column.name);
        return `${n}=${worker.onDuplicateFieldValue(n)}`;
      })
      .filter(Boolean)
      .join(',')}`;
    // Not everything supports returning fields, but if it does ...
    if (returning?.length > 0) sql += ` returning ${returning.map((d) => this.escapeColumn(d))}`;
  }
  return sql;
}

export function stringToType(_v, _t, length, nullable, defaultValue, nullAsString) {
  const worker = this;
  let t = _t;
  let v = _v;
  t = t.toLowerCase();
  let dt = null;
  switch (t) {
    case 'date':
      if (nullable) {
        if (v === null || v === '') return null;
      }
      dt = new Date(v);
      if (Number.isNaN(dt.getTime())) return null;
      return dt.toISOString().slice(0, 10);
    case 'time':
    case 'datetime':
    case 'datetime2':
    case 'datetimeoffset':
    case 'smalldatetime':
    case 'timestamp':
    case 'timestamp_ntz':
    case 'timestamp without time zone':
      if (v === null && nullable) return null;
      if (v === '' && nullable) return null;
      // this is commented because an undefined date or time is usually a bug on the input
      // if (v === undefined && nullable) return null;
      dt = new Date(v);
      if (Number.isNaN(dt.getTime())) return null;
      return dt.toISOString().slice(0, -5);
    case 'bit':
    case 'int':
    case 'integer':
    case 'bigint':
    case 'smallint':
      if (typeof v === 'bigint') v = Number(v);
      if (v === 0) {
        // we're good
        break;
      }
      if (v === '' || v === undefined || v === 'NULL' || v === null) {
        if (nullable) {
          v = null;
        } else {
          v = defaultValue !== undefined ? defaultValue : 0;
        }
      }
      if (typeof v === 'string') v = v.replace(/[,$]/g, '');
      if (v === parseFloat(v)) v = parseFloat(v);
      break;
    case 'tinyint':
      // blank or undefined is null, or 0 if not nullable
      if (v === '' || v === undefined || v === 'NULL') {
        if (!nullable) v = 0;
        else v = null;
      }
      if (typeof v === 'string') {
        v = v.replace(/[,$]/g, '');
      }
      // for tinyint, it could be a number, so try that first
      if (v === parseFloat(v)) v = parseFloat(v);
      // otherwise it could be a boolean value
      else if (v) {
        v = bool(v);
        // tinyint supports 0 & 1
        v = v ? 1 : 0;
      }
      break;
    case 'text':
    case 'mediumtext':
    case 'enum':
    case 'ntext':
    case 'char':
    case 'varchar':
    case 'nvarchar':
    case 'nvarchar2':
    case 'varchar2':
    case 'character varying': // this is for PostgreSQL
      if (v === '' || v === undefined || (v === 'NULL' && !nullAsString)) {
        if (!nullable) {
          v = '';
        } else v = null;
      } else if (v && length) {
        const type = typeof v;
        if (type === 'object') {
          v = JSON.stringify(v);
        } else if (type === 'string') {
          // it's fine
        } else {
          v = String(v);
        }
        if (v.length > length) {
          if (worker.do_not_slice) {
            /*
                        This is typically used because the Node.js, and MySQL length() functions
                        use a different length for unicode than the column definition,
                        which uses the char_length() variety.
                        */
          } else if (worker.error_on_slice) {
            throw new Error(`Value too long, should be ${length} characters but is ${v.length}:${v}`);
          } else {
            v = v.slice(0, length);
          }
        }
      }
      break;
    case 'decimal':
    case 'float':
    case 'money':
    case 'numeric':
    case 'smallmoney':
    case 'real':
    case 'double':
      if (v === 0) return 0;
      if (v === '' || v === undefined || v === 'NULL') {
        if (!nullable) return 0;
        return null;
      }
      if (typeof v === 'string') v = v.replace(/[,$]/g, '');
      v = parseFloat(v) || 0;
      break;
    case 'jsonb':
      v = typeof v === 'object' ? JSON.stringify(v) : v;
      break;
    default:
  }
  return v;
}

export function getSQLName(n) {
  return n
    .trim()
    .replace(/[^0-9a-zA-Z_-]/g, '_')
    .toLowerCase();
}

/*
  Some standard tables have an id field that is used to increment
*/
export async function upsertArray({ table, array }) {
  if (!Array.isArray(array)) throw new Error('an array is required to upsert');
  if (array.length === 0) return [];
  const desc = await this.describe({ table });
  if (!desc.columns?.length) {
    debug(desc);
    debug('Exising tables:', await this.tables());
    throw new Error(`Error describing ${table}, no columns`);
  }
  // Use the first object to define the columns we're trying to upsert
  // Otherwise we have to do much less efficient per-item updates.
  // If you need to only specify some values, a previous deduplication
  // run should pre-populate the correct values
  const ignore = ['created_at', 'modified_at']; // these are handled by the database, should not be upserted
  const candidateColumns = desc.columns
    .filter((f) => f.name.indexOf('_hidden_') !== 0)
    .filter((f) => ignore.indexOf(f.name) < 0);
  const includedColumnNamesBySample = diffObjectKeysAcrossSamples(array, {
    includeKeys: candidateColumns.map((c) => c.name)
  });
  const includedColumns = candidateColumns.filter((c) => includedColumnNamesBySample.baselineKeys.indexOf(c.name) >= 0);
  if (includedColumnNamesBySample.mismatches.length > 0) {
    info(
      JSON5.stringify(
        {
          table,
          inconsistentIncludedColumnsSamples: includedColumnNamesBySample.samples.map((sample) => ({
            index: sample.index,
            includedColumns: sample.keys,
            object: sample.object
          }))
        },
        null,
        4
      )
    );
    throw new Error(
      `Inconsistent upsert columns for table '${table}'. Upserting objects have different column names, which could lead to inconsistent results. Column differences across sample records: ${JSON.stringify(includedColumnNamesBySample.mismatches)}`
    );
  }
  if (includedColumns.length === 0) {
    debug('Table columns:', desc.columns.map((d) => d.name).join(), 'data columns:', Object.keys(array[0]).join(','));
    throw new Error('The incoming data does not have any attributes that match column names in the database');
  }
  const rows = array.map((o) => {
    const values = includedColumns.map((def) => {
      const val = o[def.name];
      // Auto-increment columns must be NULL (not 0) for the engine to assign
      // an id -- MySQL treats both as "assign next", but SQLite/D1 insert a
      // literal 0, colliding subsequent rows on primary key 0.
      if (def.auto_increment && (val === null || val === undefined || val === '')) return 'NULL';
      let v = null;
      try {
        v = this.stringToType(val, def.column_type, def.length, def.nullable, def.default_value);
        if (v === undefined) throw new Error('undefined returned');
      } catch (e) {
        info(e);
        info('First record used for included columns:', array[0]);
        throw new Error(
          `Error mapping string to value:  Column '${def.name}', type='${def.column_type}': ${e}, attempted val=${val}, object=${JSON.stringify(o, (_k, value) => (typeof value === 'bigint' ? value.toString() : value))}`
        );
      }
      const s = this.escapeValue(v);
      return String(s).replace(/\?/g, '\\u003F');
    });
    return `(${values.join(',')})`;
  });
  const sql = this.buildInsertSql({
    table,
    columns: includedColumns,
    rows,
    upsert: true
    // Returning has an issue in that not all sql engines support it
    // Disable it, you need to get resulting ids in a different way
    // returning,
  });
  try {
    await this.query({ sql, merge: false });
    return array;
  } catch (e) {
    info({
      table,
      includedColumns,
      rows,
      sql
    });
    throw e;
  }
}

export async function upsertTables({ tablesToUpsert }) {
  return Promise.all(
    Object.keys(tablesToUpsert).map((table) => {
      const array = tablesToUpsert[table];
      return this.upsertArray({ table, array });
    })
  );
}

export default {
  onDuplicate,
  onDuplicateFieldValue,
  buildInsertSql,
  stringToType,
  getSQLName,
  upsertArray,
  upsertTables
};
