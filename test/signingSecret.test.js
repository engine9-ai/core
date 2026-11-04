import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningSecret, signingSecretProblem } from '../auth/index.js';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';

const TYPED = ['I am god', 'this is a secret', 'this is a secret this is a secret', 'correct-horse-battery-staple-correct-horse'];

test('a signing secret is 64 random hex characters; anything a person would type is refused', () => {
  const made = generateSigningSecret();
  assert.match(made, /^[0-9a-f]{64}$/);
  assert.notEqual(made, generateSigningSecret());
  assert.equal(signingSecretProblem(made), null);
  assert.equal(signingSecretProblem(made.toUpperCase()), null, 'openssl output in either case');

  for (const value of TYPED) assert.match(signingSecretProblem(value), /64 hex characters/, value);
  assert.match(signingSecretProblem(`${made}0`), /64 hex characters/, 'not a longer one either');
  assert.match(signingSecretProblem('0'.repeat(64)), /too few characters/);
  assert.match(signingSecretProblem('deadbeef'.repeat(8)), /too few characters/);
  assert.equal(signingSecretProblem(''), 'is not set');
  assert.equal(signingSecretProblem(undefined), 'is not set');
});

test('createDelegateAuth refuses a session secret someone typed', () => {
  const worker = { accountId: 'site' };
  assert.throws(
    () => createDelegateAuth({ worker, delegateUrl: 'https://delegate.network', sessionSecret: 'I am god' }),
    /SESSION_SECRET\) is not 64 hex characters.*setup-keys/
  );
});

test('createApi keeps login off with a typed SESSION_SECRET and says how to fix it', async () => {
  const api = createApi({ worker: { accountId: 'site' }, keyStore: {}, delegate: { sessionSecret: 'I am god' } });
  const res = await api.handle({ method: 'GET', path: '/auth/start', headers: { host: 'www.example.com' } });
  assert.equal(res.status, 501);
  assert.match(res.body.error, /SESSION_SECRET is not 64 hex characters/);
  assert.match(res.body.error, /npx e9core setup-keys/);
  assert.ok(!res.body.error.includes('I am god'), 'the value is never echoed');
});
