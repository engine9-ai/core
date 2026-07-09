import mysql from 'mysql2';
import debug$0 from 'debug';
import BinaryTypes from './MySQLBinaryTypes.js';
const debug = debug$0('MySQLSchema');
export const types = [
  {
    type: 'id',
    column_type: 'bigint',
    nullable: false,
    auto_increment: true,
    knex_method: 'bigIncrements'
  },
  {
    // person id is a very specific foreign id
    // person_id type definition is ALWAYS the same, regardless if it's a primary key or not
    // that way we never have to deal with null cases, and different platforms can rely on it having
    // a non-null value
    // Even though there's situations where it's not set, that value is then 0
    type: 'person_id',
    column_type: 'bigint',
    nullable: false,
    default_value: 0,
    knex_method: 'bigint'
  },
  {
    // foreign ids can be nullable
    type: 'foreign_id',
    column_type: 'bigint',
    nullable: true,
    knex_method: 'bigint'
  },
  {
    type: 'source_code_id',
    column_type: 'bigint',
    nullable: false,
    default_value: 0,
    knex_method: 'bigint'
  },
  {
    // A string identifier, similar to a string,
    // but can't be null, defaults to '', 64 chars to join with hashes
    type: 'id_string',
    column_type: 'varchar',
    length: 128, // 64 is just way too small for the ids we use
    nullable: false,
    default_value: '',
    knex_method: 'string',
    knex_args: (o) => [o.length || 255]
  },
  {
    // A uuid identifier, similar to a string, but can't be null
    type: 'id_uuid',
    column_type: 'uuid',
    knex_method: 'specificType',
    knex_args: () => ['uuid'],
    nullable: false
  },
  {
    type: 'string',
    column_type: 'varchar',
    length: 255,
    knex_method: 'string',
    knex_args: (o) => [o.length || 255]
  },
  {
    type: 'hash',
    column_type: 'varchar',
    length: 64,
    nullable: false,
    default_value: '',
    knex_method: 'string',
    knex_args: (o) => [o.length || 64]
  },
  { type: 'int', column_type: 'int', knex_method: 'integer' },
  { type: 'bigint', column_type: 'bigint', knex_method: 'bigint' },
  /* decimal(19,2) is chosen for currency
    as 4 digit currencies are rare enough to warrant another type */
  {
    type: 'currency',
    column_type: 'decimal(19,2)',
    knex_method: 'decimal',
    knex_args: [19, 2]
  },
  {
    type: 'decimal',
    column_type: 'decimal',
    knex_method: 'decimal',
    knex_args: () => [19, 4]
  },
  { type: 'float', column_type: 'float', knex_method: 'float' },
  { type: 'double', column_type: 'double', knex_method: 'double' },
  {
    type: 'boolean',
    column_type: 'tinyint',
    // nullable: true, //don't set this, otherwise we can't look up type boolean
    //  Defaults to nullable anyhow
    knex_method: 'boolean'
  },
  {
    type: 'text',
    column_type: 'text',
    length: 65535,
    knex_method: 'text'
  },
  {
    type: 'json',
    column_type: 'json',
    knex_method: 'json'
  },
  {
    type: 'created_at',
    column_type: 'timestamp',
    default_value: 'current_timestamp()',
    nullable: false,
    knex_method: 'timestamp',
    knex_default_raw: 'current_timestamp()'
  },
  {
    type: 'modified_at',
    column_type: 'timestamp',
    default_value: 'current_timestamp() on update current_timestamp()',
    nullable: false,
    knex_method: 'timestamp',
    knex_default_raw: 'current_timestamp() on update current_timestamp()'
  },
  {
    type: 'url',
    column_type: 'text',
    length: 65535,
    knex_method: 'text'
  },
  { type: 'date', column_type: 'date', knex_method: 'date' },
  { type: 'datetime', column_type: 'datetime', knex_method: 'datetime' },
  { type: 'timestamp', column_type: 'timestamp', knex_method: 'timestamp' },
  { type: 'time', column_type: 'time', knex_method: 'time' },
  {
    type: 'enum',
    column_type: 'enum',
    knex_method: 'enu',
    knex_args: (o) => {
      if (!o.values || o.values.length === 0) throw new Error(`No values provided for enum type:${JSON.stringify(o)}`);
      return [o.values];
    }
  },
  // foreign ids can be nullable
  {
    type: 'foreign_uuid',
    column_type: 'uuid',
    // knex_method: 'uuid', //this often defaults to char(36), so use specific type
    knex_method: 'specificType',
    knex_args: () => ['uuid'],
    nullable: true
  },
  {
    type: 'uuid',
    column_type: 'uuid',
    // knex_method: 'uuid', //this often defaults to char(36)
    knex_method: 'specificType',
    knex_args: () => ['uuid']
  }
];
function isInt(s) {
  return Number.isInteger(typeof s === 'number' ? s : parseFloat(s));
}
export const name = 'MySQL';
export function getType(type) {
  return types.find((t) => t.type === type);
}
export const charset = 'utf8mb4';
export const collation = 'utf8mb4_general_ci';
export function getTableCharacterSetSpecification() {
  return 'CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
}
export function getLastIdConfig(sqlVersion) {
  let supportsReturning = true;
  const lastInsertIdSQL = 'LAST_INSERT_ID()';
  if (sqlVersion.indexOf('8.') === 0) {
    supportsReturning = false;
  }
  return {
    supportsReturning,
    lastInsertIdSQL
  };
}
export function standardToKnex(col, sqlVersion) {
  // return {method,args} for knex
  // The name of the knex methods is ... inconsistent
  let { type } = col;
  if (type === 'string' && col.max_length > 255) type = 'text';
  const typeDef = types.find((t) => t.type === type);
  if (!typeDef) throw new Error(`Could not find mysql type ${type}`);
  let { nullable } = col;
  if (nullable === undefined) {
    nullable = typeDef.nullable;
  }
  if (nullable === undefined) {
    nullable = true;
  }
  if (!sqlVersion) {
    throw new Error('sqlVersion required for MySQL dialect');
  }
  // MySQL version 8. doesn't support UUID type
  if (typeDef.column_type === 'uuid') {
    if (sqlVersion.indexOf('8.') === 0) {
      debug(`Version 8. specified, not using uuid, using char(36) for column ${col.name}`);
      typeDef.knex_method = 'specificType';
      typeDef.knex_args = () => ['char(36)'];
    }
  }
  return {
    method: typeDef.knex_method,
    args: typeof typeDef.knex_args === 'function' ? typeDef.knex_args(col) : typeDef.knex_args || [],
    unsigned: typeDef.unsigned || false,
    nullable,
    default_value: col.default_value !== undefined ? col.default_value : typeDef.knex_default,
    // raw values should always be defined strings in this file, not a function
    defaultRaw: typeDef.knex_default_raw
  };
}
export function dialectToStandard(o, defaultColumn) {
  const { name, type, decimals, length, column_type, default_value, nullable, auto_increment, extra, constraints } = o;
  const input = {
    name,
    type,
    decimals,
    length,
    column_type,
    default_value,
    nullable,
    auto_increment,
    extra,
    constraints,
    ...defaultColumn
  };
  //const input = { ...o, ...defaultColumn };
  if (name === 'id_value') {
    console.error('debug');
  }
  if (typeof input.type === 'number') {
    //this might be a binary lookup
    input.column_type = BinaryTypes[input.type].toLowerCase();
  }
  if (input.extra) {
    // This is a bit ugly, should be pushed to the
    if (input.default_value?.toLowerCase().indexOf('current_timestamp') === 0)
      input.default_value = 'current_timestamp()';
    if (input.extra?.toLowerCase().indexOf('on update current_timestamp') >= 0)
      input.default_value = `${input.default_value || ''} ${'on update current_timestamp()'}`.trim();
    delete input.extra;
  }
  if (input.column_type === 'json') {
    input.type = 'json';
  }
  // test first for strings
  if (
    input.column_type.indexOf('varchar') === 0 ||
    input.column_type.indexOf('var_string') === 0 ||
    input.column_type === 'text' ||
    input.column_type === 'mediumtext' ||
    input.column_type === 'longtext' ||
    input.column_type === 'medium_blob' ||
    input.column_type === 'long_blob'
  ) {
    // so, some systems don't support json, so treat longtext as the same
    if (constraints?.startsWith('json_valid(')) {
      input.type = 'json';
      input.column_type = 'json';
    } else {
      // this is a string, which can have all the variations
      input.type = 'string';
      input.column_type = input.column_type.split('(')[0];
    }
    if (input.default_value && typeof input.default_value === 'string' && input.default_value.match(/^'.*'$/)) {
      input.default_value = input.default_value.slice(1, -1);
    }
    return { ...input, ...types.find((t) => t.type === 'string'), ...input };
  }
  if (input.column_type.indexOf('enum') === 0) {
    // example enum('','remote_person_id','email_hash_v1','phone_hash_v1')
    input.values = input.column_type
      .slice(5, -1)
      .split(',')
      .map((d) => d.slice(1, -1));
    input.column_type = 'enum';
    if (input.default_value && typeof input.default_value === 'string' && input.default_value.match(/^'.*'$/)) {
      input.default_value = input.default_value.slice(1, -1);
    }
  }
  if (input.column_type.slice(-9).toLowerCase() === ' unsigned') {
    input.column_type = input.column_type.slice(0, -9);
    input.unsigned = true;
  }
  if (input.column_type.indexOf('tiny') === 0) {
    input.column_type = 'tinyint';
  }
  if (input.column_type.indexOf('bigint') === 0) {
    input.column_type = 'bigint';
  }
  if (input.column_type === 'char(36)') {
    // so, some systems don't support uuid, so treat char(36) as the same
    input.column_type = 'uuid';
    input.length = null;
  }
  if (
    input.column_type.indexOf('short') === 0 ||
    input.column_type.indexOf('int') === 0 ||
    input.column_type.indexOf('smallint') === 0 // smallint isn't small enough to matter significantly
  ) {
    input.column_type = 'int';
  }
  if (input.column_type.indexOf('float') === 0) {
    input.column_type = 'float';
  }
  if (input.column_type.indexOf('decimal') === 0) {
    input.column_type = 'decimal(19,2)';
  }
  /* some engines have commented out descriptions */
  if (input.column_type.indexOf('/*') > 0) {
    [input.column_type] = input.column_type.split(' ');
  }
  const log = [];
  const typeDef = types.find((type) => {
    const unmatchedAttributes = Object.keys(type)
      .map((attr) => {
        if (attr === 'type' || attr.indexOf('knex_') === 0) return false; // ignore these
        if (type[attr] === input[attr]) {
          return false;
        }
        return `${attr}:${type[attr]} !== ${input[attr]}`;
      })
      .filter(Boolean);
    if (unmatchedAttributes.length > 0) {
      log.push({ type: type.type, unmatchedAttributes });
      return false;
    }
    return true;
  });
  if (!typeDef) {
    throw new Error(
      `dialectToStandard: Could not find column type that matches ${JSON.stringify(input.column_type)} \n${log
        .map((s) => JSON.stringify(s))
        .join('\n')}`
    );
  }
  const output = Object.assign(input, typeDef);
  return output;
}
export function escapeColumn(value) {
  return mysql.escapeId(value);
}
export function escapeValue(value) {
  return mysql.escape(value);
}
export function addLimit(_sql, limit, offset) {
  if (!limit) return _sql;
  let sql = _sql;
  // make sure it's an integer, and defined
  if (isInt(limit)) {
    sql += ` limit ${limit}`;
    if (offset) sql += ` offset ${offset}`;
  } else if (limit) {
    throw new Error(`Invalid limit:${limit}`);
  }
  return sql;
}
const moduleExports = {
  name,
  getType,
  charset,
  collation,
  getTableCharacterSetSpecification,
  getLastIdConfig,
  standardToKnex,
  dialectToStandard,
  escapeColumn,
  escapeValue,
  addLimit,
  supportedFunctions() {
    const scope = this;
    const columnNameMatch = /^[a-zA-Z0-9_]+$/;
    function escapeColumn(t) {
      if (!t.match(columnNameMatch)) throw new Error(`Invalid column name: ${t}`);
      return t;
    }
    this.getDayFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATE(${column})`;
    };
    this.getQuarterFunction = function (_column, skipEscape) {
      let column = _column;
      // Works on legacy SQLServer and modern
      if (!skipEscape) column = this.escapeColumn(column);
      return `CONCAT(YEAR(${column}),'-Q',QUARTER(${column}))`;
    };
    this.getStartOfQuarterFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `MAKEDATE(YEAR(${column}), 1) + INTERVAL QUARTER(${column})-1 QUARTER`;
    };
    this.getDateIntervalFunction = function (column, days) {
      return `${this.escapeColumn(column)}+ interval ${days} day`;
    };
    this.getHourIntervalFunction = function (column, hours) {
      return `${this.escapeColumn(column)}+ interval ${hours} hour`;
    };
    // Short date function -- particularly for
    // Google that mishandles date/datetime types in mysql, and needs YYYYMMDD format
    this.getShortDateFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATE_FORMAT(${column},'%Y%m%d')`;
    };
    this.getWeekFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `FROM_DAYS(TO_DAYS(${column}) -MOD(TO_DAYS(${column}) -1, 7))`;
    };
    this.getMonthNameFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `MONTHNAME(${column})`;
    };
    /*
          Gets the timezone, defaults to the timezone from this bot
          */
    this.getTimezoneFunction = function (_column, timezone, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      const tz = timezone || (this.auth || {}).timezone || 'America/New_York';
      return `CONVERT_TZ(${column},'UTC',${this.escapeValue(tz)})`;
    };
    this.getMonthFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `DATE_ADD(LAST_DAY(DATE_SUB(${column}, interval 31 day)), interval 1 day)`;
    };
    this.getStartOfYearFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `CONCAT(YEAR(${column}),'-01-01')`;
    };
    this.getYearFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = this.escapeColumn(column);
      return `YEAR(${column})`;
    };
    /* Calculate the fiscal year from a date */
    this.getFiscalYearFunction = function (_column, fiscalYear, skipEscape) {
      let column = _column;
      if (!fiscalYear) return scope.getYearFunction(column, skipEscape);
      const { month, day } = scope.getFiscalYearUtilities(fiscalYear);
      if (month === 1 && day === 1) return scope.getYearFunction(column, skipEscape);
      if (!skipEscape) column = escapeColumn(column);
      return `year(${column} + interval ${13 - month} month - interval ${day - 1} day)`;
    };
    this.getDayOfYearFunction = function (_column, skipEscape) {
      let column = _column;
      if (!skipEscape) column = escapeColumn(column);
      return `DAYOFYEAR(${column})`;
    };
    this.getDayOfFiscalYearFunction = function (_column, fiscalYear, skipEscape) {
      let column = _column;
      if (!fiscalYear) return scope.getYearFunction(column, skipEscape);
      const { month, day } = scope.getFiscalYearUtilities(fiscalYear);
      if (month === 1 && day === 1) return scope.getDayOfYearFunction(column, skipEscape);
      if (!skipEscape) column = escapeColumn(column);
      return this.getDayDiffFunction(
        column,
        `CONCAT(${this.getFiscalYearFunction(column, fiscalYear, true)}-1,'-${fiscalYear}')`
      );
    };
    this.getNowFunction = function () {
      return 'NOW()';
    };
    this.getDayDiffFunction = function (a, b) {
      return `DATEDIFF(${a},${b})`;
    };
    this.getDateFunction = function (x) {
      return `DATE(${x})`;
    };
    this.getHashV1Function = function (x) {
      return `sha2(lower(trim(coalesce(${x},''))),256)`;
    };
    this.getEmailDomainFunction = function (x) {
      return `COALESCE(LOWER(SUBSTRING(${x}, LOCATE('@', ${x}) + 1)),'')`;
    };
    this.getDateSubFunction = function (date, value, type) {
      return `date_sub(${date}, interval ${value} ${type})`;
    };
    this.getDateArithmeticFunction = function (date, operator, value, intervalType) {
      let fn = 'date_add';
      if (operator === '-') fn = 'date_sub';
      return `${fn}(${date}, interval ${value} ${intervalType})`;
    };
    this.getStringIndexOfFunction = function (str, find, pos) {
      if (pos == null) return `LOCATE(${str},${find})`;
      return `LOCATE(${str},${find},${pos})`;
    };
    this.getFullTextBoolean = function (column, match) {
      return `MATCH(${column}) against (${match} IN BOOLEAN MODE)`;
    };
    this.getUUIDFunction = function () {
      return 'UUID()';
    };
    this.getIfNullFunction = function (check, value) {
      return `IFNULL(${check}, ${value})`;
    };
    this.getCastIntFunction = function (value) {
      return `CAST(${value} AS SIGNED)`;
    };
    this.getLengthFunction = function (value) {
      return `LENGTH(${value})`;
    };
    this.getTrimFunction = function (value) {
      return `TRIM(${value})`;
    };
    this.getConcatFunction = function (...rest) {
      let value = rest;
      if (value.length === 1 && Array.isArray(value[0])) [value] = value;
      return `CONCAT(${value.join(',')})`;
    };
    this.getShaLength40Function = function (_value) {
      let value = _value;
      if (Array.isArray(value)) {
        value = this.getConcatFunction(value);
      }
      return `UPPER(SHA(${value}))`;
    };
    this.getRegexpFunction = function (value, pattern) {
      return `${value} regexp ${pattern}`;
    };
    const functions = {
      DISTINCT: 1,
      COUNT: 1,
      SUM: 1,
      AVG: 1,
      MIN: 1,
      MAX: 1,
      NONE: (x) => x,
      DAY: (x) => this.getDayFunction(x, true),
      WEEK: (x) => this.getWeekFunction(x, true),
      MONTH: (x) => this.getMonthFunction(x, true),
      YEAR: (x) => this.getYearFunction(x, true),
      CONVERT_TZ: ([field, tz]) => this.getTimezoneFunction(field, tz),
      FISCAL_YEAR: (x) => this.getFiscalYearFunction(x, this.fiscalYear || '01-01', true),
      DAY_OF_YEAR: (x) => this.getDayOfYearFunction(x, true),
      DAY_OF_FISCAL_YEAR: (x) => this.getDayOfFiscalYearFunction(x, this.fiscalYear || '01-01', true),
      NOW: () => this.getNowFunction(),
      DATE: (x) => this.getDateFunction(x),
      LOCATE: ([x, y, z]) => this.getStringIndexOfFunction(x, y, z),
      FULLTEXT_BOOLEAN: ([x, y]) => this.getFullTextBoolean(x, y),
      REGEXP_LIKE: ([x, y]) => this.getRegexpFunction(x, y),
      NULLIF: 1,
      IFNULL: 1
    };
    return functions;
  }
};
export default moduleExports;
export const supportedFunctions = moduleExports.supportedFunctions;
