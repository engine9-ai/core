import { TIMELINE_ENTRY_TYPES } from '@engine9/input-tools/timelineTypes.js';

function getFieldIgnoreCase(record, name) {
  if (!record || typeof record !== 'object') return undefined;
  const direct = record[name];
  if (direct != null && direct !== '') return direct;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (String(key).toLowerCase() === target && value != null && value !== '') return value;
  }
  return undefined;
}

/** Label for a source row: named entry_type, resolved entry_type_id, or (none). */
export function entryTypeKeyFromRecord(record) {
  const named = getFieldIgnoreCase(record, 'entry_type');
  if (named != null && String(named).trim() !== '') return String(named).trim();
  const id = getFieldIgnoreCase(record, 'entry_type_id');
  if (id == null || id === '') return '(none)';
  const n = Number(id);
  const name = Number.isFinite(n) ? TIMELINE_ENTRY_TYPES[n] : TIMELINE_ENTRY_TYPES[id];
  return name || `id:${id}`;
}

export function tallyEntryType(counts, record) {
  const key = entryTypeKeyFromRecord(record);
  counts[key] = (counts[key] || 0) + 1;
  return key;
}

export function formatEntryTypeCounts(counts = {}) {
  return Object.entries(counts)
    .sort((a, b) => {
      if (a[0] === '(none)') return 1;
      if (b[0] === '(none)') return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}
