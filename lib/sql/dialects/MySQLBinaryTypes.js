'use strict';

const typeMap = {
  0x00: 'DECIMAL', // aka DECIMAL
  0x01: 'TINY', // aka TINYINT, 1 byte
  0x02: 'SHORT', // aka SMALLINT, 2 bytes
  0x03: 'INT', //'LONG', // aka INT, 4 bytes
  0x04: 'FLOAT', // aka FLOAT, 4-8 bytes
  0x05: 'DOUBLE', // aka DOUBLE, 8 bytes
  0x06: 'NULL', // NULL (used for prepared statements, I think)
  0x07: 'TIMESTAMP', // aka TIMESTAMP
  0x08: 'BIGINT', //'LONGLONG', // aka BIGINT, 8 bytes
  0x09: 'MEDIUMINT', //'INT24', // aka MEDIUMINT, 3 bytes
  0x0a: 'DATE', // aka DATE
  0x0b: 'TIME', // aka TIME
  0x0c: 'DATETIME', // aka DATETIME
  0x0d: 'YEAR', // aka YEAR, 1 byte (don't ask)
  0x0e: 'NEWDATE', // aka ?
  0x0f: 'VARCHAR', // aka VARCHAR (?)
  0x10: 'BIT', // aka BIT, 1-8 byte
  0xf5: 'JSON',
  0xf6: 'DECIMAL', //'NEWDECIMAL', // aka DECIMAL
  0xf7: 'ENUM', // aka ENUM
  0xf8: 'SET', // aka SET
  0xf9: 'TINY_BLOB', // aka TINYBLOB, TINYTEXT
  0xfa: 'MEDIUM_BLOB', // aka MEDIUMBLOB, MEDIUMTEXT
  0xfb: 'LONG_BLOB', // aka LONGBLOG, LONGTEXT
  0xfc: 'TEXT', //'BLOB', // aka BLOB, TEXT
  0xfd: 'VARCHAR', //'VAR_STRING', // aka VARCHAR, VARBINARY
  0xfe: 'VARCHAR', //'STRING', // aka CHAR, BINARY
  0xff: 'GEOMETRY' // aka GEOMETRY
};

// Manually extracted from mysql-5.5.23/include/mysql_com.h
// some more info here: http://dev.mysql.com/doc/refman/5.5/en/c-api-prepared-statement-type-codes.html
typeMap.DECIMAL = 0x00; // aka DECIMAL (http://dev.mysql.com/doc/refman/5.0/en/precision-math-decimal-changes.html)
typeMap.TINY = 0x01; // aka TINYINT, 1 byte
typeMap.SHORT = 0x02; // aka SMALLINT, 2 bytes
typeMap.LONG = 0x03; // aka INT, 4 bytes
typeMap.FLOAT = 0x04; // aka FLOAT, 4-8 bytes
typeMap.DOUBLE = 0x05; // aka DOUBLE, 8 bytes
typeMap.NULL = 0x06; // NULL (used for prepared statements, I think)
typeMap.TIMESTAMP = 0x07; // aka TIMESTAMP
typeMap.LONGLONG = 0x08; // aka BIGINT, 8 bytes
typeMap.INT24 = 0x09; // aka MEDIUMINT, 3 bytes
typeMap.DATE = 0x0a; // aka DATE
typeMap.TIME = 0x0b; // aka TIME
typeMap.DATETIME = 0x0c; // aka DATETIME
typeMap.YEAR = 0x0d; // aka YEAR, 1 byte (don't ask)
typeMap.NEWDATE = 0x0e; // aka ?
typeMap.VARCHAR = 0x0f; // aka VARCHAR (?)
typeMap.BIT = 0x10; // aka BIT, 1-8 byte
typeMap.JSON = 0xf5;
typeMap.NEWDECIMAL = 0xf6; // aka DECIMAL
typeMap.ENUM = 0xf7; // aka ENUM
typeMap.SET = 0xf8; // aka SET
typeMap.TINY_BLOB = 0xf9; // aka TINYBLOB, TINYTEXT
typeMap.MEDIUM_BLOB = 0xfa; // aka MEDIUMBLOB, MEDIUMTEXT
typeMap.LONG_BLOB = 0xfb; // aka LONGBLOG, LONGTEXT
typeMap.BLOB = 0xfc; // aka BLOB, TEXT
typeMap.VAR_STRING = 0xfd; // aka VARCHAR, VARBINARY
typeMap.STRING = 0xfe; // aka CHAR, BINARY
typeMap.GEOMETRY = 0xff; // aka GEOMETRY

export default typeMap;
