/**
 * Per-account identifier store mode.
 *
 * Durable flag: setting `identifier_store_kind` on the core plugin
 * (`legacy` | `compact`). When unset, dialect defaults apply
 * (SQLite/D1 → compact, MySQL → person_identifier).
 *
 * Durable Object bindings still win over the setting.
 */
import { isSqliteLike, isClientSqlWorker, getKnex } from './sqlHelpers.js';
import { createDurableObjectIdentifierStore } from './durableObjectStore.js';
import { createCompactSqlIdentifierStore } from './compactSqlStore.js';
import { createPersonIdentifierSqlStore } from './sqlStore.js';

export const IDENTIFIER_STORE_KIND_SETTING = 'identifier_store_kind';
export const IDENTIFIER_STORE_KIND_COMPACT = 'compact';
export const IDENTIFIER_STORE_KIND_LEGACY = 'legacy';

/** Fixed core plugin id used by getNextTablePrefixCounter / settings. */
export const CORE_PLUGIN_ID = '00000000-0000-4000-a000-000000000001';

export function normalizeIdentifierStoreKind(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (v === IDENTIFIER_STORE_KIND_COMPACT) return IDENTIFIER_STORE_KIND_COMPACT;
  if (v === IDENTIFIER_STORE_KIND_LEGACY || v === 'person_identifier') return IDENTIFIER_STORE_KIND_LEGACY;
  return null;
}

/**
 * Effective kind when the setting is unset (ignores DO bindings).
 * SQLite/D1 → compact; MySQL and other SQL → legacy.
 */
export function defaultIdentifierStoreKind(worker) {
  return isSqliteLike(worker) ? IDENTIFIER_STORE_KIND_COMPACT : IDENTIFIER_STORE_KIND_LEGACY;
}

/**
 * Read identifier_store_kind from worker override or account `setting` table.
 * Returns null when unset (caller should apply dialect defaults).
 */
export async function readIdentifierStoreKind(worker) {
  const fromWorker = normalizeIdentifierStoreKind(worker?.identifier_store_kind);
  if (fromWorker) return fromWorker;

  if (typeof worker?.getSettings === 'function') {
    try {
      const settings = await worker.getSettings({ pluginId: CORE_PLUGIN_ID });
      const kind = normalizeIdentifierStoreKind(settings?.[IDENTIFIER_STORE_KIND_SETTING]);
      if (kind) return kind;
    } catch {
      // setting / plugin may not exist yet
    }
  }

  try {
    if (typeof worker?.query === 'function') {
      const result = await worker.query({
        sql: 'select value from setting where plugin_id=? and name=? limit 1',
        values: [CORE_PLUGIN_ID, IDENTIFIER_STORE_KIND_SETTING]
      });
      const row = result?.data?.[0] || result?.[0];
      const kind = normalizeIdentifierStoreKind(row?.value);
      if (kind) return kind;
    } else {
      const knex = await getKnex(worker);
      if (knex) {
        const rows = await knex
          .select('value')
          .from('setting')
          .where({ plugin_id: CORE_PLUGIN_ID, name: IDENTIFIER_STORE_KIND_SETTING })
          .limit(1);
        const kind = normalizeIdentifierStoreKind(rows?.[0]?.value);
        if (kind) return kind;
      }
    }
  } catch {
    // table missing on fresh DBs
  }

  return null;
}

/**
 * Persist identifier_store_kind (requires worker.setSetting, e.g. server PersonWorker).
 */
export async function writeIdentifierStoreKind(worker, kind) {
  const normalized = normalizeIdentifierStoreKind(kind);
  if (!normalized) throw new Error(`Invalid identifier_store_kind: ${JSON.stringify(kind)}`);
  if (typeof worker.setSetting !== 'function') {
    throw new Error('writeIdentifierStoreKind requires worker.setSetting');
  }
  if (typeof worker.install === 'function') {
    await worker.install({
      id: CORE_PLUGIN_ID,
      path: '@engine9/interfaces/plugin',
      name: 'Core Plugin',
      unique: true
    });
  }
  await worker.setSetting({
    pluginId: CORE_PLUGIN_ID,
    name: IDENTIFIER_STORE_KIND_SETTING,
    value: normalized
  });
  worker.identifier_store_kind = normalized;
  return normalized;
}

/**
 * Build a store for an explicit kind, or dialect default when kind is null/unset.
 * DO namespace (worker.personIds / PERSON_IDS) always wins.
 */
export function createIdentifierStoreForKind(worker, kind = null) {
  const namespace = worker?.personIds || worker?.PERSON_IDS;
  if (namespace) {
    return createDurableObjectIdentifierStore({
      namespace,
      accountId: worker.accountId
    });
  }
  const normalized = normalizeIdentifierStoreKind(kind);
  const effective = normalized || defaultIdentifierStoreKind(worker);
  if (effective === IDENTIFIER_STORE_KIND_COMPACT) {
    return createCompactSqlIdentifierStore(worker);
  }
  return createPersonIdentifierSqlStore(worker);
}

/**
 * Resolve store from durable setting + dialect defaults (+ DO binding).
 */
export async function createDefaultIdentifierStore(worker) {
  const kind = await readIdentifierStoreKind(worker);
  return createIdentifierStoreForKind(worker, kind);
}

export { isClientSqlWorker };
