/**
 * Compact SQL person-id store: one table per id_type.
 *
 * Table: person_id_<id_type>
 *   value      BLOB (SQLite) / BINARY(16) (MySQL) PRIMARY KEY  -- 128-bit SHA-256 truncate
 *   person_id  INTEGER / BIGINT NOT NULL
 *
 * Example: person_id_email_hash_v1, person_id_phone_hash_v1, person_id_remote_person_id
 */
import { hashIdValueToU128, u128ToHexKey } from './hash.js';
import { isClientSqlWorker, getKnex, isSqliteLike } from './sqlHelpers.js';

const SAFE_ID_TYPE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Map id_type → physical table name person_id_<id_type>. */
export function personIdTableName(idType) {
  if (!idType || !SAFE_ID_TYPE.test(idType)) {
    throw new Error(`Invalid id_type for person_id_* table: ${JSON.stringify(idType)}`);
  }
  return `person_id_${idType}`;
}

function personIdColumnType(worker) {
  return isSqliteLike(worker) ? 'integer' : 'bigint';
}

/** SQLite has no BINARY type (use BLOB); MySQL uses BINARY(16). */
function valueColumnType(worker) {
  return isSqliteLike(worker) ? 'blob' : 'binary(16)';
}

function createTableSql(worker, table) {
  const pidType = personIdColumnType(worker);
  const valueType = valueColumnType(worker);
  return (
    `create table if not exists ${table} (` +
    `value ${valueType} not null primary key,` +
    `person_id ${pidType} not null` +
    `)`
  );
}

export async function ensureCompactPersonIdTable(worker, idType) {
  const table = personIdTableName(idType);
  const sql = createTableSql(worker, table);
  if (isClientSqlWorker(worker)) {
    await worker.query({ sql });
    return table;
  }
  const knex = await getKnex(worker);
  await knex.raw(sql);
  return table;
}

export async function ensureCompactPersonIdTables(worker, idTypes) {
  const tables = [];
  for (const idType of [...new Set(idTypes || [])]) {
    if (!idType) continue;
    tables.push(await ensureCompactPersonIdTable(worker, idType));
  }
  return tables;
}

function normalizePersonId(raw) {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

async function queryByValues(worker, table, binaryValues) {
  if (binaryValues.length === 0) return [];
  const placeholders = binaryValues.map(() => '?').join(',');
  const sql = `select value, person_id from ${table} where value in (${placeholders})`;
  if (isClientSqlWorker(worker)) {
    const { data } = await worker.query({ sql, values: binaryValues });
    return data || [];
  }
  const knex = await getKnex(worker);
  return knex.select(['value', 'person_id']).from(table).where('value', 'in', binaryValues);
}

async function insertIgnoreRows(worker, table, rows) {
  if (rows.length === 0) return;
  const chunkSize = 400;
  const sqlite = isClientSqlWorker(worker) || isSqliteLike(worker);
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?, ?)').join(',');
    const values = chunk.flatMap((r) => [r.value, r.person_id]);
    const sql = sqlite
      ? `insert or ignore into ${table} (value, person_id) values ${placeholders}`
      : `insert ignore into ${table} (value, person_id) values ${placeholders}`;
    if (isClientSqlWorker(worker)) {
      await worker.query({ sql, values });
    } else {
      const knex = await getKnex(worker);
      await knex.raw(sql, values);
    }
  }
}

/**
 * Compact store: hashes id_value to 16 raw bytes and stores in person_id_<id_type>.
 * @param {object} worker SQLWorker / PersonWorker
 * @param {{ ensureTables?: boolean }} [options]
 */
export function createCompactSqlIdentifierStore(worker, { ensureTables = true } = {}) {
  if (!worker) throw new Error('createCompactSqlIdentifierStore requires worker');
  const ensured = new Set();

  async function ensure(idType) {
    if (!ensureTables || ensured.has(idType)) return;
    await ensureCompactPersonIdTable(worker, idType);
    ensured.add(idType);
  }

  return {
    kind: 'person_id_compact',
    personIdTableName,
    ensureTables: (idTypes) => ensureCompactPersonIdTables(worker, idTypes),

    async findByIdentifiers(entries) {
      if (!entries?.length) return [];
      const byType = new Map();
      for (const e of entries) {
        if (!e?.id_type || e.id_value == null || e.id_value === '') continue;
        const binary = hashIdValueToU128(e.id_value);
        if (!byType.has(e.id_type)) byType.set(e.id_type, []);
        byType.get(e.id_type).push({ ...e, binary, hex: u128ToHexKey(binary) });
      }

      const results = [];
      for (const [idType, group] of byType) {
        await ensure(idType);
        const table = personIdTableName(idType);
        const seen = new Set();
        const binaryValues = [];
        for (const g of group) {
          if (seen.has(g.hex)) continue;
          seen.add(g.hex);
          binaryValues.push(g.binary);
        }
        const rows = await queryByValues(worker, table, binaryValues);
        const byHex = new Map(rows.map((r) => [u128ToHexKey(r.value), normalizePersonId(r.person_id)]));
        for (const g of group) {
          const personId = byHex.get(g.hex);
          if (personId == null) continue;
          results.push({
            id_type: g.id_type,
            id_value: g.id_value,
            person_id: personId
          });
        }
      }
      return results;
    },

    async insertIdentifiers(rows) {
      if (!rows?.length) return;
      const byType = new Map();
      for (const row of rows) {
        if (!row?.id_type || row.id_value == null || row.id_value === '') continue;
        const personId = normalizePersonId(row.person_id);
        if (personId == null) continue;
        const binary = hashIdValueToU128(row.id_value);
        if (!byType.has(row.id_type)) byType.set(row.id_type, []);
        byType.get(row.id_type).push({ value: binary, hex: u128ToHexKey(binary), person_id: personId });
      }
      for (const [idType, group] of byType) {
        await ensure(idType);
        // Deduplicate by value within batch (first-wins)
        const seen = new Set();
        const unique = [];
        for (const g of group) {
          if (seen.has(g.hex)) continue;
          seen.add(g.hex);
          unique.push({ value: g.value, person_id: g.person_id });
        }
        await insertIgnoreRows(worker, personIdTableName(idType), unique);
      }
    }
  };
}
