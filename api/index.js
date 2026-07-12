/*
  Engine9 client API.

  Framework-agnostic endpoint handlers deployable as a Cloudflare Worker
  (fetch handler), inside Express, or any other HTTP layer.  Endpoints:

    GET  /ok                    -- health check (no auth)
    POST /people                -- run records through the inbound person
                                   pipeline (same flow as server loadPeople)
                                   body: { people: [...], options?: {...} }
    POST /upsert/:table         -- table upsert using the shared upsert logic
                                   body: { rows: [...] }
    GET  /read/:name            -- read a configured table; optionally gated
                                   by person_segment membership

  Every modification is saved to the database, then written to the
  modification log.  Authentication uses the pluggable API key layer in
  ../auth (SQL or Cloudflare KV store).

  Usage:
    const api = createApi({
      worker,           // client PersonWorker
      keyStore,         // SqlApiKeyStore | KVApiKeyStore
      logger,           // JsonlFileLogger | BatchLogger | NullLogger
      config: {
        pluginId,                       // plugin id used for people writes
        defaultRemoteInputId: 'website',
        upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
        reads: {
          // name -> read definition; segmentId gates rows by person_segment
          content: { table: 'content', segmentId: null, columns: ['*'] }
        }
      }
    });
    // Cloudflare: export default { fetch: (req, env, ctx) => api.handleFetch(req, { ctx }) }
    // Express:    app.use('/api', api.expressHandler());
*/
import debug$0 from 'debug';
import { NullLogger } from '../logging/index.js';

const debug = debug$0('client:api');

const SCOPES = {
  PEOPLE_WRITE: 'people:write',
  TABLES_WRITE: 'tables:write',
  DATA_READ: 'data:read'
};

function hasScope(key, scope) {
  const scopes = key?.scopes || [];
  if (scopes.length === 0) return true; // no scopes recorded = full access
  return scopes.indexOf(scope) >= 0 || scopes.indexOf('*') >= 0;
}

function json(status, body) {
  return { status, body };
}

export function createApi({ worker, keyStore, logger = new NullLogger(), config = {} }) {
  if (!worker) throw new Error('createApi requires a worker (client PersonWorker)');
  if (!keyStore) throw new Error('createApi requires a keyStore (see @engine9/core/auth)');
  const {
    pluginId,
    defaultRemoteInputId = 'website',
    defaultInputType = 'api',
    upsertTables = ['person_email', 'person_phone', 'person_address', 'person_segment'],
    reads = {},
    maxBatchSize = 500,
    maxReadLimit = 1000
  } = config;

  async function logModification(entry) {
    try {
      await logger.log({ accountId: worker.accountId, ...entry });
    } catch (e) {
      // A failed log write should not fail the (already committed) request,
      // but it must be loudly visible.
      debug('MODIFICATION LOG WRITE FAILED:', e);
    }
  }

  async function postPeople({ body, apiKey }) {
    if (!hasScope(apiKey, SCOPES.PEOPLE_WRITE)) return json(403, { error: 'missing scope people:write' });
    const people = body?.people || body?.batch;
    if (!Array.isArray(people) || people.length === 0) {
      return json(400, { error: 'body.people must be a non-empty array' });
    }
    if (people.length > maxBatchSize) return json(400, { error: `body.people exceeds max batch size ${maxBatchSize}` });
    const options = body.options || {};
    if (!pluginId && !options.doNotUpsert) return json(500, { error: 'api is not configured with a pluginId' });
    let summary;
    try {
      summary = await worker.processPeople({
        pluginId,
        remoteInputId: options.remoteInputId || defaultRemoteInputId,
        inputType: options.inputType || defaultInputType,
        defaultSourceCode: options.sourceCode,
        defaultEntryType: options.entryType,
        doNotUpsert: options.doNotUpsert,
        batch: people
      });
    } catch (e) {
      debug('postPeople error:', e);
      return json(422, { error: String(e.message || e) });
    }
    if (!options.doNotUpsert) {
      await logModification({
        action: 'people.process',
        records: summary.records,
        personIds: summary.personIds,
        apiKeyId: apiKey?.id,
        meta: { remoteInputId: options.remoteInputId || defaultRemoteInputId }
      });
    }
    return json(200, {
      records: summary.records,
      recordsWithPersonIds: summary.recordsWithPersonIds,
      personIds: summary.personIds
    });
  }

  async function postUpsert({ table, body, apiKey }) {
    if (!hasScope(apiKey, SCOPES.TABLES_WRITE)) return json(403, { error: 'missing scope tables:write' });
    if (!table || upsertTables.indexOf(table) < 0) {
      return json(403, { error: `table '${table}' is not in the configured upsert allowlist` });
    }
    const rows = body?.rows || body?.array;
    if (!Array.isArray(rows) || rows.length === 0) return json(400, { error: 'body.rows must be a non-empty array' });
    if (rows.length > maxBatchSize) return json(400, { error: `body.rows exceeds max batch size ${maxBatchSize}` });
    try {
      await worker.upsertArray({ table, array: rows });
    } catch (e) {
      debug('postUpsert error:', e);
      return json(422, { error: String(e.message || e) });
    }
    await logModification({
      action: 'table.upsert',
      table,
      records: rows.length,
      apiKeyId: apiKey?.id
    });
    return json(200, { table, records: rows.length });
  }

  async function getRead({ name, query, apiKey }) {
    if (!hasScope(apiKey, SCOPES.DATA_READ)) return json(403, { error: 'missing scope data:read' });
    const read = reads[name];
    if (!read) return json(404, { error: `no configured read named '${name}'` });
    const personId = query.person_id ? parseInt(query.person_id, 10) : null;
    if (read.segmentId) {
      // Content is gated by person_segment membership.  person_id is provided
      // by the caller (e.g. via delegate) -- no person lookups are performed.
      if (!personId) return json(401, { error: 'person_id is required for segment-gated content' });
      const { data: membership } = await worker.query({
        sql: 'select person_id from person_segment where segment_id=? and person_id=?',
        values: [read.segmentId, personId]
      });
      if (membership.length === 0) return json(403, { error: 'person is not a member of the required segment' });
    }
    const limit = Math.min(parseInt(query.limit, 10) || 100, maxReadLimit);
    const offset = parseInt(query.offset, 10) || 0;
    const columns = (read.columns || ['*']).map((c) => (c === '*' ? '*' : worker.escapeColumn(c))).join(',');
    let sql = `select ${columns} from ${worker.escapeTable(read.table)}`;
    const conditions = [];
    const values = [];
    if (read.where) conditions.push(read.where); // static, from trusted config
    if (read.personColumn && personId) {
      conditions.push(`${worker.escapeColumn(read.personColumn)}=?`);
      values.push(personId);
    }
    if (conditions.length > 0) sql += ` where ${conditions.join(' and ')}`;
    if (read.orderBy) sql += ` order by ${worker.escapeColumn(read.orderBy)}${read.orderByDesc ? ' desc' : ''}`;
    sql = worker.addLimit(sql, limit, offset);
    try {
      const { data } = await worker.query({ sql, values });
      return json(200, { name, records: data.length, data });
    } catch (e) {
      debug('getRead error:', e);
      return json(422, { error: String(e.message || e) });
    }
  }

  /* Core dispatch on a normalized request:
     { method, path, query, body, headers } -- path relative to the api root */
  async function handle(req) {
    const method = (req.method || 'GET').toUpperCase();
    const parts = (req.path || '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (method === 'GET' && (parts[0] === 'ok' || parts.length === 0)) {
      try {
        await worker.ok();
        return json(200, { ok: true });
      } catch (e) {
        return json(503, { ok: false, error: String(e.message || e) });
      }
    }
    // Everything else requires a valid API key
    const verification = await keyStore.verify(req.original || req);
    if (!verification.valid) return json(401, { error: `unauthorized: ${verification.reason}` });
    const apiKey = verification.key;
    if (method === 'POST' && parts[0] === 'people') {
      return postPeople({ body: req.body, apiKey });
    }
    if (method === 'POST' && parts[0] === 'upsert') {
      return postUpsert({ table: parts[1], body: req.body, apiKey });
    }
    if (method === 'GET' && parts[0] === 'read') {
      return getRead({ name: parts[1], query: req.query || {}, apiKey });
    }
    return json(404, { error: `no route for ${method} /${parts.join('/')}` });
  }

  /* Cloudflare Workers adapter.  basePath is stripped from the URL. */
  /** @param {Request} request
      @param {{ basePath?: string, ctx?: { waitUntil?: (p: Promise<unknown>) => void } }} [options] */
  async function handleFetch(request, { basePath = '/api', ctx } = {}) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (basePath && path.indexOf(basePath) === 0) path = path.slice(basePath.length) || '/';
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await handle({
      method: request.method,
      path,
      query,
      body,
      headers: request.headers,
      original: request
    });
    // flush batch logs without blocking the response when a ctx is available
    if (ctx?.waitUntil) ctx.waitUntil(logger.flush());
    else await logger.flush();
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' }
    });
  }

  /* Express adapter: app.use('/api', api.expressHandler()) */
  function expressHandler() {
    return async (req, res) => {
      try {
        const result = await handle({
          method: req.method,
          path: req.path,
          query: req.query,
          body: req.body,
          headers: req.headers,
          original: req
        });
        await logger.flush();
        res.status(result.status).json(result.body);
      } catch (e) {
        debug('api error:', e);
        res.status(500).json({ error: 'internal error' });
      }
    };
  }

  return { handle, handleFetch, expressHandler };
}

export { SCOPES };
export default { createApi, SCOPES };
