import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  entryTypeKeyFromRecord,
  formatEntryTypeCounts,
  tallyEntryType
} from '../lib/peoplePipeline/entryTypeCounts.js';

describe('entryTypeCounts', () => {
  it('prefers named entry_type, then resolved entry_type_id, then (none)', () => {
    assert.equal(entryTypeKeyFromRecord({ entry_type: 'EMAIL_UNSUBSCRIBE' }), 'EMAIL_UNSUBSCRIBE');
    assert.equal(entryTypeKeyFromRecord({ ENTRY_TYPE: 'CRM_ORIGIN' }), 'CRM_ORIGIN');
    assert.equal(entryTypeKeyFromRecord({ entry_type_id: 1 }), 'CRM_ORIGIN');
    assert.equal(entryTypeKeyFromRecord({ ENTRY_TYPE_ID: 44 }), 'EMAIL_UNSUBSCRIBE');
    assert.equal(entryTypeKeyFromRecord({ email: 'a@example.com' }), '(none)');
    assert.equal(entryTypeKeyFromRecord({ entry_type_id: 9999 }), 'id:9999');
  });

  it('tallies and formats counts by descending frequency', () => {
    const counts = {};
    tallyEntryType(counts, { entry_type: 'CRM_ORIGIN' });
    tallyEntryType(counts, { entry_type_id: 1 });
    tallyEntryType(counts, { entry_type: 'EMAIL_UNSUBSCRIBE' });
    tallyEntryType(counts, {});
    assert.deepEqual(counts, { CRM_ORIGIN: 2, EMAIL_UNSUBSCRIBE: 1, '(none)': 1 });
    assert.equal(formatEntryTypeCounts(counts), 'CRM_ORIGIN=2 EMAIL_UNSUBSCRIBE=1 (none)=1');
  });
});
