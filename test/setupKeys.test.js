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

describe('setupKeys --remote', () => {
  function recorder() {
    const calls = [];
    const run = (args, _cwd, input) => {
      calls.push({ args, input });
      return '';
    };
    return { calls, run };
  }

  it('gives each environment its own admin key and session secret', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-keys-remote-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), '{}\n');
      await setupKeys({ cwd, applySql: async () => {} });
      const local = readFileSync(path.join(cwd, '.env'), 'utf8');

      const prod = recorder();
      const first = await setupKeys({ cwd, remote: true, wrangler: prod.run, applySql: async () => {} });
      assert.equal(first.remote.target, 'production');
      const prodEnv = readFileSync(path.join(cwd, '.env.production'), 'utf8');
      assert.notEqual(readEnvValue(prodEnv, 'E9_ADMIN_API_KEY'), readEnvValue(local, 'E9_ADMIN_API_KEY'));
      assert.notEqual(readEnvValue(prodEnv, 'SESSION_SECRET'), readEnvValue(local, 'SESSION_SECRET'));
      assert.equal(readEnvValue(prodEnv, 'E9_PUBLIC_API_KEY'), readEnvValue(local, 'E9_PUBLIC_API_KEY'));
      const secrets = prod.calls.filter((c) => c.args[0] === 'secret').map((c) => c.args[2]);
      assert.deepEqual(secrets.sort(), ['E9_ADMIN_API_KEY', 'E9_PUBLIC_API_KEY', 'SESSION_SECRET']);
      const put = prod.calls.find((c) => c.args[2] === 'E9_ADMIN_API_KEY');
      assert.equal(put.input, readEnvValue(prodEnv, 'E9_ADMIN_API_KEY'));
      assert.ok(prod.calls.every((c) => !c.args.includes('--env')));
      const sql = prod.calls.find((c) => c.args[0] === 'd1').args.at(-1);
      assert.match(sql, /INSERT OR IGNORE INTO api_key/);
      assert.doesNotMatch(sql, new RegExp(readEnvValue(local, 'E9_ADMIN_API_KEY')));

      const again = recorder();
      await setupKeys({ cwd, remote: true, wrangler: again.run, applySql: async () => {} });
      assert.equal(readFileSync(path.join(cwd, '.env.production'), 'utf8'), prodEnv, 'second run reuses production keys');
      assert.match(again.calls.find((c) => c.args[0] === 'd1').args.at(-1), /INSERT OR IGNORE/, 'a rebuilt database gets the keys back');

      const staging = recorder();
      const third = await setupKeys({ cwd, remote: true, env: 'staging', wrangler: staging.run, applySql: async () => {} });
      assert.equal(third.remote.target, 'staging');
      const stagingEnv = readFileSync(path.join(cwd, '.env.staging'), 'utf8');
      assert.notEqual(readEnvValue(stagingEnv, 'E9_ADMIN_API_KEY'), readEnvValue(prodEnv, 'E9_ADMIN_API_KEY'));
      assert.ok(staging.calls.every((c) => c.args.includes('--env') && c.args.includes('staging')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('turns off the local admin key that earlier releases copied to production', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-keys-legacy-'));
    try {
      writeFileSync(path.join(cwd, 'wrangler.jsonc'), '{}\n');
      await setupKeys({ cwd, applySql: async () => {} });
      const statePath = path.join(cwd, '.e9core', 'keys.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      writeFileSync(statePath, JSON.stringify({ ...state, remoteApplied: true }));

      const prod = recorder();
      const result = await setupKeys({ cwd, remote: true, wrangler: prod.run, applySql: async () => {} });
      const sql = prod.calls.find((c) => c.args[0] === 'd1').args.at(-1);
      assert.match(sql, new RegExp(`UPDATE api_key SET active = 0 WHERE id IN \\('${state.adminId}'\\)`));
      assert.doesNotMatch(sql, new RegExp(`'${state.publicId}'\\);$`));
      assert.match(result.notes.join('\n'), /secret delete E9_SETUP_TOKEN/);
      const after = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(after.remoteApplied, undefined);
      assert.equal(after.remotes.production.publicId, state.publicId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
