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
    POST /auth/login            -- exchange delegate_token (requires API key + delegateAuth)
    GET  /auth/me               -- current User from session or Identity Token
    POST /auth/logout           -- { loggedOut: true }; cookie clear is the host's job
    POST /auth/role             -- change the caller's role (requires delegateAuth)
                                   body: { role_id, person_id?, exclusive?, session_token? }
                                   Same membership rules as /auth/segments, then
                                   returns a re-signed session token.
    POST /auth/segments         -- add or remove people in segments
                                   body: { add?: [...], remove?: [...] }
                                   an entry is a segment id (yourself) or
                                   { segment_id, person_id | email } (someone else)
                                   See docs/segments.md.

  Auth layers (see package README):
    1. API key (required on all routes except /ok)
    2. Role (role_id = segment UUID; scopes from role registry ∩ key scopes)
    3. Delegate credential level (session.auth + session.level; requiredAuth on roles)

  Identity: X-Engine9-Session (HMAC Core Session) and/or Authorization Bearer JWT
  (Identity Token; not e9key_/e9publickey_). Optional kvEnv caches Domain UNID → person_id.

  Usage:
    const api = createApi({
      worker,           // client PersonWorker
      keyStore,         // SqlApiKeyStore | KVApiKeyStore
      logger,           // JsonlFileLogger | BatchLogger | NullLogger
      delegateAuth,     // optional createDelegateAuth() — enables /auth/*
      kvEnv,            // optional Cloudflare env (PERSON_ID_DELEGATE_KV)
      config: {
        pluginId,
        defaultRemoteInputId: 'website',
        upsertTables: ['person_email', 'person_phone', 'person_address', 'person_segment'],
        roles: { '<segment-uuid>': { name: 'VIP', scopes: ['data:read'] } },
                          // or roles: 'standard' (auth/roleNames.js, ids from worker.accountId)
        reads: {
          content: { table: 'content', segmentId: null, columns: ['*'] }
        }
      }
    });
*/
import debug$0 from 'debug';
import { NullLogger } from '../logging/index.js';
import {
  resolveAuthContext,
  hasScope as scopesAllow,
  ADMIN_SCOPE,
  PUBLIC_SCOPE
} from '../auth/policy.js';
import {
  createDelegateAuth,
  normalizeRoleRegistry,
  resolveDelegatePersonId,
  isDelegateIdentityJwt,
  domainFromUrl,
  resolveRoleId
} from '../auth/delegate.js';
import { canEditSegmentMembership, loadMembershipPolicies } from '../auth/segmentAccess.js';
import { addPeopleToSegment, removePeopleFromSegment } from '../auth/roles.js';

export const DEFAULT_DELEGATE_URL = 'https://delegate.engine9.ai';
import { getPersonIdByDomainUnid, setDelegatePersonId } from '../cloudflare/kv/personIdDelegate.js';
import { getStoredOrigins, mergeOrigins, parseOriginList } from './setupPage.js';

const API_KEY_PREFIXES = ['e9key_', 'e9publickey_'];

function isApiKeyBearer(token) {
  const t = String(token || '');
  return API_KEY_PREFIXES.some((p) => t.indexOf(p) === 0);
}

function extractBearer(headers) {
  const auth = getHeader(headers, 'Authorization') || getHeader(headers, 'authorization');
  if (auth && String(auth).indexOf('Bearer ') === 0) {
    return String(auth).slice('Bearer '.length).trim();
  }
  return null;
}

const debug = debug$0('client:api');

const SCOPES = {
  PEOPLE_WRITE: 'people:write',
  TABLES_WRITE: 'tables:write',
  DATA_READ: 'data:read',
  /** List/read flows, flow runs, and task run status (Task API) */
  TASKS_READ: 'tasks:read',
  /** Schedule tasks / create flow runs (Task API → scheduleTasks) */
  TASKS_SCHEDULE: 'tasks:schedule',
  /** Full access — same string as ADMIN_SCOPE in auth/policy.js */
  ADMIN: ADMIN_SCOPE,
  /** Inbound / public forms — same string as PUBLIC_SCOPE; keys use e9publickey_ prefix */
  PUBLIC: PUBLIC_SCOPE
};

function json(status, body, extra = {}) {
  return { status, body, contentType: 'application/json', ...extra };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || null;
}

/*
  Domain (JWT `aud`, host[:port]) implied by the request itself, used when the
  login body and createDelegateAuth do not name one. `@engine9/id` sets `aud`
  to the page's Domain, so the page `Origin` comes first; on a same-platform
  site that equals the API `Host`.
*/
export function requestDomain(headers) {
  const origin = getHeader(headers, 'Origin') || getHeader(headers, 'origin');
  const fromOrigin = origin && origin !== 'null' ? domainFromUrl(origin) : null;
  if (fromOrigin) return fromOrigin;
  const forwardedHost = getHeader(headers, 'X-Forwarded-Host') || getHeader(headers, 'x-forwarded-host');
  const host = String(forwardedHost || getHeader(headers, 'Host') || getHeader(headers, 'host') || '')
    .split(',')[0]
    .trim();
  if (!host) return undefined;
  // Normalizes case and drops an explicit default port (`:443`).
  return domainFromUrl(`https://${host}`) || undefined;
}

/**
 * @param {{
 *   worker: object,
 *   keyStore: object,
 *   logger?: object,
 *   delegateAuth?: object | null,
 *   delegate?: {
 *     sessionSecret?: string,
 *     delegateUrl?: string,
 *     domain?: string,
 *     sessionTtlSeconds?: number,
 *     fetchImpl?: typeof fetch
 *   } | null,
 *   kvEnv?: object | null,
 *   config?: Record<string, unknown>
 * }} opts
 *
 * Login (`/auth/*`) is on when `delegateAuth` is passed, or when
 * `delegate.sessionSecret` is set — then createApi builds the default
 * delegate provider itself using `config.pluginId` and `config.roles`.
 * Without either, `/auth/*` answers 501 and every other route still works.
 */
export function createApi({
  worker,
  keyStore,
  logger = new NullLogger(),
  delegateAuth = null,
  delegate = null,
  kvEnv = null,
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
    roleSegments: configRoleSegments,
    allowedOrigins: configAllowedOrigins = []
  } = config;

  if (!delegateAuth && delegate?.sessionSecret) {
    delegateAuth = createDelegateAuth({
      worker,
      delegateUrl: delegate.delegateUrl || DEFAULT_DELEGATE_URL,
      domain: delegate.domain || undefined,
      sessionSecret: delegate.sessionSecret,
      sessionTtlSeconds: delegate.sessionTtlSeconds,
      pluginId,
      roles: configRoles,
      roleSegments: configRoleSegments,
      ...(delegate.fetchImpl ? { fetchImpl: delegate.fetchImpl } : {})
    });
  }

  const envOrigins = parseOriginList(configAllowedOrigins);
  let cachedOrigins = envOrigins.slice();

  async function resolveAllowedOrigins() {
    try {
      const stored = await getStoredOrigins(worker);
      cachedOrigins = mergeOrigins(envOrigins, stored);
    } catch (e) {
      debug('resolveAllowedOrigins:', e);
      cachedOrigins = envOrigins.slice();
    }
    return cachedOrigins;
  }

  function corsHeaders(reqHeaders, { includeOrigin = true } = {}) {
    const requestOrigin = getHeader(reqHeaders, 'Origin') || getHeader(reqHeaders, 'origin');
    const headers = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, X-API-Key, X-Engine9-Session',
      'access-control-max-age': '86400'
    };
    if (!includeOrigin || !requestOrigin) return headers;
    if (cachedOrigins.includes(requestOrigin) || cachedOrigins.includes('*')) {
      headers['access-control-allow-origin'] = requestOrigin === '*' ? '*' : requestOrigin;
      headers.vary = 'Origin';
    }
    return headers;
  }

  function withCors(result, reqHeaders) {
    const headers = { ...(result.headers || {}), ...corsHeaders(reqHeaders) };
    return { ...result, headers };
  }

  const rolesRegistry =
    delegateAuth?.roleRegistry ||
    normalizeRoleRegistry({
      roles: configRoles,
      roleSegments: configRoleSegments,
      accountId: worker?.accountId
    });

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

  function requireAnyScope(ctx, scopes) {
    if (!ctx.authSatisfied) {
      return json(403, { error: 'delegate credential level does not meet role requiredAuth' });
    }
    if (!scopes.some((scope) => scopesAllow(ctx.scopes, scope))) {
      return json(403, { error: `missing scope ${scopes.join(' or ')}` });
    }
    return null;
  }

  function requireScope(ctx, scope) {
    return requireAnyScope(ctx, [scope]);
  }

  async function heldRoleIds(personId) {
    if (!personId) return [];
    const { data } = await worker.query({
      sql: 'select segment_id from person_segment where person_id=?',
      values: [personId]
    });
    return (data || []).map((row) => row.segment_id);
  }

  function callerFrom({ ctx, session, roleIds }) {
    return {
      isAdmin: scopesAllow(ctx.scopes, SCOPES.ADMIN),
      level: session?.level ?? 0,
      personId: session?.personId ?? null,
      roleIds: roleIds || [],
      scopes: ctx.scopes || [],
      twoFactor: Boolean(session?.auth?.twoFactor)
    };
  }

  function segmentIdsOnPeople(people, options) {
    const ids = [];
    const push = (value) => {
      if (value == null || value === '') return;
      for (const part of String(value).split(',')) {
        const id = part.trim();
        if (id && !ids.includes(id)) ids.push(id);
      }
    };
    push(options?.segmentIds);
    push(options?.segment_ids);
    for (const person of Array.isArray(people) ? people : []) {
      push(person?.segment_ids);
      push(person?.segmentIds);
    }
    return ids;
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
    // `public` (e9publickey_) is the signup-form scope; it may add people and
    // nothing else. `people:write` is the server-side equivalent.
    const denied = requireAnyScope(ctx, [SCOPES.PEOPLE_WRITE, SCOPES.PUBLIC]);
    if (denied) return denied;
    const people = body?.people || body?.batch;
    if (!Array.isArray(people) || people.length === 0) {
      return json(400, { error: 'body.people must be a non-empty array' });
    }
    if (people.length > maxBatchSize) return json(400, { error: `body.people exceeds max batch size ${maxBatchSize}` });
    const options = body.options || {};
    const requestedSegments = segmentIdsOnPeople(people, options);
    if (requestedSegments.length) {
      // The people in the batch are not signed in, whatever session the
      // caller has, so a session cannot attach a self-service role to
      // someone else's email. Only join_min_level 0 (public lists) passes.
      const policies = await loadMembershipPolicies(worker, requestedSegments, rolesRegistry);
      const caller = callerFrom({ ctx, session: null, roleIds: [] });
      for (const segmentId of requestedSegments) {
        const decision = canEditSegmentMembership({
          policy: policies[segmentId] || null,
          operation: 'add',
          caller,
          targetPersonId: null
        });
        if (!decision.allowed) return json(403, { error: decision.reason, segment_id: segmentId, subject: decision.subject });
      }
    }
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
    if (table === 'person_segment' && !scopesAllow(ctx.scopes, SCOPES.ADMIN)) {
      // A tables:write key may bulk-add people only to segments people could
      // add themselves to (join_min_level is not null). Segments with no
      // join_min_level (including both standard roles) need admin scope or
      // POST /auth/segments as a manager.
      const segmentIds = [];
      for (const row of rows) {
        const segmentId = row?.segment_id == null ? '' : String(row.segment_id).trim();
        if (!segmentId) return json(400, { error: 'person_segment rows require segment_id' });
        if (!segmentIds.includes(segmentId)) segmentIds.push(segmentId);
      }
      const policies = await loadMembershipPolicies(worker, segmentIds, rolesRegistry);
      for (const segmentId of segmentIds) {
        const policy = policies[segmentId];
        if (!policy) return json(403, { error: 'unknown segment', segment_id: segmentId });
        if (policy.joinMinLevel == null) {
          return json(403, {
            error: `cannot add other people to ${policy.name ? `'${policy.name}'` : 'this segment'} by upsert: join_min_level is not set, so this needs admin scope (or POST /auth/segments as its manager)`,
            segment_id: segmentId,
            subject: 'other'
          });
        }
      }
    }
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

  async function sessionFromIdentityToken(jwt, headers) {
    const delegateUser = await delegateAuth.verifyIdentityToken(jwt, {
      fallbackDomain: requestDomain(headers)
    });
    let personId = null;
    if (kvEnv?.PERSON_ID_DELEGATE_KV && !delegateUser.mergedFrom) {
      try {
        const cached = await getPersonIdByDomainUnid(kvEnv, delegateUser.domainUnid);
        const n = cached != null ? parseInt(cached, 10) : NaN;
        if (Number.isInteger(n)) personId = n;
      } catch {
        /* KV miss / missing binding — fall through to SQL */
      }
    }
    if (!Number.isInteger(personId)) {
      personId = await resolveDelegatePersonId({
        worker,
        delegateUser,
        pluginId,
        remoteInputId: 'delegate',
        inputType: defaultInputType
      });
      if (kvEnv?.PERSON_ID_DELEGATE_KV) {
        try {
          await setDelegatePersonId(kvEnv, delegateUser.domainUnid, personId);
        } catch {
          /* cache write is best-effort */
        }
      }
    }
    const roles = await delegateAuth.rolesForPerson(personId);
    return {
      personId,
      roles,
      domainUnid: delegateUser.domainUnid,
      domainProfile: delegateUser.domainProfile,
      email: delegateUser.email,
      auth: delegateUser.auth || {},
      level: delegateUser.level,
      profile: delegateUser.profile
    };
  }

  async function postAuthLogin({ body, headers }) {
    if (!delegateAuth) {
      return json(501, {
        error:
          'login is not enabled: set SESSION_SECRET (e9core setup writes it) or pass delegateAuth to createApi'
      });
    }
    const token = body?.delegate_token;
    if (!token) {
      return json(400, { error: 'delegate_token is required' });
    }
    const returnTo = body?.return_to || body?.returnTo;
    try {
      const result = await delegateAuth.login(token, {
        returnTo,
        domain: body?.domain,
        fallbackDomain: requestDomain(headers)
      });
      return json(200, { session: result.session, token: result.token });
    } catch (e) {
      debug('postAuthLogin error:', e);
      const status = e.reason === 'invalid_domain' ? 400 : e.kind === 'configuration' ? 503 : 401;
      return json(status, {
        error: e.userMessage || String(e.message || e),
        reason: e.reason
      });
    }
  }

  function getAuthMe({ session }) {
    if (!session || !Number.isInteger(session.personId)) {
      return json(401, { error: 'session or identity token required' });
    }
    const me = {
      personId: session.personId,
      roles: session.roles || [],
      level: session.level ?? null,
      domainUnid: session.domainUnid,
      domainProfile: session.domainProfile ?? null,
      auth: session.auth || {}
    };
    if (session.profile) me.profile = session.profile;
    return json(200, me);
  }

  function postAuthLogout() {
    // Core sessions are stateless HMAC tokens. Clearing the host cookie is
    // the host's job (Set-Cookie Max-Age=0). This route only acknowledges logout.
    return json(200, { loggedOut: true });
  }

  async function postAuthRole({ body, apiKey, headers, session, query }) {
    if (!delegateAuth) {
      return json(501, { error: 'change-role requires delegateAuth on createApi' });
    }
    const roleId = body?.role_id || body?.roleId;
    if (!roleId) return json(400, { error: 'body.role_id is required' });

    if (!session) {
      const sessionToken =
        body?.session_token ||
        body?.sessionToken ||
        getHeader(headers, 'X-Engine9-Session') ||
        getHeader(headers, 'x-engine9-session');
      if (sessionToken) {
        session = delegateAuth.verify(sessionToken);
        if (!session) return json(401, { error: 'invalid session' });
      }
    }

    const ctx = authContextFor({ apiKey, query, body, session });
    const isAdmin = scopesAllow(ctx.scopes, SCOPES.ADMIN);
    const requestedPersonId = body?.person_id || body?.personId;
    const requestedNum = requestedPersonId != null ? Number(requestedPersonId) : null;

    if (!session && !isAdmin) {
      return json(401, { error: 'session or identity token required' });
    }
    if (
      session &&
      requestedNum != null &&
      Number.isFinite(requestedNum) &&
      requestedNum !== Number(session.personId) &&
      !isAdmin
    ) {
      return json(403, { error: 'person_id does not match session' });
    }

    const personId = requestedPersonId || session?.personId;
    if (!personId) return json(400, { error: 'person_id or session is required' });

    const exclusive = body?.exclusive !== undefined ? Boolean(body.exclusive) : true;
    const resolvedRoleId = resolveRoleId(rolesRegistry, roleId) || roleId;
    if (!isAdmin) {
      if (!session?.personId) return json(401, { error: 'session or identity token required' });
      const held = await heldRoleIds(session.personId);
      const caller = callerFrom({ ctx, session, roleIds: held });
      const policies = await loadMembershipPolicies(worker, [resolvedRoleId, ...held], rolesRegistry);
      const add = canEditSegmentMembership({
        policy: policies[resolvedRoleId] || null,
        operation: 'add',
        caller,
        targetPersonId: session.personId
      });
      if (!add.allowed) return json(403, { error: add.reason, segment_id: resolvedRoleId, subject: add.subject });
      if (exclusive) {
        for (const heldId of held) {
          if (heldId === resolvedRoleId) continue;
          const remove = canEditSegmentMembership({
            policy: policies[heldId] || null,
            operation: 'remove',
            caller,
            targetPersonId: session.personId
          });
          if (!remove.allowed) return json(403, { error: remove.reason, segment_id: heldId, subject: remove.subject });
        }
      }
    }
    try {
      const result = await delegateAuth.changeRole({
        personId,
        roleId: resolvedRoleId,
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

  /**
   * Parse one list of membership edits. An entry is either a segment id
   * string (the session person) or { segment_id, person_id? | email? }.
   * No person_id and no email also means the session person.
   */
  function membershipEdits(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map((item) => {
      if (typeof item === 'string') {
        const segmentId = item.trim();
        if (!segmentId) throw new Error(`${label} entries require segment_id`);
        return { segmentId, email: '', personId: null, self: true };
      }
      if (!item || typeof item !== 'object') throw new Error(`${label} entries must be a segment id or an object`);
      const segmentId = String(item.segment_id || item.segmentId || '').trim();
      const email = item.email == null ? '' : String(item.email).trim();
      const rawPerson = item.person_id ?? item.personId;
      const personId = rawPerson == null || rawPerson === '' ? null : Number(rawPerson);
      if (!segmentId) throw new Error(`${label} entries require segment_id`);
      if (rawPerson != null && rawPerson !== '' && !Number.isInteger(personId)) {
        throw new Error(`${label} person_id must be an integer`);
      }
      return { segmentId, email, personId: Number.isInteger(personId) ? personId : null, self: !email && personId == null };
    });
  }

  /**
   * Add or remove people in segments. One rule, `canEditSegmentMembership`,
   * decides every entry before anything is written. Yourself: governed by
   * join_min_level / leave_min_level. Someone else: manager_role_id or
   * admin scope. Adding by email creates the person (people:write or admin,
   * and pluginId).
   */
  async function postAuthSegments({ body, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body, session });
    const isAdmin = scopesAllow(ctx.scopes, SCOPES.ADMIN);
    if (body && (body.join !== undefined || body.leave !== undefined)) {
      return json(400, { error: 'join and leave are not accepted; use add and remove with a bare segment id for yourself' });
    }
    let adds;
    let removes;
    try {
      adds = membershipEdits(body?.add, 'add');
      removes = membershipEdits(body?.remove, 'remove');
    } catch (e) {
      return json(400, { error: String(e.message || e) });
    }
    const edits = [
      ...adds.map((item) => ({ ...item, operation: 'add' })),
      ...removes.map((item) => ({ ...item, operation: 'remove' }))
    ];
    if (!edits.length) return json(400, { error: 'body must include add or remove' });

    const selfEdits = edits.filter((item) => item.self);
    const otherEdits = edits.filter((item) => !item.self);
    if (selfEdits.length && !session?.personId) {
      return json(401, {
        error: 'an entry with no person_id or email means yourself, which requires a session or identity token',
        subject: 'self'
      });
    }
    if (otherEdits.length && !session?.personId && !isAdmin) {
      return json(401, { error: 'changing other people requires a session or admin scope', subject: 'other' });
    }
    const emailEdits = otherEdits.some((item) => item.email);
    if (emailEdits && !isAdmin && !scopesAllow(ctx.scopes, SCOPES.PEOPLE_WRITE)) {
      return json(403, { error: 'entries with email require people:write or admin scope', subject: 'other' });
    }
    if (adds.some((item) => item.email) && !pluginId) return json(500, { error: 'api is not configured with a pluginId' });

    // Self entries are the session person. Other entries carry the target
    // id, or -1 when only an email is known: still "someone else".
    for (const item of edits) {
      item.targetPersonId = item.self ? session.personId : (item.personId ?? -1);
    }
    const held = session?.personId ? await heldRoleIds(session.personId) : [];
    const caller = callerFrom({ ctx, session, roleIds: held });
    const policies = await loadMembershipPolicies(worker, edits.map((item) => item.segmentId), rolesRegistry);
    for (const item of edits) {
      const decision = canEditSegmentMembership({
        policy: policies[item.segmentId] || null,
        operation: item.operation,
        caller,
        targetPersonId: item.targetPersonId
      });
      if (!decision.allowed) {
        return json(403, {
          error: decision.reason,
          segment_id: item.segmentId,
          operation: item.operation,
          subject: decision.subject
        });
      }
    }

    try {
      for (const item of edits) {
        const args = {
          worker,
          segmentId: item.segmentId,
          emails: item.email ? [item.email] : [],
          personIds: item.email ? [] : [item.targetPersonId]
        };
        if (item.operation === 'add') await addPeopleToSegment({ ...args, pluginId });
        else await removePeopleFromSegment(args);
      }
    } catch (e) {
      debug('postAuthSegments error:', e);
      const msg = String(e.message || e);
      const status = /not an email/i.test(msg) ? 400 : 422;
      return json(status, { error: msg });
    }
    await logModification({
      action: 'segment.membership',
      apiKeyId: apiKey?.id,
      roleId: ctx.roleId,
      personIds: [...new Set(edits.map((item) => item.targetPersonId).filter((id) => id > 0))],
      meta: { add: adds.length, remove: removes.length, self: selfEdits.length }
    });
    const describe = (item) => ({
      segment_id: item.segmentId,
      person_id: item.email ? undefined : item.targetPersonId,
      ...(item.email ? { email: item.email } : {}),
      subject: item.self ? 'self' : 'other'
    });
    return json(200, {
      add: edits.filter((item) => item.operation === 'add').map(describe),
      remove: edits.filter((item) => item.operation === 'remove').map(describe)
    });
  }

  /* Core dispatch on a normalized request:
     { method, path, query, body, headers, apiBase? } -- path relative to the api root */
  async function handle(req) {
    const method = (req.method || 'GET').toUpperCase();
    const parts = (req.path || '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

    if (method === 'OPTIONS') {
      await resolveAllowedOrigins();
      return withCors(json(204, null), req.headers);
    }

    if (method === 'GET' && (parts[0] === 'ok' || parts.length === 0)) {
      try {
        await worker.ok();
        return withCors(json(200, { ok: true }), req.headers);
      } catch (e) {
        return withCors(json(503, { ok: false, error: String(e.message || e) }), req.headers);
      }
    }
    // Everything else requires a valid API key (layer 1)
    const verification = await keyStore.verify(req.original || req);
    if (!verification.valid) {
      return withCors(json(401, { error: `unauthorized: ${verification.reason}` }), req.headers);
    }
    const apiKey = verification.key;

    let session = null;
    if (delegateAuth) {
      const sessionToken =
        req.body?.session_token ||
        getHeader(req.headers, 'X-Engine9-Session') ||
        getHeader(req.headers, 'x-engine9-session');
      if (sessionToken) session = delegateAuth.verify(sessionToken);

      if (!session) {
        const bearer = extractBearer(req.headers);
        if (
          bearer &&
          !isApiKeyBearer(bearer) &&
          isDelegateIdentityJwt(bearer) &&
          typeof delegateAuth.verifyIdentityToken === 'function'
        ) {
          try {
            session = await sessionFromIdentityToken(bearer, req.headers);
          } catch (e) {
            return withCors(
              json(401, {
                error: e.userMessage || 'invalid identity token',
                reason: e.reason || 'invalid_identity_token'
              }),
              req.headers
            );
          }
        }
      }
    }

    let result;
    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'login') {
      result = await postAuthLogin({ body: req.body, apiKey, headers: req.headers });
    } else if (method === 'GET' && parts[0] === 'auth' && parts[1] === 'me') {
      result = await getAuthMe({ session });
    } else if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'logout') {
      result = await postAuthLogout();
    } else if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'segments') {
      result = await postAuthSegments({
        body: req.body,
        apiKey,
        query: req.query || {},
        session
      });
    } else if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'role') {
      result = await postAuthRole({
        body: req.body,
        apiKey,
        headers: req.headers,
        session,
        query: req.query || {}
      });
    } else if (method === 'POST' && parts[0] === 'people') {
      result = await postPeople({ body: req.body, apiKey, query: req.query || {}, session });
    } else if (method === 'POST' && parts[0] === 'upsert') {
      result = await postUpsert({
        table: parts[1],
        body: req.body,
        apiKey,
        query: req.query || {},
        session
      });
    } else if (method === 'GET' && parts[0] === 'read') {
      result = await getRead({ name: parts[1], query: req.query || {}, apiKey, session });
    } else {
      result = json(404, { error: `no route for ${method} /${parts.join('/')}` });
    }
    await resolveAllowedOrigins();
    return withCors(result, req.headers);
  }

  /* Cloudflare Workers adapter.  basePath is stripped from the URL. */
  /** @param {Request} request
      @param {{ basePath?: string, ctx?: { waitUntil?: (p: Promise<unknown>) => void } }} [options] */
  async function handleFetch(request, { basePath = '/api', ctx } = {}) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (basePath && path.indexOf(basePath) === 0) path = path.slice(basePath.length) || '/';
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
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
    const apiBase = `${url.origin}${basePath || ''}`.replace(/\/$/, '') || url.origin;
    const result = await handle({
      method: request.method,
      path,
      query,
      body,
      headers: request.headers,
      original: request,
      apiBase
    });
    // flush batch logs without blocking the response when a ctx is available
    if (ctx?.waitUntil) ctx.waitUntil(logger.flush());
    else await logger.flush();
    const headers = {
      'content-type': result.contentType || 'application/json',
      ...(result.headers || {})
    };
    if (result.status === 204) {
      return new Response(null, { status: 204, headers });
    }
    const payload =
      result.contentType && String(result.contentType).indexOf('text/html') === 0
        ? result.body
        : JSON.stringify(result.body);
    return new Response(payload, { status: result.status, headers });
  }

  /* Express adapter: app.use('/api', api.expressHandler()) */
  function expressHandler() {
    return async (req, res) => {
      try {
        const host = req.get?.('host') || req.headers?.host || 'localhost';
        const proto = req.protocol || 'http';
        const base = `${proto}://${host}${req.baseUrl || '/api'}`.replace(/\/$/, '');
        const result = await handle({
          method: req.method,
          path: req.path,
          query: req.query,
          body: req.body,
          headers: req.headers,
          original: req,
          apiBase: base
        });
        await logger.flush();
        for (const [name, value] of Object.entries(result.headers || {})) {
          res.setHeader(name, value);
        }
        if (result.status === 204) {
          res.status(204).end();
          return;
        }
        if (result.contentType && String(result.contentType).indexOf('text/html') === 0) {
          res.status(result.status).type('html').send(result.body);
          return;
        }
        res.status(result.status).json(result.body);
      } catch (e) {
        debug('api error:', e);
        res.status(500).json({ error: 'internal error' });
      }
    };
  }

  return { handle, handleFetch, expressHandler, resolveAllowedOrigins };
}

export { SCOPES };
export default { createApi, SCOPES };
