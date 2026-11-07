import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENV_ACCOUNT_ID,
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

  it('writes E9_ACCOUNT_ID to .env, matching wrangler.jsonc, and never overwrites it once set', async () => {
    // Local serve() and setup's own Cloudflare write both read E9_ACCOUNT_ID;
    // leaving it out of .env is the local-setup mismatch that lets serve()
    // run under a different account than the one setup created rows for.
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-keys-account-'));
    try {
      await setupKeys({ cwd, accountId: 'my-site', skipWrangler: true });
      const env1 = readFileSync(path.join(cwd, '.env'), 'utf8');
      assert.equal(readEnvValue(env1, ENV_ACCOUNT_ID), 'my-site');

      // A later run (e.g. a rotate) with a different accountId does not move it:
      // E9_ACCOUNT_ID must only ever be set once, by hand or by first setup.
      await setupKeys({ cwd, accountId: 'something-else', rotate: true, skipWrangler: true });
      const env2 = readFileSync(path.join(cwd, '.env'), 'utf8');
      assert.equal(readEnvValue(env2, ENV_ACCOUNT_ID), 'my-site');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('writes both signing secrets, and replaces one someone typed', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-setup-keys-secrets-'));
    try {
      const first = await setupKeys({ cwd, skipWrangler: true });
      assert.equal(first.created.session, true);
      assert.equal(first.created.agentCredentials, true);
      const env1 = readFileSync(path.join(cwd, '.env'), 'utf8');
      const session = readEnvValue(env1, 'SESSION_SECRET');
      const agent = readEnvValue(env1, 'AGENT_CREDENTIALS_SECRET');
      assert.match(session, /^[0-9a-f]{64}$/);
      assert.match(agent, /^[0-9a-f]{64}$/);
      assert.notEqual(session, agent);

      writeFileSync(path.join(cwd, '.env'), upsertEnv(env1, { SESSION_SECRET: 'I am god' }));
      const second = await setupKeys({ cwd, skipWrangler: true });
      assert.equal(second.reused, false);
      assert.equal(second.created.session, true);
      assert.equal(second.created.agentCredentials, false);
      assert.match(second.notes.join('\n'), /SESSION_SECRET in \.env is not 64 hex characters.*replaced/);
      const env2 = readFileSync(path.join(cwd, '.env'), 'utf8');
      assert.match(readEnvValue(env2, 'SESSION_SECRET'), /^[0-9a-f]{64}$/);
      assert.equal(readEnvValue(env2, 'AGENT_CREDENTIALS_SECRET'), agent, 'a good secret is kept');
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
      const secrets = prod.calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'put').map((c) => c.args[2]);
      assert.deepEqual(secrets.sort(), ['AGENT_CREDENTIALS_SECRET', 'E9_ADMIN_API_KEY', 'E9_PUBLIC_API_KEY', 'SESSION_SECRET']);
      const put = prod.calls.find((c) => c.args[2] === 'E9_ADMIN_API_KEY');
      assert.equal(put.input, readEnvValue(prodEnv, 'E9_ADMIN_API_KEY'));
      assert.ok(prod.calls.every((c) => !c.args.includes('--env')));
      const sql = prod.calls.find((c) => c.args[0] === 'd1').args.at(-1);
      assert.match(sql, /INSERT OR IGNORE INTO api_key/);
      assert.doesNotMatch(sql, new RegExp(readEnvValue(local, 'E9_ADMIN_API_KEY')));

      assert.notEqual(readEnvValue(prodEnv, 'AGENT_CREDENTIALS_SECRET'), readEnvValue(local, 'AGENT_CREDENTIALS_SECRET'));
      const agentPut = prod.calls.find((c) => c.args[2] === 'AGENT_CREDENTIALS_SECRET');
      assert.equal(agentPut.input, readEnvValue(prodEnv, 'AGENT_CREDENTIALS_SECRET'));

      const again = recorder();
      await setupKeys({ cwd, remote: true, wrangler: again.run, applySql: async () => {} });
      assert.equal(readFileSync(path.join(cwd, '.env.production'), 'utf8'), prodEnv, 'second run reuses production keys');

      // A value typed into .env.production is replaced and sent to Cloudflare.
      writeFileSync(path.join(cwd, '.env.production'), upsertEnv(prodEnv, { AGENT_CREDENTIALS_SECRET: 'this is a secret this is a secret' }));
      const fixed = recorder();
      const repaired = await setupKeys({ cwd, remote: true, wrangler: fixed.run, applySql: async () => {} });
      assert.match(repaired.notes.join('\n'), /AGENT_CREDENTIALS_SECRET in \.env\.production is not 64 hex characters/);
      const repairedValue = readEnvValue(readFileSync(path.join(cwd, '.env.production'), 'utf8'), 'AGENT_CREDENTIALS_SECRET');
      assert.match(repairedValue, /^[0-9a-f]{64}$/);
      assert.equal(fixed.calls.find((c) => c.args[2] === 'AGENT_CREDENTIALS_SECRET').input, repairedValue);
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

describe('setupKeys --remote decides from the target', () => {
  const ALL = ['E9_ADMIN_API_KEY', 'E9_PUBLIC_API_KEY', 'SESSION_SECRET', 'AGENT_CREDENTIALS_SECRET'];
  function worker(secretNames, { listFails } = {}) {
    const calls = [];
    const run = (args, _cwd, input) => {
      calls.push({ args, input });
      if (args[0] === 'secret' && args[1] === 'list') {
        if (listFails) throw new Error(listFails);
        return JSON.stringify(secretNames.map((name) => ({ name, type: 'secret_text' })));
      }
      return '';
    };
    const puts = () => calls.filter((c) => c.args[0] === 'secret' && c.args[1] === 'put').map((c) => c.args[2]).sort();
    const sql = () => calls.filter((c) => c.args[0] === 'd1').map((c) => c.args.at(-1)).join(' ');
    return { calls, run, puts, sql };
  }
  function freshRunner() {
    const cwd = mkdtempSync(path.join(tmpdir(), 'e9-keys-runner-'));
    writeFileSync(path.join(cwd, 'wrangler.jsonc'), '{}\n');
    return cwd;
  }

  it('a second run on a fresh runner changes nothing the Worker already has', async () => {
    const cwd = freshRunner();
    try {
      const target = worker(ALL);
      const result = await setupKeys({ cwd, remote: true, wrangler: target.run });
      assert.deepEqual(target.puts(), [], 'no secret is replaced');
      assert.equal(target.sql(), '', 'no key row is written or turned off');
      assert.ok(!existsSync(path.join(cwd, '.env')), 'a remote run does not write .env');
      assert.deepEqual(result.remote.kept.sort(), [...ALL].sort());
      assert.match(result.notes.join('\n'), /Kept .*already production Worker secrets/);
      assert.match(result.notes.join('\n'), /--remote/);
      assert.equal(result.reused, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a first run on a fresh runner makes every key and secret, and no local ones', async () => {
    const cwd = freshRunner();
    try {
      const target = worker([]);
      const result = await setupKeys({ cwd, remote: true, wrangler: target.run });
      assert.deepEqual(target.puts(), [...ALL].sort());
      const prod = readFileSync(path.join(cwd, '.env.production'), 'utf8');
      for (const name of ALL) assert.ok(readEnvValue(prod, name), name);
      assert.match(target.sql(), /INSERT OR IGNORE INTO api_key .*'site-admin'/);
      assert.match(target.sql(), /INSERT OR IGNORE INTO api_key .*'site-public'/);
      assert.match(target.sql(), /UPDATE api_key SET active = 0 WHERE name = 'site-admin' AND key_hash <>/);
      assert.ok(!existsSync(path.join(cwd, '.env')));
      assert.equal(result.created.admin, true);
      assert.equal(result.created.session, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('adds only what is missing, with the public key the committed page config carries', async () => {
    const cwd = freshRunner();
    try {
      mkdirSync(path.join(cwd, 'public'));
      const publicKey = 'e9publickey_committed0123456789';
      writeFileSync(path.join(cwd, 'public', 'engine9-config.js'), `window.ENGINE9_PUBLIC_KEY = "${publicKey}";\n`);
      const target = worker(['SESSION_SECRET', 'AGENT_CREDENTIALS_SECRET']);
      await setupKeys({ cwd, remote: true, wrangler: target.run });
      assert.deepEqual(target.puts(), ['E9_ADMIN_API_KEY', 'E9_PUBLIC_API_KEY']);
      const pubPut = target.calls.find((c) => c.args[2] === 'E9_PUBLIC_API_KEY');
      assert.equal(pubPut.input, publicKey);
      assert.doesNotMatch(target.sql(), /name = 'site-public'/, 'the public key in use is not turned off');
      const prod = readFileSync(path.join(cwd, '.env.production'), 'utf8');
      assert.equal(readEnvValue(prod, 'SESSION_SECRET'), '', 'a kept secret is not invented locally');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--rotate replaces every secret without asking the Worker', async () => {
    const cwd = freshRunner();
    try {
      const target = worker(ALL);
      await setupKeys({ cwd, remote: true, rotate: true, wrangler: target.run });
      assert.ok(!target.calls.some((c) => c.args[1] === 'list'));
      assert.deepEqual(target.puts(), [...ALL].sort());
      assert.match(target.sql(), /name = 'site-public' AND key_hash <>/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses to guess when the secret list cannot be read', async () => {
    const cwd = freshRunner();
    try {
      const target = worker([], { listFails: 'Authentication error [code: 10000]' });
      await assert.rejects(setupKeys({ cwd, remote: true, wrangler: target.run }), /cannot tell which exist/);
      assert.deepEqual(target.puts(), []);
      const missing = worker([], { listFails: 'This Worker does not exist on your account. [code: 10007]' });
      await setupKeys({ cwd, remote: true, wrangler: missing.run });
      assert.equal(missing.puts().length, 4, 'a Worker that is not deployed yet has no secrets');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('local setup after a remote-only run uses the same public key', async () => {
    const cwd = freshRunner();
    try {
      await setupKeys({ cwd, remote: true, wrangler: worker([]).run });
      const prodPublic = readEnvValue(readFileSync(path.join(cwd, '.env.production'), 'utf8'), 'E9_PUBLIC_API_KEY');
      const inserted = [];
      const local = await setupKeys({ cwd, applySql: async (sql) => inserted.push(sql) });
      assert.equal(readEnvValue(readFileSync(path.join(cwd, '.env'), 'utf8'), 'E9_PUBLIC_API_KEY'), prodPublic);
      assert.equal(local.created.public, false);
      assert.ok(inserted.some((sql) => /^INSERT INTO api_key .*'site-public'/.test(sql)), 'its hash goes into the local database');
      assert.ok(inserted.every((sql) => !/OR IGNORE/.test(sql)), 'SQL MySQL accepts too');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
