import { test } from 'node:test';
import assert from 'node:assert/strict';
import PersonWorker from '../lib/PersonWorker.js';
import { SqlApiKeyStore } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { applyStandardStack, ensurePluginRow } from './helpers/applySchemas.js';
import { getPluginUUID } from '../lib/utilities.js';

test('production API has no setup route; CORS still honors allowed origins', async () => {
  const worker = new PersonWorker({
    accountId: 'test',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    await applyStandardStack(worker);
    const pluginId = getPluginUUID('engine9.test', 'website');
    await ensurePluginRow(worker, { id: pluginId, path: 'website', name: 'Website' });
    const keyStore = new SqlApiKeyStore({ worker });
    await keyStore.deploy();
    const api = createApi({
      worker,
      keyStore,
      config: {
        pluginId,
        allowedOrigins: 'https://allowed.example'
      }
    });

    const setup = await api.handle({
      method: 'GET',
      path: '/setup',
      query: { token: 'anything' }
    });
    assert.equal(setup.status, 401);
    assert.equal(setup.contentType, 'application/json');

    const preflightOk = await api.handle({
      method: 'OPTIONS',
      path: '/people',
      headers: { Origin: 'https://allowed.example' }
    });
    assert.equal(preflightOk.status, 204);
    assert.equal(preflightOk.headers['access-control-allow-origin'], 'https://allowed.example');

    const preflightBad = await api.handle({
      method: 'OPTIONS',
      path: '/people',
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(preflightBad.status, 204);
    assert.equal(preflightBad.headers['access-control-allow-origin'], undefined);
  } finally {
    await worker.destroy();
  }
});
