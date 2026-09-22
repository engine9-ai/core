import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../bin/setup.js';
import { serve } from '../bin/serve.js';
import { readEnvValue } from '../bin/setupKeys.js';

test('e9core serve listens and answers /api/ok', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-serve-'));
  let closer;
  const port = 18787 + Math.floor(Math.random() * 1000);
  try {
    await setup({ cwd, node: true, name: 'serve-test' });
    mkdirSync(path.join(cwd, 'public'), { recursive: true });
    writeFileSync(path.join(cwd, 'public', 'index.html'), '<html><body>hi</body></html>\n');

    const result = await serve({
      cwd,
      port,
      listen: true,
      runCommand: async (args) => {
        if (args[1] === 'whoami') return { status: 0, stdout: 'you@example.com\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      runSetup: async () => ({ notes: ['ok'] })
    });
    closer = result.close;
    assert.match(result.notes.join('\n'), /Open setup:/);

    const ok = await fetch(`http://127.0.0.1:${port}/api/ok`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hi/);

    const token = readEnvValue(readFileSync(path.join(cwd, '.env'), 'utf8'), 'E9_SETUP_TOKEN');
    assert.ok(token);
    const setupPage = await fetch(`http://127.0.0.1:${port}/setup?token=${token}`);
    assert.equal(setupPage.status, 200);
    assert.match(await setupPage.text(), /Cloudflare/);

    const apiSetup = await fetch(`http://127.0.0.1:${port}/api/setup?token=${token}`);
    assert.equal(apiSetup.status, 401);
    assert.match(apiSetup.headers.get('content-type') || '', /json/);

    const denied = await fetch(`http://127.0.0.1:${port}/setup?token=nope`);
    assert.equal(denied.status, 404);

    const choose = await fetch(`http://127.0.0.1:${port}/setup?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'choose', host: 'cloudflare' })
    });
    assert.equal(choose.status, 200);
    assert.equal((await choose.json()).host, 'cloudflare');

    const who = await fetch(`http://127.0.0.1:${port}/setup?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'whoami' })
    });
    assert.equal((await who.json()).account, 'you@example.com');

    const done = await fetch(`http://127.0.0.1:${port}/setup?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'finish' })
    });
    assert.equal(done.status, 200);
    const closed = await fetch(`http://127.0.0.1:${port}/setup?token=${token}`);
    assert.equal(closed.status, 404);
    assert.equal(readEnvValue(readFileSync(path.join(cwd, '.env'), 'utf8'), 'E9_SETUP_TOKEN'), '');
  } finally {
    if (closer) await closer().catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});
