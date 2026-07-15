import { parseDate } from '../utilities.js';

const PERSON_CREATED_AT_SOURCE_FIELDS = ['date_created', 'remote_date_created', 'frakture_date_created', 'created_at'];

export function personCreatedAtFromRow(row) {
  if (!row) return undefined;
  for (const field of PERSON_CREATED_AT_SOURCE_FIELDS) {
    const value = row[field];
    if (value != null && value !== '') {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
      const parsed = parseDate(value);
      if (parsed) return new Date(parsed);
      return value;
    }
  }
  return undefined;
}
