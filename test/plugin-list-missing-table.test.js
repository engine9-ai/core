import { test } from 'node:test';
import assert from 'node:assert/strict';
import PluginWorker from '../lib/PluginWorker.js';
import { isMissingTableError } from '../lib/sql/shared.js';

function mysqlMissingPluginTableError() {
  const error = new Error("Table 'lautman_parkinsons_foundation.plugin' doesn't exist");
  error.code = 'ER_NO_SUCH_TABLE';
  error.errno = 1146;
  return error;
}

test('isMissingTableError matches MySQL missing plugin table', () => {
  assert.equal(isMissingTableError(mysqlMissingPluginTableError()), true);
  assert.equal(isMissingTableError(new Error('connection lost')), false);
  assert.equal(isMissingTableError({ code: 'DOES_NOT_EXIST' }), true);
  assert.equal(isMissingTableError({ does_not_exist: true }), true);
  assert.equal(isMissingTableError(new Error('no such table: plugin')), true);
});

test('list returns empty when plugin table is missing', async () => {
  const worker = new PluginWorker({
    accountId: 'incomplete',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    assert.deepEqual(await worker.list(), []);
    assert.deepEqual(await worker.list({ fields: '*' }), []);
  } finally {
    await worker.destroyAll();
  }
});

test('getSettings returns empty when setting table is missing', async () => {
  const worker = new PluginWorker({
    accountId: 'incomplete',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    const settings = await worker.getSettings({ pluginId: '00000000-0000-4000-a000-000000000001' });
    assert.deepEqual(settings, {});
  } finally {
    await worker.destroyAll();
  }
});

test('list rethrows errors other than a missing plugin table', async () => {
  const worker = new PluginWorker({
    accountId: 'incomplete',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  const originalQuery = worker.query.bind(worker);
  worker.query = async () => {
    throw new Error('connection lost');
  };
  try {
    await assert.rejects(() => worker.list(), /connection lost/);
  } finally {
    worker.query = originalQuery;
    await worker.destroyAll();
  }
});

test('listSettings returns empty plugins when plugin table is missing', async () => {
  const worker = new PluginWorker({
    accountId: 'incomplete',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  try {
    const catalog = await worker.listSettings();
    assert.equal(catalog.account_id, 'incomplete');
    assert.deepEqual(catalog.plugins, []);
  } finally {
    await worker.destroyAll();
  }
});

test('list treats MySQL ER_NO_SUCH_TABLE as no plugins', async () => {
  const worker = new PluginWorker({
    accountId: 'incomplete',
    auth: { database_connection: 'sqlite://:memory:' }
  });
  const originalQuery = worker.query.bind(worker);
  worker.query = async () => {
    throw mysqlMissingPluginTableError();
  };
  try {
    assert.deepEqual(await worker.list({ fields: '*' }), []);
  } finally {
    worker.query = originalQuery;
    await worker.destroyAll();
  }
});
