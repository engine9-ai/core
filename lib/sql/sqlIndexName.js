/*
  SQL index names. MySQL/MariaDB identifiers are capped at 64 characters;
  knex's default `{table}_{columns}_index` overflows on long model tables
  (e.g. model_authentic_origin_transaction_stats_by_date + source_code_id).

  Short names stay readable. Long names keep a prefix of the full name and
  a deterministic hash so two different table/column sets never collide.
*/
import crypto from 'node:crypto';

export const SQL_IDENTIFIER_MAX_LENGTH = 64;
const HASH_LENGTH = 8;

function normalizeIndexColumns(columns) {
  if (Array.isArray(columns)) return columns.map((c) => String(c).trim()).filter(Boolean);
  if (columns == null || columns === '') return [];
  return String(columns)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

export function sqlIndexName(table, columns, { unique = false, name, maxLength = SQL_IDENTIFIER_MAX_LENGTH } = {}) {
  const cols = normalizeIndexColumns(columns);
  const kind = unique ? 'uidx' : 'idx';
  const full = name || `${table}_${cols.join('_')}_${kind}`;
  if (full.length <= maxLength) return full;
  const id = crypto.createHash('sha256').update(`${table}\0${cols.join(',')}\0${kind}\0${name || ''}`).digest('hex').slice(0, HASH_LENGTH);
  const prefixLen = maxLength - HASH_LENGTH - 1;
  let prefix = full.slice(0, Math.max(prefixLen, 0)).replace(/_+$/u, '');
  if (!prefix) prefix = kind;
  return `${prefix}_${id}`.slice(0, maxLength);
}

export default { SQL_IDENTIFIER_MAX_LENGTH, sqlIndexName };
