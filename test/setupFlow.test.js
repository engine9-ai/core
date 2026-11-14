import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_STEPS } from '../api/setupSteps.js';
import { renderWizardHtml } from '../api/setupPage.js';
import { runSetupStep } from '../bin/setupFlow.js';
import PluginWorker from '../lib/PluginWorker.js';

test('wizard HTML and setup steps share the same questions', () => {
  const html = renderWizardHtml({ token: 'tok' });
  for (const step of SETUP_STEPS) {
    assert.match(html, new RegExp(step.prompt.replace(/[?]/g, '\\?')));
  }
  assert.match(html, /Cloudflare/);
  assert.match(html, /Your own servers/);
});

test('runSetupStep choose is what the wizard and the CLI both call', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-step-'));
  try {
    const result = await runSetupStep(
      { action: 'choose', host: 'cloudflare' },
      { cwd, runCommand: async () => ({ status: 0, stdout: '', stderr: '' }) }
    );
    assert.equal(result.host, 'cloudflare');
    const state = JSON.parse(readFileSync(path.join(cwd, '.e9core', 'wizard.json'), 'utf8'));
    assert.equal(state.host, 'cloudflare');

    const node = await runSetupStep({ action: 'choose', host: 'node' }, { cwd });
    assert.equal(node.host, 'node');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the plugins step recommends the contact edition and records the choice in package.json', async () => {
  const plugins = SETUP_STEPS.find((s) => s.id === 'plugins');
  const order = SETUP_STEPS.map((s) => s.id);
  assert.ok(order.indexOf('plugins') < order.indexOf('setup-cloudflare'), 'chosen before the local project is created');
  assert.ok(order.indexOf('plugins') < order.indexOf('setup-node'));
  assert.equal(plugins.choices[0].id, '@engine9/schemas/editions/contact');
  assert.match(plugins.choices[0].label, /recommended/);
  assert.doesNotMatch(JSON.stringify(plugins), /pii-free/, 'new users are not pointed at pii-free');
  assert.match(plugins.advancedNote, /changes what the site can do/);
  const html = renderWizardHtml({ token: 'tok' });
  assert.match(html, /Contact edition \(recommended\)/);

  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-step-'));
  try {
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'site', engine9: { pluginPackages: ['@engine9/schemas'] } }));
    const chosen = await runSetupStep({ action: 'plugins' }, { cwd });
    assert.deepEqual(chosen.install, ['@engine9/schemas/editions/contact']);
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.engine9, { pluginPackages: ['@engine9/schemas'], install: ['@engine9/schemas/editions/contact'] });

    const none = await runSetupStep({ action: 'plugins', none: true }, { cwd });
    assert.deepEqual(none.install, []);
    await assert.rejects(runSetupStep({ action: 'plugins', plugin: ' ' }, { cwd }), /Name a plugin path/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the plugins step installs into a local database that already exists', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'e9-step-'));
  const worker = new PluginWorker({ accountId: 'local', auth: { database_connection: 'sqlite://:memory:' } });
  try {
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'site' }));
    await worker.installRequiredPlugins();
    const result = await runSetupStep({ action: 'plugins' }, { cwd, worker });
    assert.ok(result.notes.some((n) => /Installed @engine9\/schemas\/editions\/contact in the local development database/.test(n)));
    assert.ok((await worker.tables()).tables.includes('person_email'));
  } finally {
    await worker.destroy();
    rmSync(cwd, { recursive: true, force: true });
  }
});
