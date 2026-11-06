/*
  `--remote` (bin/temporaryKey.js): a short-lived admin key written to the
  site's D1 through wrangler, used for one command, then deleted. "wrangler"
  here runs each statement against a local SQLite database with the real
  api_key table, and the key is checked by the real SqlApiKeyStore.
*/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { remoteSiteUrl, withTemporaryAdminKey, TEMPORARY_KEY_NAME } from '../bin/temporaryKey.js';
import { sqliteD1 } from '../bin/sqliteD1.js';

function site({ routes } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-temp-key-'));
  writeFileSync(
    path.join(cwd, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'folio',
      d1_databases: [{ binding: 'DB', database_name: 'folio-control', database_id: 'x' }],
      env: { staging: { d1_databases: [{ binding: 'DB', database_name: 'folio-staging', database_id: 'y' }] } },
      ...(routes ? { routes } : {})
    })
  );
  return cwd;
}

async function withKeyTable(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'e9-temp-key-db-'));
  const d1 = sqliteD1(path.join(dir, 'd1.db'));
  const worker = new PersonWorker({ accountId: 't', d1 });
  const store = new SqlApiKeyStore({ worker });
  await store.deploy();
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const sql = args.at(-1);
    d1.db.exec(sql);
    return '';
  };
  try {
    await fn({ store, run, calls, d1 });
  } finally {
    d1.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('withTemporaryAdminKey', () => {
  it('makes an admin key that works during the command and is gone after it', async () => {
    const cwd = site();
    try {
      await withKeyTable(async ({ store, run, calls, d1 }) => {
        let seen;
        const answer = await withTemporaryAdminKey({ cwd, run }, async (key, { expiresAt }) => {
          const verified = await store.verify(key);
          assert.equal(verified.valid, true);
          assert.deepEqual(verified.key.scopes, ['admin']);
          assert.ok(new Date(expiresAt) - Date.now() <= 15 * 60_000);
          seen = key;
          return 'done';
        });
        assert.equal(answer, 'done');
        assert.equal((await store.verify(seen)).reason, 'unknown_key');
        assert.equal(d1.db.prepare(`select count(*) n from api_key where name = '${TEMPORARY_KEY_NAME}'`).get().n, 0);
        assert.ok(calls.every((args) => args.slice(0, 4).join(' ') === 'd1 execute folio-control --remote'));
        assert.ok(calls.every((args) => !args.at(-1).includes(seen)), 'only the hash is sent');
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('deletes the key when the command fails, and an expired key from a killed run', async () => {
    const cwd = site();
    try {
      await withKeyTable(async ({ run, d1 }) => {
        d1.db.exec(
          `insert into api_key (id, name, key_hash, scopes, active, expires_at) values ('old', '${TEMPORARY_KEY_NAME}', 'h', '["admin"]', 1, '2020-01-01T00:00:00.000Z')`
        );
        await assert.rejects(
          withTemporaryAdminKey({ cwd, run }, async () => {
            throw new Error('site said no');
          }),
          /site said no/
        );
        assert.equal(d1.db.prepare('select count(*) n from api_key').get().n, 0);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses the environment its database belongs to', async () => {
    const cwd = site();
    try {
      await withKeyTable(async ({ run, calls }) => {
        await withTemporaryAdminKey({ cwd, env: 'staging', run }, async () => {});
        assert.ok(calls.every((args) => args.join(' ').startsWith('d1 execute folio-staging --remote --env staging')));
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('remoteSiteUrl', () => {
  it('takes --url, else the one custom-domain route', () => {
    const cwd = site({ routes: [{ pattern: 'folio.example.org', custom_domain: true }] });
    try {
      assert.equal(remoteSiteUrl({ url: 'https://x.example', cwd }), 'https://x.example');
      assert.equal(remoteSiteUrl({ cwd }), 'https://folio.example.org');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const bare = site();
    try {
      assert.throws(() => remoteSiteUrl({ cwd: bare }), /pass --url/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
