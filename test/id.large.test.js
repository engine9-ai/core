/**
 * Large-scale stress test for the SQLite compact person_id_<id_type> store.
 *
 * Scale (half-million class, ~600K people by the end):
 *   1. Bulk upsert 500K people + compact email_hash_v1 identifiers
 *   2. People ID pipeline (assignPersonIds) over 500K records:
 *        400K existing lookups + 100K new inserts
 *
 * Opt-in only (too heavy for default CI):
 *   E9_LARGE_ID_TEST=1 npm run test:id-large
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PersonWorker from '../lib/PersonWorker.js';
import {
  assignPersonIds,
  createCompactSqlIdentifierStore,
  hashIdValueToU128Hex,
  personIdTableName
} from '../lib/id/index.js';

const RUN = process.env.E9_LARGE_ID_TEST === '1';
const describeLarge = RUN ? describe : describe.skip;

const BULK_PEOPLE = 500_000;
const PIPELINE_EXISTING = 400_000;
const PIPELINE_NEW = 100_000;
const PIPELINE_TOTAL = PIPELINE_EXISTING + PIPELINE_NEW; // 500K
const EXPECTED_FINAL_PEOPLE = BULK_PEOPLE + PIPELINE_NEW; // 600K

const PERSON_CHUNK = 5_000;
const ID_CHUNK = 10_000;
const PIPELINE_CHUNK = 5_000;
const LOG_EVERY = 50_000;
const ID_TYPE = 'email_hash_v1';
const INPUT_ID = '00000000-0000-0000-0000-00000000f001';

function bulkIdValue(i) {
  return `e9:bulk:${i}`;
}

function newIdValue(i) {
  return `e9:new:${i}`;
}

function log(message, extra = '') {
  const ts = new Date().toISOString();
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[id.large ${ts}] ${message}${suffix}`);
}

function rate(count, elapsedMs) {
  if (elapsedMs <= 0) return '∞';
  return (count / (elapsedMs / 1000)).toFixed(0);
}

function elapsed(startMs) {
  return Date.now() - startMs;
}

describeLarge('large SQLite compact id store', { timeout: 60 * 60 * 1000 }, () => {
  test('bulk 500K then pipeline 400K existing + 100K new', async () => {
    const dbPath = path.join(os.tmpdir(), `e9-id-large-${process.pid}-${Date.now()}.sqlite`);
    log(`database file: ${dbPath}`);
    const worker = new PersonWorker({
      accountId: 'id-large',
      auth: { database_connection: `sqlite://${dbPath}` }
    });

    try {
      const tAll = Date.now();
      await worker.installStandard();
      await worker.query('PRAGMA journal_mode = WAL');
      await worker.query('PRAGMA synchronous = NORMAL');
      await worker.query('PRAGMA temp_store = MEMORY');
      await worker.query('PRAGMA cache_size = -200000'); // ~200MB page cache

      const store = createCompactSqlIdentifierStore(worker);
      await store.ensureTables([ID_TYPE]);
      const table = personIdTableName(ID_TYPE);

      // ── Phase 1: bulk create 500K people + compact identifiers ──────────
      log(`phase 1: bulk creating ${BULK_PEOPLE.toLocaleString()} people`);
      const tBulkPeople = Date.now();
      await worker.query('BEGIN');
      for (let i = 0; i < BULK_PEOPLE; i += PERSON_CHUNK) {
        const n = Math.min(PERSON_CHUNK, BULK_PEOPLE - i);
        const valuesSql = Array(n).fill('(NULL)').join(',');
        await worker.query(`insert into person (id) values ${valuesSql}`);
        if ((i + n) % LOG_EVERY === 0 || i + n === BULK_PEOPLE) {
          const ms = elapsed(tBulkPeople);
          log(
            `phase 1 people: ${(i + n).toLocaleString()} / ${BULK_PEOPLE.toLocaleString()}`,
            `(${rate(i + n, ms)} rows/s, ${ms}ms)`
          );
        }
      }
      await worker.query('COMMIT');
      const peopleMs = elapsed(tBulkPeople);
      log(`phase 1 people done in ${peopleMs}ms (${rate(BULK_PEOPLE, peopleMs)} rows/s)`);

      const { data: personBounds } = await worker.query(
        'select min(id) as min_id, max(id) as max_id, count(*) as c from person'
      );
      assert.equal(Number(personBounds[0].c), BULK_PEOPLE);
      const firstPersonId = Number(personBounds[0].min_id);
      assert.ok(firstPersonId >= 1);

      log(`phase 1: bulk upserting ${BULK_PEOPLE.toLocaleString()} compact identifiers`);
      const tBulkIds = Date.now();
      await worker.query('BEGIN');
      for (let i = 0; i < BULK_PEOPLE; i += ID_CHUNK) {
        const n = Math.min(ID_CHUNK, BULK_PEOPLE - i);
        const rows = [];
        for (let j = 0; j < n; j++) {
          const idx = i + j;
          rows.push({
            id_type: ID_TYPE,
            id_value: bulkIdValue(idx),
            person_id: firstPersonId + idx
          });
        }
        await store.insertIdentifiers(rows);
        if ((i + n) % LOG_EVERY === 0 || i + n === BULK_PEOPLE) {
          const ms = elapsed(tBulkIds);
          log(
            `phase 1 identifiers: ${(i + n).toLocaleString()} / ${BULK_PEOPLE.toLocaleString()}`,
            `(${rate(i + n, ms)} rows/s, ${ms}ms)`
          );
        }
      }
      await worker.query('COMMIT');
      const idsMs = elapsed(tBulkIds);
      log(`phase 1 identifiers done in ${idsMs}ms (${rate(BULK_PEOPLE, idsMs)} rows/s)`);

      const { data: idCount } = await worker.query(`select count(*) as c from ${table}`);
      assert.equal(Number(idCount[0].c), BULK_PEOPLE);

      // Spot-check a few lookups
      log('phase 1: spot-check lookups');
      const tLookup = Date.now();
      const spot = await store.findByIdentifiers([
        { id_type: ID_TYPE, id_value: bulkIdValue(0) },
        { id_type: ID_TYPE, id_value: bulkIdValue(123456) },
        { id_type: ID_TYPE, id_value: bulkIdValue(BULK_PEOPLE - 1) },
        { id_type: ID_TYPE, id_value: 'missing-should-not-exist' }
      ]);
      assert.equal(spot.length, 3);
      assert.equal(
        spot.find((r) => r.id_value === bulkIdValue(0)).person_id,
        firstPersonId
      );
      assert.equal(
        spot.find((r) => r.id_value === bulkIdValue(123456)).person_id,
        firstPersonId + 123456
      );
      log(`phase 1 spot-check ok in ${elapsed(tLookup)}ms`);

      // ── Phase 2: pipeline mix 400K existing + 100K new ─────────────────
      log(
        `phase 2: assignPersonIds pipeline over ${PIPELINE_TOTAL.toLocaleString()} records ` +
          `(${PIPELINE_EXISTING.toLocaleString()} existing + ${PIPELINE_NEW.toLocaleString()} new)`
      );
      const tPipe = Date.now();
      let processed = 0;
      let existingMatched = 0;
      let newlyAssigned = 0;

      for (let i = 0; i < PIPELINE_TOTAL; i += PIPELINE_CHUNK) {
        const n = Math.min(PIPELINE_CHUNK, PIPELINE_TOTAL - i);
        const batch = [];
        for (let j = 0; j < n; j++) {
          const idx = i + j;
          const isExisting = idx < PIPELINE_EXISTING;
          const idValue = isExisting ? bulkIdValue(idx) : newIdValue(idx - PIPELINE_EXISTING);
          batch.push({
            input_id: INPUT_ID,
            identifiers: [{ path: 'person_email', type: ID_TYPE, value: idValue }],
            _expectExisting: isExisting,
            _idx: idx
          });
        }

        const tChunk = Date.now();
        await assignPersonIds({ worker, batch, identifierStore: store });
        const chunkMs = elapsed(tChunk);

        for (const item of batch) {
          assert.ok(item.person_id, `missing person_id at idx ${item._idx}`);
          if (item._expectExisting) {
            assert.equal(
              item.person_id,
              firstPersonId + item._idx,
              `existing idx ${item._idx} should keep original person_id`
            );
            existingMatched += 1;
          } else {
            newlyAssigned += 1;
          }
          delete item._expectExisting;
          delete item._idx;
        }

        processed += n;
        if (processed % LOG_EVERY === 0 || processed === PIPELINE_TOTAL) {
          const ms = elapsed(tPipe);
          log(
            `phase 2 pipeline: ${processed.toLocaleString()} / ${PIPELINE_TOTAL.toLocaleString()}`,
            `(chunk ${n} in ${chunkMs}ms, overall ${rate(processed, ms)} rec/s, ` +
              `matched=${existingMatched.toLocaleString()} new=${newlyAssigned.toLocaleString()})`
          );
        }
      }

      const pipeMs = elapsed(tPipe);
      log(
        `phase 2 done in ${pipeMs}ms (${rate(PIPELINE_TOTAL, pipeMs)} rec/s)`,
        `matched=${existingMatched.toLocaleString()} new=${newlyAssigned.toLocaleString()}`
      );
      assert.equal(existingMatched, PIPELINE_EXISTING);
      assert.equal(newlyAssigned, PIPELINE_NEW);

      const { data: finalPeople } = await worker.query('select count(*) as c from person');
      const { data: finalIds } = await worker.query(`select count(*) as c from ${table}`);
      assert.equal(Number(finalPeople[0].c), EXPECTED_FINAL_PEOPLE);
      assert.equal(Number(finalIds[0].c), EXPECTED_FINAL_PEOPLE);

      // Lookup sample of new ids
      log('phase 2: lookup sample of new identifiers');
      const tNewLookup = Date.now();
      const newSample = await store.findByIdentifiers([
        { id_type: ID_TYPE, id_value: newIdValue(0) },
        { id_type: ID_TYPE, id_value: newIdValue(PIPELINE_NEW - 1) }
      ]);
      assert.equal(newSample.length, 2);
      log(`phase 2 new-id lookups ok in ${elapsed(tNewLookup)}ms`);

      const totalMs = elapsed(tAll);
      log(
        `complete: ${EXPECTED_FINAL_PEOPLE.toLocaleString()} people / identifiers`,
        `total ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`
      );
      log(
        `hash example: ${bulkIdValue(0)} → ${hashIdValueToU128Hex(bulkIdValue(0))}`
      );
    } finally {
      await worker.destroy();
      try {
        fs.unlinkSync(dbPath);
        fs.unlinkSync(`${dbPath}-wal`);
        fs.unlinkSync(`${dbPath}-shm`);
      } catch {
        // ignore cleanup races
      }
    }
  });
});
