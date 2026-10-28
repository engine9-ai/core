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
    GET  /auth/start            -- no API key. Redirect to Delegate (sign in with Google, one
                                   link, no script). ?returnTo=/path on this site, optional
                                   login_hint=<email>, prompt=select. Needs delegateAuth.
    GET  /auth/callback         -- no API key. Delegate's return: checks this browser started
                                   the sign-in, sets the Core Session cookie (e9_session),
                                   clears the login cookie, redirects to returnTo. A failure
                                   redirects there with ?login_error=<reason>.
    POST /auth/login            -- exchange delegate_token (requires API key + delegateAuth)
    GET  /auth/me               -- current User from session or Identity Token
    POST /auth/logout           -- { loggedOut, revoked }; revokes the Core Session when
                                   delegate.sessionRevocations is set. Cookie clear is the host's job
    POST /auth/role             -- change the caller's role (requires delegateAuth)
                                   body: { role_id, person_id?, exclusive?, session_token? }
                                   Same membership rules as /auth/segments, then
                                   returns a re-signed session token.
    POST /auth/segments         -- add or remove people in segments
                                   body: { add?: [...], remove?: [...] }
                                   an entry is a segment id (yourself) or
                                   { segment_id, person_id | email } (someone else);
                                   segment_id may be a role name. With admin
                                   scope a missing standard role row (admin)
                                   is created first. See docs/segments.md.
    POST /admin/install-default-plugins
                                -- install the default schema plugins (admin scope)
                                   body: { path? }  Same as installDefaultPlugins.
    POST /admin/upgrade         -- run the upgrades plugins declare (admin scope)
                                   body: { dry_run?, refresh?, plugins?, failed?, sql?,
                                           …the upgrades' own options (drop_name_columns) }
                                   Same as PluginWorker.upgrade / e9core upgrade.
    GET  /admin/status          -- read-only: does the database match the deployed
                                   code? (admin scope) ?plugin=<path>[,<path>]
                                   Same as PluginWorker.status / e9core status --url.
    GET  /admin/segments        -- every segment and its membership policy (admin scope)
    GET  /admin/segments/:id/members
                                -- members of a segment (id or role name, e.g. admin)
                                   with their emails (admin scope)
    POST /admin/erase           -- erase people from every person_id table (admin scope)
                                   body: { person_ids, dry_run?, keep? }
                                   Same as PersonWorker.erasePeople.

  Auth layers (see package README):
    1. API key (required on all routes except /ok)
    2. Role (role_id = segment UUID; scopes from role registry ∩ key scopes)
    3. Delegate credential level (session.auth + session.level; requiredAuth on roles)

  Identity: X-Engine9-Session (HMAC Core Session) and/or Authorization Bearer JWT
  (Identity Token; not e9key_/e9publickey_). person_id is always read from SQL.

  Usage:
    const api = createApi({
      worker,           // client PersonWorker
      keyStore,         // SqlApiKeyStore | KVApiKeyStore
      logger,           // data log: JsonlFileLogger | BatchLogger | NullLogger
      audit,            // audit log (schema, plugins, roles); default ConsoleLogger
      environment,      // the site's env (Worker env / process.env), read by GET /admin/status
      delegateAuth,     // optional createDelegateAuth() — enables /auth/*
      config: {
        pluginId,
        defaultRemoteInputId: 'website',
        upsertTables: ['person_name', 'person_email', 'person_phone', 'person_address', 'person_segment'],
        roles: { '<segment-uuid>': { name: 'VIP', scopes: ['data:read'] } },
                          // or roles: 'standard' (auth/roleNames.js, ids from worker.accountId)
        superadmins: ['ops@example.com'],
                          // optional: verified emails (Level 3+) that act as this
                          // account's admin role. An array, or a function read on
                          // each request (@engine9/core/superadmins/node).
        reads: {
          content: { table: 'content', segmentId: null, columns: ['*'] }
        },
        signIn: {                  // optional: GET /auth/start and /auth/callback
          minLevel: 1,             // default 1
          fields: ['email'],       // default ['email']
          brand: { name: 'My Site', color: '#7a1fa2' },
          loginProviders: ['google'],
          sessionCookie: 'e9_session'
        }
      }
    });
*/
import debug$0 from 'debug';
import { ConsoleLogger, NullLogger } from '../logging/index.js';
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
import {
  addPeopleToSegment,
  removePeopleFromSegment,
  listSegmentMembers,
  roleIdByName,
  roleSegmentId,
  standardRoleFor,
  ensureStandardRoleSegment,
  STANDARD_ROLES
} from '../auth/roles.js';

export const DEFAULT_DELEGATE_URL = 'https://delegate.network';
import {
  DEFAULT_SESSION_COOKIE,
  clearSessionCookie,
  plausibleEmail,
  safeReturnPath,
  sessionCookie,
  sessionTokenFromCookie,
  withQueryParam
} from '../auth/signIn.js';
import { parseOriginList } from './setupPage.js';
import { extractApiKey, hashApiKey } from '../auth/index.js';

const API_KEY_PREFIXES = ['e9key_', 'e9publickey_'];

/*
  Layer 1 failures. `kind: 'api_key'` marks the site's own key, not the person
  signing in: signing in again never fixes one. `error` keeps its
  `unauthorized: <reason>` text for callers that match on it.
*/
const API_KEY_HINTS = {
  missing_key: 'The request sent no API key. Send the site key as Authorization: Bearer or X-API-Key.',
  unknown_key:
    "No row in this site's api_key table matches the key this request sent. If it is the site's own key (E9_PUBLIC_API_KEY or E9_ADMIN_API_KEY), the database the deployed site uses is missing that row. This is a site setup problem, not a sign-in problem.",
  inactive_key: 'This key was turned off, usually by a key rotation. Use the current key for this site.',
  expired_key: 'This key has expired. Use the current key for this site.'
};

function apiKeyRejection(reason) {
  return {
    error: `unauthorized: ${reason}`,
    reason,
    kind: 'api_key',
    ...(API_KEY_HINTS[reason] ? { hint: API_KEY_HINTS[reason] } : {})
  };
}

/* One Worker log line per rejected key (wrangler tail), never the key itself. */
function logApiKeyRejection(req, reason) {
  if (reason === 'missing_key') return;
  const key = extractApiKey(req.original || req);
  const origin = getHeader(req.headers, 'Origin') || getHeader(req.headers, 'origin') || '';
  console.warn(
    `engine9 api key rejected: ${reason} key_hash=${key ? hashApiKey(key).slice(0, 12) : '-'} path=/${String(req.path || '').replace(/^\/+/, '')}${origin ? ` origin=${origin}` : ''}`
  );
}

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
 *   audit?: object,
 *   environment?: Record<string, unknown>,
 *   delegateAuth?: object | null,
 *   delegate?: {
 *     sessionSecret?: string,
 *     delegateUrl?: string,
 *     domain?: string,
 *     sessionTtlSeconds?: number,
 *     sessionRevocations?: { get(key: string): Promise<unknown>, put(key: string, value: string, opts?: object): Promise<unknown> } | null,
 *     fetchImpl?: typeof fetch
 *   } | null,
 *   config?: Record<string, unknown>
 * }} opts
 *
 * Login (`/auth/*`) is on when `delegateAuth` is passed, or when
 * `delegate.sessionSecret` is set — then createApi builds the default
 * delegate provider itself using `config.pluginId` and `config.roles`.
 * Without either, `/auth/*` answers 501 and every other route still works.
 *
 * `config.allowedOrigins` (CORS) is a comma-separated string, an array, or a
 * function returning either, read on each request. Origins are configuration
 * (`E9_ALLOWED_ORIGINS`), never read from the database.
 */
export function createApi({
  worker,
  keyStore,
  logger = new NullLogger(),
  audit = null,
  environment = {},
  delegateAuth = null,
  delegate = null,
  config = {}
}) {
  if (!worker) throw new Error('createApi requires a worker (client PersonWorker)');
  if (!keyStore) throw new Error('createApi requires a keyStore (see @engine9/core/auth)');
  // Two logs, never mixed (logging/index.js): `logger` for people data,
  // `auditLog` for schema, plugin, and role changes. Installs inside the
  // worker write to the same audit log.
  const auditLog = audit || worker.audit || new ConsoleLogger();
  worker.audit = auditLog;
  const {
    pluginId,
    defaultRemoteInputId = 'website',
    defaultInputType = 'api',
    upsertTables = ['person_name', 'person_email', 'person_phone', 'person_address', 'person_segment'],
    reads = {},
    maxBatchSize = 500,
    maxReadLimit = 1000,
    roles: configRoles,
    roleSegments: configRoleSegments,
    superadmins: configSuperadmins = null,
    allowedOrigins: configAllowedOrigins = [],
    signIn: configSignIn = {}
  } = config;
  const signIn = configSignIn || {};
  const sessionCookieName = signIn.sessionCookie || DEFAULT_SESSION_COOKIE;

  if (!delegateAuth && delegate?.sessionSecret) {
    delegateAuth = createDelegateAuth({
      worker,
      delegateUrl: delegate.delegateUrl || DEFAULT_DELEGATE_URL,
      domain: delegate.domain || undefined,
      sessionSecret: delegate.sessionSecret,
      sessionTtlSeconds: delegate.sessionTtlSeconds,
      sessionRevocations: delegate.sessionRevocations || null,
      pluginId,
      roles: configRoles,
      roleSegments: configRoleSegments,
      superadmins: configSuperadmins,
      ...(delegate.fetchImpl ? { fetchImpl: delegate.fetchImpl } : {})
    });
  }

  const fixedOrigins =
    typeof configAllowedOrigins === 'function' ? null : parseOriginList(configAllowedOrigins);
  const allowedOrigins = () => fixedOrigins || parseOriginList(configAllowedOrigins());

  function corsHeaders(reqHeaders, { includeOrigin = true } = {}) {
    const requestOrigin = getHeader(reqHeaders, 'Origin') || getHeader(reqHeaders, 'origin');
    const headers = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, X-API-Key, X-Engine9-Session',
      'access-control-max-age': '86400'
    };
    if (!includeOrigin || !requestOrigin) return headers;
    const origins = allowedOrigins();
    if (origins.includes(requestOrigin) || origins.includes('*')) {
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
    const requested =
      body?.role_id ||
      body?.roleId ||
      query?.role_id ||
      query?.roleId ||
      null;
    const roleId = requested ? resolveRoleId(rolesRegistry, requested) || requested : null;
    return resolveAuthContext({
      apiKey,
      roleId,
      session,
      rolesRegistry
    });
  }

  function requireAnyScope(ctx, scopes) {
    if (ctx.roleDenied) {
      return json(403, {
        error:
          ctx.roleDenied === 'unknown_role'
            ? `role_id '${ctx.roleId}' is not a configured role`
            : `role_id '${ctx.roleId}' is not held by this session`,
        reason: ctx.roleDenied
      });
    }
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

  async function logAudit(entry) {
    const record = { accountId: worker.accountId, ...entry };
    try {
      await auditLog.log(record);
    } catch (e) {
      // The action already happened. Keep the record in the Worker log.
      console.error(JSON.stringify({ engine9_audit_write_failed: String(e?.message || e), ...record }));
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

  async function postAdminErase({ body, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body, session });
    const denied = requireScope(ctx, SCOPES.ADMIN);
    if (denied) return denied;
    const dryRun = Boolean(body?.dry_run);
    let result;
    try {
      result = await worker.erasePeople({
        personIds: body?.person_ids,
        keep: Array.isArray(body?.keep) ? body.keep : [],
        dryRun
      });
    } catch (e) {
      debug('postAdminErase error:', e);
      return json(422, { error: String(e.message || e) });
    }
    if (!dryRun) {
      await logModification({
        action: 'people.erase',
        apiKeyId: apiKey?.id,
        roleId: ctx.roleId,
        personIds: result.personIds,
        meta: { tables: result.tables }
      });
    }
    return json(200, { person_ids: result.personIds, dry_run: result.dryRun, tables: result.tables });
  }

  async function postAdminInstallDefaultPlugins({ body, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body, session });
    const denied = requireScope(ctx, SCOPES.ADMIN);
    if (denied) return denied;
    const path = body?.path ?? body?.stack;
    if (path != null && typeof path !== 'string') return json(400, { error: 'body.path must be a string' });
    let result;
    try {
      result = await worker.installDefaultPlugins(path ? { path } : {});
    } catch (e) {
      debug('postAdminInstallDefaultPlugins error:', e);
      return json(422, { error: String(e.message || e) });
    }
    await logAudit({
      action: 'plugins.install_default',
      apiKeyId: apiKey?.id,
      roleId: ctx.roleId,
      meta: { path: path || null }
    });
    return json(200, result ?? { ok: true });
  }

  async function postAdminUpgrade({ body, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body, session });
    const denied = requireScope(ctx, SCOPES.ADMIN);
    if (denied) return denied;
    let result;
    try {
      // The upgrade writes its own audit record; actor comes from the key, never the body.
      result = await worker.upgrade({ ...(body || {}), actor: { apiKeyId: apiKey?.id, roleId: ctx.roleId } });
    } catch (e) {
      debug('postAdminUpgrade error:', e);
      return json(422, { error: String(e.message || e) });
    }
    return json(200, result);
  }

  /*
    What only the running site can see: its secrets (by name, never by value;
    the keys are checked by hash) and whether the audit log has a sink.
  */
  function environmentChecks() {
    const env = environment || {};
    const has = (name) => typeof env[name] === 'string' && env[name] !== '';
    const checks = [];
    const secret = (name, why) =>
      checks.push(
        has(name)
          ? { id: `secrets.${name}`, area: 'secrets', status: 'pass', title: `${name} is set` }
          : { id: `secrets.${name}`, area: 'secrets', status: 'warn', title: `${name} is not set`, detail: why, fix: 'npx e9core setup-keys --remote' }
      );
    secret('SESSION_SECRET', 'Login (/auth/*) is off without it.');
    secret('E9_PUBLIC_API_KEY', 'The site cannot check that its public key is in the database.');
    secret('E9_ADMIN_API_KEY', 'The site cannot check that its admin key is in the database.');
    checks.push(
      auditLog.fallback
        ? {
            id: 'audit.configured',
            area: 'audit',
            status: 'warn',
            title: 'No audit log sink: schema, plugin, and role changes go only to the Worker log',
            fix: 'Bind an R2 bucket as AUDIT_BUCKET in wrangler.jsonc (Cloudflare), or pass audit to createApi (Node)'
          }
        : { id: 'audit.configured', area: 'audit', status: 'pass', title: 'The audit log has its own sink' }
    );
    const keys = {};
    if (has('E9_PUBLIC_API_KEY')) keys.public = { value: env.E9_PUBLIC_API_KEY, source: 'E9_PUBLIC_API_KEY secret' };
    if (has('E9_ADMIN_API_KEY')) keys.admin = { value: env.E9_ADMIN_API_KEY, source: 'E9_ADMIN_API_KEY secret' };
    return { checks, keys };
  }

  async function getAdminStatus({ apiKey, query, session, apiBase }) {
    const ctx = authContextFor({ apiKey, query, session });
    const denied = requireScope(ctx, SCOPES.ADMIN);
    if (denied) return denied;
    const { checks, keys } = environmentChecks();
    let origin = '<site>';
    try {
      if (apiBase) origin = new URL(apiBase).origin;
    } catch {
      origin = '<site>';
    }
    try {
      const report = await worker.status({
        plugins: query?.plugin,
        keys,
        checks,
        source: 'site',
        fixTarget: `--url ${origin}`
      });
      return json(200, report);
    } catch (e) {
      debug('getAdminStatus error:', e);
      return json(500, { error: String(e.message || e) });
    }
  }

  function roleNameOf(segmentId) {
    return rolesRegistry?.[segmentId]?.name || standardRoleFor(worker.accountId, segmentId)?.name || null;
  }

  /** Every segment with its membership policy, and standard roles with no row yet. */
  async function getAdminSegments({ apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body: null, session });
    const denied = requireScope(ctx, SCOPES.ADMIN);
    if (denied) return denied;
    const { data } = await worker.query(
      'select id, name, category, build_type, join_min_level, leave_min_level, manager_role_id from segment order by category, name'
    );
    const segments = data.map((row) => ({ ...row, role: roleNameOf(row.id) }));
    const present = new Set(segments.map((row) => row.id));
    const missingRoles = STANDARD_ROLES.filter((role) => !present.has(roleSegmentId(worker.accountId, role.name))).map(
      (role) => role.name
    );
    return json(200, { account_id: worker.accountId, segments, missing_roles: missingRoles });
  }

  /** Members of one segment (id or role name), each with their emails. */
  async function getAdminSegmentMembers({ segment, apiKey, query, session }) {
    const ctx = authContextFor({ apiKey, query, body: null, session });
    const denied = requireScope(ctx, SCOPES.ADMIN);
    if (denied) return denied;
    const segmentId = resolveSegmentId(decodeURIComponent(segment || ''));
    if (!segmentId) return json(400, { error: 'a segment id or role name is required' });
    const members = await listSegmentMembers({ worker, segmentId });
    return json(200, { account_id: worker.accountId, segment_id: segmentId, role: roleNameOf(segmentId), members });
  }

  async function getRead({ name, query, apiKey, session }) {
    const ctx = authContextFor({ apiKey, query, body: null, session });
    const denied = requireScope(ctx, SCOPES.DATA_READ);
    if (denied) return denied;
    const read = reads[name];
    if (!read) return json(404, { error: `no configured read named '${name}'` });
    const requestedPersonId = query.person_id ? parseInt(query.person_id, 10) : null;
    const sessionPersonId = Number.isInteger(session?.personId) ? session.personId : null;
    if (
      sessionPersonId != null &&
      requestedPersonId != null &&
      requestedPersonId !== sessionPersonId &&
      !scopesAllow(ctx.scopes, SCOPES.ADMIN)
    ) {
      return json(403, { error: 'person_id does not match session' });
    }
    // With a session the person is the session's; without one, a server-held
    // key names the person.
    const personId = sessionPersonId ?? requestedPersonId;
    if (read.segmentId) {
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
    // person_id changes (imports, merges, erase), so it is read from SQL on
    // every request and never cached outside the database.
    const personId = await resolveDelegatePersonId({
      worker,
      delegateUser,
      pluginId,
      remoteInputId: 'delegate',
      inputType: defaultInputType
    });
    const roles = await delegateAuth.rolesForPerson(personId);
    const session = {
      personId,
      roles,
      domainUnid: delegateUser.domainUnid,
      email: delegateUser.email,
      auth: delegateUser.auth || {},
      level: delegateUser.level,
      fields: delegateUser.fields
    };
    return typeof delegateAuth.withSuperadmin === 'function' ? delegateAuth.withSuperadmin(session) : session;
  }

  /* ---------------------------------------------------------------------
     Server-side sign-in: one link, no script.

       <a href="/api/auth/start?returnTo=/members">Log in</a>

     /auth/start sends the browser to Delegate (one provider opens itself).
     /auth/callback checks
     that this browser started the sign-in (signed e9_login cookie, state and
     nonce), logs the person in, sets the Core Session cookie, and redirects to
     returnTo. Neither route takes an API key: a browser following a link cannot
     send one. Everything that chooses what Delegate asks for is `config.signIn`,
     never the query string, except returnTo (a path on this site), login_hint,
     and prompt=select.
  --------------------------------------------------------------------- */

  const sessionMaxAge = signIn.sessionTtlSeconds || delegate?.sessionTtlSeconds || 86400;

  function redirect(location, cookies = []) {
    return json(302, null, {
      headers: { location, 'cache-control': 'no-store' },
      cookies
    });
  }

  function notConfigured() {
    return json(501, {
      error: 'login is not enabled: set SESSION_SECRET (e9core setup writes it) or pass delegateAuth to createApi'
    });
  }

  function getAuthStart({ query, apiBase }) {
    if (!delegateAuth) return notConfigured();
    if (!apiBase) return json(500, { error: 'cannot tell this site\'s address; pass apiBase to handle()' });
    const origin = new URL(apiBase).origin;
    const next = safeReturnPath(query.returnTo ?? query.return_to, { origin });
    const callback = `${apiBase}/auth/callback`;
    const { url, cookie } = delegateAuth.beginLogin({
      returnTo: callback,
      data: { next },
      secure: callback.startsWith('https:'),
      minLevel: signIn.minLevel ?? 1,
      maxLevel: signIn.maxLevel,
      fields: signIn.fields ?? ['email'],
      optionalFields: signIn.optionalFields,
      loginLevel: signIn.loginLevel,
      loginProviders: signIn.loginProviders,
      brand: signIn.brand,
      loginHint: plausibleEmail(query.login_hint),
      prompt: query.prompt === 'select' ? 'select' : undefined
    });
    return redirect(url, [cookie]);
  }

  async function getAuthCallback({ query, headers, apiBase }) {
    if (!delegateAuth) return notConfigured();
    if (!apiBase) return json(500, { error: 'cannot tell this site\'s address; pass apiBase to handle()' });
    const origin = new URL(apiBase).origin;
    const secure = apiBase.startsWith('https:');
    const cookie = getHeader(headers, 'Cookie') || getHeader(headers, 'cookie');
    const clearLogin = `e9_login=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
    const nextFor = () => {
      const pending = delegateAuth.readLoginRequest({ cookie, state: query.state });
      return safeReturnPath(pending?.data?.next, { origin });
    };

    // Delegate answered with an error (declined, no level, bad request).
    if (query.error) {
      const known = delegateAuth.readLoginRequest({ cookie, state: query.state });
      const next = known ? nextFor() : '/';
      return redirect(known ? withQueryParam(next, 'login_error', String(query.error).slice(0, 64)) : next, [
        clearLogin
      ]);
    }
    if (!query.delegate_token) return redirect('/', [clearLogin]);

    let result;
    try {
      result = await delegateAuth.finishLogin(query.delegate_token, {
        state: query.state,
        cookie,
        secure,
        returnTo: `${apiBase}/auth/callback`,
        fallbackDomain: requestDomain(headers)
      });
    } catch (e) {
      debug('getAuthCallback error:', e);
      // A return this browser did not start: sign in again is the answer, not an error.
      if (e.reason === 'state_mismatch') return redirect('/', [e.clearCookie || clearLogin]);
      return redirect(withQueryParam(nextFor(), 'login_error', String(e.reason || 'login_failed')), [
        e.clearCookie || clearLogin
      ]);
    }
    const next = safeReturnPath(result.data?.next, { origin });
    return redirect(next, [
      sessionCookie(result.token, { cookieName: sessionCookieName, maxAge: sessionMaxAge, secure }),
      result.clearCookie
    ]);
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
      auth: session.auth || {}
    };
    if (session.fields) me.fields = session.fields;
    return json(200, me);
  }

  async function postAuthLogout({ body, headers, apiBase }) {
    // With sessionRevocations configured, the session token also stops working.
    // The e9_session cookie (set by /auth/callback) is cleared here; a host that
    // delivered its own cookie clears it itself.
    const cookie = getHeader(headers, 'Cookie') || getHeader(headers, 'cookie');
    const cookieToken = sessionTokenFromCookie(cookie, sessionCookieName);
    const sessionToken =
      body?.session_token ||
      getHeader(headers, 'X-Engine9-Session') ||
      getHeader(headers, 'x-engine9-session') ||
      cookieToken;
    const revoked =
      sessionToken && typeof delegateAuth?.logout === 'function' ? await delegateAuth.logout(sessionToken) : false;
    const secure = Boolean(apiBase && apiBase.startsWith('https:'));
    return json(200, { loggedOut: true, revoked }, {
      cookies: cookieToken ? [clearSessionCookie({ cookieName: sessionCookieName, secure })] : []
    });
  }

  function readSessionToken(token) {
    return typeof delegateAuth.verifySession === 'function'
      ? delegateAuth.verifySession(token)
      : delegateAuth.verify(token);
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
        session = await readSessionToken(sessionToken);
        if (!session) return json(401, { error: 'invalid session' });
      }
    }

    // body.role_id is the role to grant, not the role the caller acts as.
    const ctx = authContextFor({ apiKey, query, body: null, session });
    if (ctx.roleDenied) return requireAnyScope(ctx, []);
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
   * A segment id, or a role name: a configured role's name, else a standard
   * role name (admin) resolved with this account's id.
   */
  function resolveSegmentId(value) {
    const id = String(value || '').trim();
    if (!id) return id;
    const configured = roleIdByName(rolesRegistry, id);
    if (configured) return configured;
    const standard = standardRoleFor(worker.accountId, id);
    return standard ? roleSegmentId(worker.accountId, standard.name) : id;
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
        const segmentId = resolveSegmentId(item);
        if (!segmentId) throw new Error(`${label} entries require segment_id`);
        return { segmentId, email: '', personId: null, self: true };
      }
      if (!item || typeof item !== 'object') throw new Error(`${label} entries must be a segment id or an object`);
      const segmentId = resolveSegmentId(item.segment_id || item.segmentId);
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
    if (ctx.roleDenied) return requireAnyScope(ctx, []);
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
    const segmentIds = edits.map((item) => item.segmentId);
    let policies = await loadMembershipPolicies(worker, segmentIds, rolesRegistry);
    if (isAdmin) {
      // The first admin on a new database: a standard role's row is created
      // with its standard policy, as `e9core segment add` does.
      const missing = adds.filter((item) => !policies[item.segmentId]);
      const creatable = missing.filter((item) => standardRoleFor(worker.accountId, item.segmentId));
      if (creatable.length && creatable.length === missing.length) {
        for (const name of new Set(creatable.map((item) => standardRoleFor(worker.accountId, item.segmentId).name))) {
          await ensureStandardRoleSegment({ worker, accountId: worker.accountId, name });
        }
        policies = await loadMembershipPolicies(worker, segmentIds, rolesRegistry);
      }
    }
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
    // Who holds a role is admin behavior (audit log); any other segment is people data.
    const isRole = (segmentId) => Boolean(rolesRegistry?.[segmentId] || standardRoleFor(worker.accountId, segmentId));
    const roleEdits = edits.filter((item) => isRole(item.segmentId));
    const dataEdits = edits.filter((item) => !isRole(item.segmentId));
    if (dataEdits.length) {
      await logModification({
        action: 'segment.membership',
        apiKeyId: apiKey?.id,
        roleId: ctx.roleId,
        personIds: [...new Set(dataEdits.map((item) => item.targetPersonId).filter((id) => id > 0))],
        meta: {
          add: dataEdits.filter((item) => item.operation === 'add').length,
          remove: dataEdits.filter((item) => item.operation === 'remove').length,
          self: dataEdits.filter((item) => item.self).length
        }
      });
    }
    for (const operation of ['add', 'remove']) {
      const changed = roleEdits.filter((item) => item.operation === operation);
      if (!changed.length) continue;
      await logAudit({
        action: operation === 'add' ? 'role.grant' : 'role.revoke',
        apiKeyId: apiKey?.id,
        roleId: ctx.roleId,
        meta: {
          by_person_id: session?.personId ?? null,
          changes: changed.map((item) => ({
            segment_id: item.segmentId,
            role: roleNameOf(item.segmentId),
            ...(item.email ? { email: item.email } : { person_id: item.targetPersonId }),
            self: Boolean(item.self)
          }))
        }
      });
    }
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
    // Browser navigations: a link cannot send an API key. These two routes
    // change nothing a caller could abuse without the signed login cookie.
    if (method === 'GET' && parts[0] === 'auth' && parts.length === 2 && (parts[1] === 'start' || parts[1] === 'callback')) {
      const route = parts[1] === 'start' ? getAuthStart : getAuthCallback;
      return route({ query: req.query || {}, headers: req.headers, apiBase: req.apiBase });
    }
    // Everything else requires a valid API key (layer 1)
    const verification = await keyStore.verify(req.original || req);
    if (!verification.valid) {
      logApiKeyRejection(req, verification.reason);
      return withCors(json(401, apiKeyRejection(verification.reason)), req.headers);
    }
    const apiKey = verification.key;

    let session = null;
    if (delegateAuth) {
      const sessionToken =
        req.body?.session_token ||
        getHeader(req.headers, 'X-Engine9-Session') ||
        getHeader(req.headers, 'x-engine9-session') ||
        sessionTokenFromCookie(getHeader(req.headers, 'Cookie') || getHeader(req.headers, 'cookie'), sessionCookieName);
      if (sessionToken) session = await readSessionToken(sessionToken);

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
      result = await postAuthLogout({ body: req.body, headers: req.headers, apiBase: req.apiBase });
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
    } else if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'erase') {
      result = await postAdminErase({ body: req.body, apiKey, query: req.query || {}, session });
    } else if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'install-default-plugins') {
      result = await postAdminInstallDefaultPlugins({ body: req.body, apiKey, query: req.query || {}, session });
    } else if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'upgrade') {
      result = await postAdminUpgrade({ body: req.body, apiKey, query: req.query || {}, session });
    } else if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'status' && parts.length === 2) {
      result = await getAdminStatus({ apiKey, query: req.query || {}, session, apiBase: req.apiBase });
    } else if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'segments' && parts.length === 2) {
      result = await getAdminSegments({ apiKey, query: req.query || {}, session });
    } else if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'segments' &&
      parts[3] === 'members' &&
      parts.length === 4
    ) {
      result = await getAdminSegmentMembers({ segment: parts[2], apiKey, query: req.query || {}, session });
    } else if (method === 'GET' && parts[0] === 'read') {
      result = await getRead({ name: parts[1], query: req.query || {}, apiKey, session });
    } else {
      result = json(404, { error: `no route for ${method} /${parts.join('/')}` });
    }
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
    const flushed = Promise.all([logger.flush(), auditLog.flush()]);
    if (ctx?.waitUntil) ctx.waitUntil(flushed);
    else await flushed;
    const headers = new Headers({
      'content-type': result.contentType || 'application/json',
      ...(result.headers || {})
    });
    // One Set-Cookie header per cookie (a plain object holds only one).
    for (const cookie of result.cookies || []) headers.append('set-cookie', cookie);
    if (result.status === 204 || result.status === 302) {
      return new Response(null, { status: result.status, headers });
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
        await Promise.all([logger.flush(), auditLog.flush()]);
        for (const [name, value] of Object.entries(result.headers || {})) {
          res.setHeader(name, value);
        }
        for (const cookie of result.cookies || []) res.append('Set-Cookie', cookie);
        if (result.status === 204 || result.status === 302) {
          res.status(result.status).end();
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

  // `delegateAuth` is exposed so a site's own routes can gate pages (@engine9/core/auth/gate).
  return { handle, handleFetch, expressHandler, delegateAuth };
}

export { SCOPES };
export default { createApi, SCOPES };
