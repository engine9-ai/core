import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_STEPS } from '../api/setupSteps.js';
import { renderWizardHtml } from '../api/setupPage.js';
import { runSetupStep } from '../bin/setupFlow.js';

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
