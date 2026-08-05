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
    POST /auth/role             -- change role (requires delegateAuth); body:
                                   { role_id, person_id?, exclusive?, session_token? }

  Auth layers (see package README):
    1. API key (required on all routes except /ok)
    2. Role (role_id = segment UUID; scopes from role registry ∩ key scopes)
    3. Delegate credential level (session.auth; requiredAuth on roles)

  Usage:
    const api = createApi({
      worker,           // client PersonWorker
      keyStore,         // SqlApiKeyStore | KVApiKeyStore
      logger,           // JsonlFileLogger | BatchLogger | NullLogger
      delegateAuth,     // optional createDelegateAuth() — enables POST /auth/role
      config: {
        pluginId,
        defaultRemoteInputId: 'website',
        upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
        roles: { '<segment-uuid>': { name: 'VIP', scopes: ['data:read'] } },
        reads: {
          content: { table: 'content', segmentId: null, columns: ['*'] }
        }
      }
    });
*/
import debug$0 from 'debug';
import { NullLogger } from '../logging/index.js';
import { resolveAuthContext, hasScope as scopesAllow } from '../auth/policy.js';
import { normalizeRoleRegistry } from '../auth/delegate.js';

const debug = debug$0('client:api');

const SCOPES = {
  PEOPLE_WRITE: 'people:write',
  TABLES_WRITE: 'tables:write',
  DATA_READ: 'data:read',
  /** List/read flows, flow runs, and task run status (Task API) */
  TASKS_READ: 'tasks:read',
  /** Schedule tasks / create flow runs (Task API → scheduleTasks) */
  TASKS_SCHEDULE: 'tasks:schedule'
};

function json(status, body) {
  return { status, body };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || null;
}

export function createApi({
  worker,
  keyStore,
  logger = new NullLogger(),
  delegateAuth = null,
  config = {}
}) {
  if (!worker) throw new Error('createApi requires a worker (client PersonWorker)');
  if (!keyStore) throw new Error('createApi requires a keyStore (see @engine9/core/auth)');
  const {
    pluginId,
    defaultRemoteInputId = 'website',
    defaultInputType = 'api',
    upsertTables = ['person_email', 'person_phone', 'person_address', 'person_segment'],
    reads = {},
    maxBatchSize = 500,
    maxReadLimit = 1000,
    roles: configRoles,
    roleSegments: configRoleSegments
  } = config;

  const rolesRegistry =
    delegateAuth?.roleRegistry ||
    normalizeRoleRegistry({ roles: configRoles, roleSegments: configRoleSegments });

  function authContextFor({ apiKey, query, body, session }) {
    const roleId =
      body?.role_id ||
      body?.roleId ||
      query?.role_id ||
      query?.roleId ||
      null;
    return resolveAuthContext({
      apiKey,
      roleId,
      session,
      rolesRegistry
    });
  }

  function requireScope(ctx, scope) {
    if (!ctx.authSatisfied) {
      return json(403, { error: 'delegate credential level does not meet role requiredAuth' });
    }
    if (!scopesAllow(ctx.scopes, scope)) {
      return json(403, { error: `missing scope ${scope}` });
    }
    return null;
  }

  async function logModification(entry) {
    try {
      await logger.log({ accountId: worker.accountId, ...entry });
    } catch (e) {
      // A failed log write should not fail the (already committed) request,
      // but it must be loudly visible.
      debug('MODIFICATION LOG WRITE FAILED:', e);
    }
  }

  async function postPeople({ body, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body, session });
    const denied = requireScope(ctx, SCOPES.PEOPLE_WRITE);
    if (denied) return denied;
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
        roleId: ctx.roleId,
        meta: { remoteInputId: options.remoteInputId || defaultRemoteInputId }
      });
    }
    return json(200, {
      records: summary.records,
      recordsWithPersonIds: summary.recordsWithPersonIds,
      personIds: summary.personIds
    });
  }

  async function postUpsert({ table, body, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body, session });
    const denied = requireScope(ctx, SCOPES.TABLES_WRITE);
    if (denied) return denied;
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
      apiKeyId: apiKey?.id,
      roleId: ctx.roleId
    });
    return json(200, { table, records: rows.length });
  }

  async function getRead({ name, query, apiKey, session }) {
    const ctx = authContextFor({ apiKey, query, body: null, session });
    const denied = requireScope(ctx, SCOPES.DATA_READ);
    if (denied) return denied;
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

  async function postAuthRole({ body, apiKey, headers }) {
    if (!delegateAuth) {
      return json(501, { error: 'change-role requires delegateAuth on createApi' });
    }
    const roleId = body?.role_id || body?.roleId;
    if (!roleId) return json(400, { error: 'body.role_id is required' });

    let session = null;
    const sessionToken =
      body?.session_token ||
      body?.sessionToken ||
      getHeader(headers, 'X-Engine9-Session') ||
      getHeader(headers, 'x-engine9-session');
    if (sessionToken) {
      session = delegateAuth.verify(sessionToken);
      if (!session) return json(401, { error: 'invalid session' });
    }

    const personId = body?.person_id || body?.personId || session?.personId;
    if (!personId) return json(400, { error: 'person_id or session_token is required' });

    const exclusive = body?.exclusive !== undefined ? Boolean(body.exclusive) : true;
    try {
      const result = await delegateAuth.changeRole({
        personId,
        roleId,
        exclusive,
        session
      });
      await logModification({
        action: 'auth.change_role',
        personIds: [personId],
        apiKeyId: apiKey?.id,
        roleId: result.roles[0] || roleId
      });
      return json(200, {
        roles: result.roles,
        token: result.token,
        session: result.session
      });
    } catch (e) {
      debug('postAuthRole error:', e);
      const msg = String(e.message || e);
      if (msg.indexOf('Unknown role') === 0) return json(400, { error: msg });
      return json(422, { error: msg });
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
    // Everything else requires a valid API key (layer 1)
    const verification = await keyStore.verify(req.original || req);
    if (!verification.valid) return json(401, { error: `unauthorized: ${verification.reason}` });
    const apiKey = verification.key;

    let session = null;
    if (delegateAuth) {
      const sessionToken =
        req.body?.session_token ||
        getHeader(req.headers, 'X-Engine9-Session') ||
        getHeader(req.headers, 'x-engine9-session');
      if (sessionToken) session = delegateAuth.verify(sessionToken);
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'role') {
      return postAuthRole({ body: req.body, apiKey, headers: req.headers });
    }
    if (method === 'POST' && parts[0] === 'people') {
      return postPeople({ body: req.body, apiKey, query: req.query || {}, session });
    }
    if (method === 'POST' && parts[0] === 'upsert') {
      return postUpsert({
        table: parts[1],
        body: req.body,
        apiKey,
        query: req.query || {},
        session
      });
    }
    if (method === 'GET' && parts[0] === 'read') {
      return getRead({ name: parts[1], query: req.query || {}, apiKey, session });
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
