import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiKeyInsertSql,
  ensureGitignore,
  readEnvValue,
  setupKeys,
  upsertEnv,
} from '../bin/setupKeys.js';

describe('upsertEnv', () => {
  it('appends new keys and replaces existing ones', () => {
    const next = upsertEnv('PORT=3000\nE9_ADMIN_API_KEY=old\n', {
      E9_ADMIN_API_KEY: 'e9key_new',
      SESSION_SECRET: 'abc',
    });
    assert.equal(readEnvValue(next, 'PORT'), '3000');
    assert.equal(readEnvValue(next, 'E9_ADMIN_API_KEY'), 'e9key_new');
    assert.equal(readEnvValue(next, 'SESSION_SECRET'), 'abc');
  });
});

describe('ensureGitignore', () => {
  it('adds secret files once', () => {
    const once = ensureGitignore('node_modules\n', ['.env', '.dev.vars']);
    const twice = ensureGitignore(once, ['.env', '.dev.vars']);
    assert.match(once, /^\.env$/m);
    assert.match(once, /^\.dev\.vars$/m);
    assert.equal(twice.match(/^\.env$/gm).length, 1);
    assert.equal(twice, once);
  });
});

describe('apiKeyInsertSql', () => {
  it('stores a hash, not the plaintext key', () => {
    const sql = apiKeyInsertSql({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'site-public',
      key: 'e9publickey_abcdef',
      scopes: ['public'],
    });
    assert.match(sql, /INSERT INTO api_key/);
    assert.doesNotMatch(sql, /e9publickey_abcdef/);
    assert.match(sql, /"public"/);
  });
});

describe('setupKeys', () => {
  it('writes .env and keeps the same keys on a second run', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-keys-'));
    try {
      const first = await setupKeys({ cwd, skipWrangler: true });
      assert.equal(first.created.admin, true);
      assert.equal(first.created.public, true);
      const env1 = readFileSync(path.join(cwd, '.env'), 'utf8');
      const admin = readEnvValue(env1, 'E9_ADMIN_API_KEY');
      const pub = readEnvValue(env1, 'E9_PUBLIC_API_KEY');
      assert.match(admin, /^e9key_/);
      assert.match(pub, /^e9publickey_/);
      const setupToken = readEnvValue(env1, 'E9_SETUP_TOKEN');
      assert.match(setupToken, /^[0-9a-f]{48}$/);
      assert.equal(existsSync(path.join(cwd, '.dev.vars')), false);
      const ignore = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
      assert.match(ignore, /^\.env$/m);
      assert.match(ignore, /^\.dev\.vars$/m);

      writeFileSync(path.join(cwd, 'wrangler.jsonc'), '{}\n');
      writeFileSync(path.join(cwd, '.dev.vars'), 'E9_ADMIN_API_KEY=stale\n');
      const second = await setupKeys({ cwd, skipWrangler: true });
      assert.equal(second.reused, true);
      assert.match(second.notes.join('\n'), /Delete \.dev\.vars/);
      assert.equal(readEnvValue(readFileSync(path.join(cwd, '.env'), 'utf8'), 'E9_ADMIN_API_KEY'), admin);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
