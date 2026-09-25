/*
  Delegate authentication for core deployments (auth layer 3 + role helpers).

  "Delegate" is the shared, cross-organization identity service. A core host
  never talks to the identity provider itself. Preferred path:

    1. Browser obtains a delegate-signed Identity Token (JWT, ES256) via
       /identity/authorize or /identity/bridge
    2. The host verifies the JWT with JWKS (`verifyDelegateIdentityToken`) — no
       shared secret. Claims: sub (Domain UNID), domain_profile, level, profile,
       auth, merged_from; aud is the Domain (host[:port])
    3. Maps the Domain UNID → person_id (`resolveDelegatePersonId`) and
       optionally mints a local HMAC Core Session (`createSessionToken`)

  Roles (auth layer 2): role_id === segment_id (UUID). The host supplies a
  UUID-keyed `roles` registry (display name, scopes, requiredAuth including
  minLevel). Session `roles` is an array of those segment UUIDs.

  Engine9 API hosts sign their own operator session with SESSION_SECRET.
  That is not this protocol.
*/
import { jwtVerify, createLocalJWKSet, errors as joseErrors } from 'jose';
import {
  base64urlEncode,
  base64urlDecode,
  signPayload,
  verifySignedPayload,
  splitSignedToken
} from './hmac.js';

/** In-memory JWKS (createLocalJWKSet) keyed by delegateUrl. */
const delegateJwksCache = new Map();

/*
  Classify delegate login failures for end-user messaging.

  configuration — site/deployment misconfiguration; retrying sign-in will not help
  auth          — normal sign-in flow failure; the user can try again
*/
const DELEGATE_LOGIN_ERRORS = {
  person_resolution_failed: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site could not create or look up your person record. Contact the site operator.'
  },
  missing_session_secret: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site is misconfigured: SESSION_SECRET is not set. Contact the site operator.'
  },
  login_failed: {
    kind: 'auth',
    message:
      'Sign-in did not finish on this site after Delegate sent you back. Please try signing in again.'
  },
  invalid_identity_token: {
    kind: 'auth',
    message: 'Your sign-in token is invalid or expired. Please sign in again.'
  },
  invalid_domain: {
    kind: 'auth',
    message: 'This identity token is not valid for this domain. Please sign in again.'
  }
};

/** Map unexpected Error messages to a known delegate login reason when possible. */
function inferLoginReasonFromMessage(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return null;
  if (text.includes('sessionsecret') || text.includes('session_secret')) {
    return 'missing_session_secret';
  }
  if (text.includes('person resolution') || text.includes('processpeople')) {
    return 'person_resolution_failed';
  }
  return null;
}

/**
 * Build login failure metadata for a delegate login reason code.
 * @returns {{ reason: string, kind: 'configuration' | 'auth', userMessage: string }}
 */
function loginErrorForReason(reason) {
  const key = String(reason || 'login_failed').trim();
  const known = DELEGATE_LOGIN_ERRORS[key];
  if (known) return { reason: key, kind: known.kind, userMessage: known.message };

  const statusMatch = /^status_(\d+)$/.exec(key);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status >= 500) {
      return {
        reason: key,
        kind: 'configuration',
        userMessage:
          'Sign-in cannot be completed because the delegate service is unavailable. If this keeps happening, contact the site operator.'
      };
    }
    if (status === 404) {
      return {
        reason: key,
        kind: 'auth',
        userMessage: 'Your sign-in link expired or was already used. Please sign in again.'
      };
    }
    if (status >= 400) {
      return {
        reason: key,
        kind: 'configuration',
        userMessage:
          'Sign-in cannot be completed because Delegate rejected the request. Contact the site operator.'
      };
    }
  }

  const unknownMessage = DELEGATE_LOGIN_ERRORS.login_failed.message;
  return {
    reason: key,
    kind: 'auth',
    userMessage: `${unknownMessage} (code: ${key})`
  };
}

/**
 * Normalize any thrown value into a DelegateLoginFailure for UI redirects.
 * Preserves structured failures; maps common Error text to known reasons.
 */
export function normalizeDelegateLoginFailure(err, { detail } = {}) {
  const candidate = err && typeof err === 'object' ? err : {};
  if (candidate.userMessage && candidate.reason && candidate.kind) {
    const failure = createDelegateLoginFailure(candidate.reason, {
      detail: detail || candidate.message
    });
    failure.userMessage = candidate.userMessage;
    if (candidate.status) failure.status = candidate.status;
    return failure;
  }

  const message = detail || candidate.message || String(err || '');
  const reason =
    candidate.reason ||
    inferLoginReasonFromMessage(message) ||
    (candidate.status ? `status_${candidate.status}` : 'login_failed');
  const failure = createDelegateLoginFailure(reason, { detail: message });
  if (candidate.status) failure.status = candidate.status;
  return failure;
}

/**
 * Create a delegate login failure error with user-facing text on `userMessage`.
 * Callback handlers can forward `reason`, `kind`, and `userMessage` to the UI.
 */
export function createDelegateLoginFailure(reason, { detail } = {}) {
  const described = loginErrorForReason(reason);
  const error = new Error(detail || `delegate login failed: ${described.reason}`);
  error.reason = described.reason;
  error.kind = described.kind;
  error.userMessage = described.userMessage;
  return error;
}

/** Browser URL that starts Identity Token authorize. */
export function delegateIdentityUrl({
  delegateUrl,
  domain,
  returnTo,
  prompt,
  minLevel,
  maxLevel,
  fields,
  nonce,
  state,
  responseMode = 'query'
}) {
  if (!delegateUrl) throw new Error('delegateIdentityUrl requires delegateUrl');
  if (!domain) throw new Error('delegateIdentityUrl requires domain (JWT aud / host[:port])');
  if (!returnTo) throw new Error('delegateIdentityUrl requires returnTo');
  const url = new URL('/identity/authorize', delegateUrl);
  url.searchParams.set('domain', domain);
  url.searchParams.set('return_to', returnTo);
  if (prompt) url.searchParams.set('prompt', prompt);
  if (minLevel !== undefined) url.searchParams.set('min_level', String(minLevel));
  if (maxLevel !== undefined) url.searchParams.set('max_level', String(maxLevel));
  if (fields) url.searchParams.set('fields', Array.isArray(fields) ? fields.join(',') : fields);
  if (nonce) url.searchParams.set('nonce', nonce);
  if (state) url.searchParams.set('state', state);
  if (responseMode) url.searchParams.set('response_mode', responseMode);
  return url.toString();
}

/**
 * Normalize site role config to a UUID-keyed registry.
 *
 * Preferred:
 *   roles: { '<segment-uuid>': { name, scopes?, requiredAuth? } }
 *
 * Legacy (deprecated):
 *   roleSegments: { admin: '<segment-uuid>', vip: '<segment-uuid>' }
 */
export function normalizeRoleRegistry({ roles, roleSegments } = {}) {
  const out = {};
  if (roles && typeof roles === 'object') {
    for (const [key, cfg] of Object.entries(roles)) {
      if (typeof cfg === 'string') {
        // Accidental legacy shape inside `roles`: name -> uuid
        out[cfg] = { name: key, scopes: [], requiredAuth: {} };
        continue;
      }
      const entry = cfg && typeof cfg === 'object' ? cfg : {};
      out[key] = {
        name: entry.name || key,
        scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
        requiredAuth: entry.requiredAuth && typeof entry.requiredAuth === 'object' ? entry.requiredAuth : {}
      };
    }
  }
  if (roleSegments && typeof roleSegments === 'object') {
    for (const [name, segmentId] of Object.entries(roleSegments)) {
      if (!segmentId) continue;
      if (!out[segmentId]) {
        out[segmentId] = { name, scopes: [], requiredAuth: {} };
      } else if (!out[segmentId].name || out[segmentId].name === segmentId) {
        out[segmentId] = { ...out[segmentId], name };
      }
    }
  }
  return out;
}

/** Resolve a role_id (UUID) or display name to a registry key. */
export function resolveRoleId(registry, roleIdOrName) {
  if (!roleIdOrName) return null;
  if (registry[roleIdOrName]) return roleIdOrName;
  const needle = String(roleIdOrName).toLowerCase();
  const match = Object.entries(registry).find(
    ([, cfg]) => String(cfg.name || '').toLowerCase() === needle
  );
  return match ? match[0] : null;
}

/** Full origin from an absolute URL, or null when unparseable. */
export function siteOriginFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Login domain for JWT `aud` and DOMAINS_KV keys: host, or host:port when the
 * URL port is non-empty (same as delegate rootPath).
 */
export function domainFromUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (!host) return null;
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return null;
  }
}

/** True when token looks like a JWT (eyJ header + three segments). */
export function isDelegateIdentityJwt(token) {
  return typeof token === 'string' && token.startsWith('eyJ') && token.split('.').length === 3;
}

/** Classify a login token. Identity Tokens are JWTs; anything else is unknown. */
export function classifyDelegateLoginToken(token) {
  if (isDelegateIdentityJwt(token)) return 'jwt';
  return 'unknown';
}

async function loadDelegateJwks(delegateUrl, { jwks, fetchImpl = fetch } = {}) {
  if (jwks) {
    const set = jwks.keys ? jwks : { keys: Array.isArray(jwks) ? jwks : [jwks] };
    return createLocalJWKSet(set);
  }
  const cacheKey = String(delegateUrl);
  const cached = delegateJwksCache.get(cacheKey);
  if (cached) return cached;
  const url = new URL('/.well-known/jwks.json', delegateUrl).toString();
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: `JWKS fetch failed: ${response.status}`
    });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'JWKS response is not valid JSON'
    });
  }
  if (!body?.keys) {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'JWKS response missing keys'
    });
  }
  const local = createLocalJWKSet(body);
  delegateJwksCache.set(cacheKey, local);
  return local;
}

function mapJoseVerifyError(err) {
  if (err instanceof joseErrors.JWTClaimValidationFailed && err.claim === 'aud') {
    return createDelegateLoginFailure('invalid_domain', { detail: err.message });
  }
  return createDelegateLoginFailure('invalid_identity_token', {
    detail: err?.message || 'identity token verification failed'
  });
}

/**
 * Verify a delegate Identity Token (JWT, ES256) via JWKS.
 * Fetches `{delegateUrl}/.well-known/jwks.json` unless `jwks` is passed.
 * Checks alg ES256, iss (default delegateUrl origin), aud === domain, exp (±60s).
 *
 * `sub` is the Domain UNID (`domain:hex`): the person on this Domain, and the
 * id an Engine9 API host stores. `domain_profile` names the acting Profile.
 * `merged_from` is an earlier Domain UNID for the same person.
 */
export async function verifyDelegateIdentityToken({
  token,
  delegateUrl,
  domain,
  jwks,
  issuer,
  fetchImpl = fetch
} = {}) {
  if (!token || typeof token !== 'string') {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'verifyDelegateIdentityToken requires a token'
    });
  }
  if (!delegateUrl) {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'verifyDelegateIdentityToken requires delegateUrl'
    });
  }
  if (!domain) {
    throw createDelegateLoginFailure('invalid_domain', {
      detail: 'verifyDelegateIdentityToken requires domain (JWT aud / host[:port])'
    });
  }

  const iss = issuer || siteOriginFromUrl(delegateUrl);
  if (!iss) {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'verifyDelegateIdentityToken could not determine issuer from delegateUrl'
    });
  }

  const verifyOpts = {
    algorithms: ['ES256'],
    issuer: iss,
    audience: domain,
    clockTolerance: 60
  };

  let keySet;
  try {
    keySet = await loadDelegateJwks(delegateUrl, { jwks, fetchImpl });
  } catch (err) {
    if (err?.reason) throw err;
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: err?.message || 'JWKS load failed'
    });
  }

  let payload;
  try {
    payload = (await jwtVerify(token, keySet, verifyOpts)).payload;
  } catch (err) {
    if (!jwks && err?.code === 'ERR_JWKS_NO_MATCHING_KEY') {
      delegateJwksCache.delete(String(delegateUrl));
      try {
        const retryKeys = await loadDelegateJwks(delegateUrl, { fetchImpl });
        payload = (await jwtVerify(token, retryKeys, verifyOpts)).payload;
      } catch (retryErr) {
        throw mapJoseVerifyError(retryErr);
      }
    } else {
      throw mapJoseVerifyError(err);
    }
  }

  const domainPrefix = `${domain}:`;
  const domainUnid = typeof payload?.sub === 'string' ? payload.sub : '';
  if (!domainUnid.startsWith(domainPrefix) || domainUnid.length === domainPrefix.length) {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'identity token sub is not a Domain UNID for this domain'
    });
  }
  const domainProfile =
    typeof payload.domain_profile === 'string' && payload.domain_profile.startsWith(domainPrefix)
      ? payload.domain_profile
      : undefined;
  const mergedFrom =
    typeof payload.merged_from === 'string' &&
    payload.merged_from.startsWith(domainPrefix) &&
    payload.merged_from !== domainUnid
      ? payload.merged_from
      : undefined;

  const rawAuth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : undefined;
  const emailVerified = profile?.email_verified === true;
  const email = emailVerified && profile?.email ? String(profile.email) : undefined;
  const level = typeof payload.level === 'number' ? payload.level : undefined;
  const amr = Array.isArray(rawAuth.amr) ? rawAuth.amr : [];
  const signInSecondFactor =
    rawAuth.sign_in_second_factor ||
    rawAuth.signInSecondFactor ||
    (amr.includes('mfa') || amr.includes('swk')
      ? amr.find((method) => method === 'mfa' || method === 'swk')
      : undefined);

  const delegateUser = {
    domainUnid,
    domainProfile,
    mergedFrom,
    email,
    emailVerified,
    auth: {
      signInProvider: rawAuth.provider || rawAuth.signInProvider,
      twoFactor: Boolean(rawAuth.two_factor ?? rawAuth.twoFactor),
      signInSecondFactor,
      authTime: rawAuth.auth_time ?? rawAuth.authTime
    },
    level,
    profile
  };
  return delegateUser;
}


/*
  Run a delegate identity through the normal inbound person pipeline so
  the Domain UNID is recognized/deduped via id_type "delegate"
  (person_id_delegate on SQLite/D1). When Delegate merged this browser's
  UNID at login, `mergedFrom` rides along so the earlier Domain UNID resolves
  to the same person. Email (when delegate provides one) rides along so a delegate
  login merges with a person already known by email. Returns the person_id.
*/
export async function resolveDelegatePersonId({
  worker,
  delegateUser,
  pluginId,
  remoteInputId = 'delegate',
  inputType = 'api',
  person = {}
}) {
  if (!worker) throw new Error('resolveDelegatePersonId requires a worker (PersonWorker)');
  if (!delegateUser?.domainUnid) throw new Error('resolveDelegatePersonId requires delegateUser.domainUnid');
  const record = { ...person, delegate_id: delegateUser.domainUnid };
  if (delegateUser.mergedFrom && delegateUser.mergedFrom !== delegateUser.domainUnid) {
    record.delegate_merged_from = delegateUser.mergedFrom;
  }
  // Only copy email onto the person record when Delegate has confirmed it
  // (emailVerified === true) or the Identity Token is at least Level 2
  // (Contact Confirmed). Unverified Level 0/1 emails must not merge people
  // via the email identifier.
  const canCopyEmail =
    delegateUser.emailVerified === true ||
    (typeof delegateUser.level === 'number' && delegateUser.level >= 2);
  if (canCopyEmail && delegateUser.email && !record.email) record.email = delegateUser.email;
  const summary = await worker.processPeople({
    pluginId,
    remoteInputId,
    inputType,
    batch: [record]
  });
  const personId = summary.personIds?.[0];
  if (!personId) {
    throw createDelegateLoginFailure('person_resolution_failed', {
      detail: 'delegate person resolution did not produce a person_id'
    });
  }
  return personId;
}

/* ---------------------------------------------------------------------------
   Signed local sessions.

   Core has no server-side session storage; the session is a compact
   HMAC-SHA256-signed token in an HttpOnly cookie. The payload carries the
   person_id plus the credential level reported by delegate.
--------------------------------------------------------------------------- */

/**
 * Create a signed session token. `payload` is any JSON-serializable object;
 * an `exp` (unix ms) is added from ttlSeconds.
 */
export function createSessionToken(payload, { secret, ttlSeconds = 86400 }) {
  if (!secret) throw new Error('createSessionToken requires a secret');
  const encoded = base64urlEncode(
    JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })
  );
  return `${encoded}.${signPayload(encoded, secret)}`;
}

/** Verify a session token; returns the payload or null when invalid/expired. */
export function verifySessionToken(token, { secret }) {
  if (!secret) throw new Error('verifySessionToken requires a secret');
  const parts = splitSignedToken(token);
  if (!parts) return null;
  if (!verifySignedPayload(parts.encoded, parts.signature, [secret])) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts.encoded));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  return payload;
}

/**
 * Set-Cookie header value for a host-delivered Core Session.
 * Cookie clear on logout is the host's job (this helper only mints).
 */
export function createSessionCookieHeaders(
  token,
  { cookieName = 'session', maxAge = 86400, secure, sameSite = 'lax', path = '/' } = {}
) {
  const parts = [
    `${cookieName}=${token}`,
    `Max-Age=${maxAge}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
    'HttpOnly'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ---------------------------------------------------------------------------
   Session shape helpers (pure -- no worker or secrets required).

   A delegate session payload is:
     { personId, roles: [role_id...], domainUnid, domainProfile?, email?, level?,
       auth: { signInProvider?, twoFactor?, signInSecondFactor?, authTime? }, exp }

   `roles` is an array of role_id values (segment UUIDs). Helpers below only
   inspect whatever role ids the site put on the session.
--------------------------------------------------------------------------- */

/** True when the session holds any of the given role_ids (segment UUIDs). */
export function sessionHasRole(session, ...roleIds) {
  if (!session || !Array.isArray(session.roles)) return false;
  return roleIds.some((roleId) => session.roles.includes(roleId));
}

/** First role_id from the site's roleOrder present on the session, or null. */
export function sessionPrimaryRole(session, roleOrder = []) {
  if (!session || !Array.isArray(session.roles)) return null;
  return roleOrder.find((roleId) => session.roles.includes(roleId)) ?? null;
}

/** Logged in, but the site has not assigned any roles on this session yet. */
export function sessionNeedsRole(session) {
  return Boolean(session && Array.isArray(session.roles) && session.roles.length === 0);
}

/*
  Everything a core deployment needs for delegate authentication, bundled:

    const auth = createDelegateAuth({
      worker,                      // PersonWorker bound to the deployment DB
      delegateUrl,                 // e.g. https://delegate.engine9.ai
      domain,                    // JWT aud host[:port] (optional; else domainFromUrl(returnTo))
      sessionSecret,               // HMAC key for the local session cookie
      pluginId,                    // plugin used for person pipeline writes
      remoteInputId: 'delegate',   // input the delegate logins record under
      // Preferred — role_id === segment UUID:
      roles: {
        '<segment-uuid>': { name: 'Admin', scopes: ['admin'], requiredAuth: { minLevel: 2 } }
      },
      // Legacy (deprecated): roleSegments: { admin: '<segment uuid>' },
      sessionTtlSeconds: 86400
    });

    auth.identityUrl({ returnTo, prompt?, minLevel? })
    await auth.login(token)                 // Identity Token JWT
    await auth.verifyIdentityToken(jwt)
    auth.verify(sessionToken)
    auth.issueToken(session)
    await auth.rolesForPerson(id)           // role_ids from person_segment
    await auth.grantRole(id, roleId, opts?)
    await auth.changeRole({ personId, roleId, exclusive?, session? })
    auth.roleRegistry                       // normalized UUID-keyed map

  loadRolesOnLogin (default true): when false, login() always returns
  session.roles = [] so the site can re-prompt role selection every login.
*/
export function createDelegateAuth({
  worker,
  delegateUrl,
  sessionSecret,
  sessionTtlSeconds = 86400,
  pluginId,
  remoteInputId = 'delegate',
  inputType = 'api',
  roles,
  roleSegments = {},
  loadRolesOnLogin = true,
  fetchImpl = fetch,
  domain,
  issuer,
  jwks
}) {
  if (!worker) throw new Error('createDelegateAuth requires a worker (PersonWorker)');
  if (!sessionSecret) throw new Error('createDelegateAuth requires a sessionSecret');
  const roleRegistry = normalizeRoleRegistry({ roles, roleSegments });
  const roleIds = Object.keys(roleRegistry);

  async function rolesForPerson(personId) {
    if (roleIds.length === 0) return [];
    const { data } = await worker.query({
      sql: `select segment_id from person_segment where person_id=? and segment_id in (${roleIds.map(() => '?').join(',')})`,
      values: [personId, ...roleIds]
    });
    const found = new Set(data.map((row) => row.segment_id));
    return roleIds.filter((id) => found.has(id));
  }

  async function grantRole(personId, roleIdOrName, { exclusive = false } = {}) {
    const roleId = resolveRoleId(roleRegistry, roleIdOrName);
    if (!roleId) {
      throw new Error(
        `Unknown role '${roleIdOrName}' -- configured role_ids: ${roleIds.join(', ') || '(none)'}`
      );
    }
    if (exclusive) {
      const otherIds = roleIds.filter((id) => id !== roleId);
      if (otherIds.length > 0) {
        await worker.query({
          sql: `delete from person_segment where person_id=? and segment_id in (${otherIds.map(() => '?').join(',')})`,
          values: [personId, ...otherIds]
        });
      }
    }
    await worker.upsertArray({
      table: 'person_segment',
      array: [{ person_id: personId, segment_id: roleId }]
    });
    return rolesForPerson(personId);
  }

  function issueToken(session) {
    return createSessionToken(session, { secret: sessionSecret, ttlSeconds: sessionTtlSeconds });
  }

  function verify(token) {
    const payload = verifySessionToken(token, { secret: sessionSecret });
    if (!payload || !Number.isInteger(payload.personId)) return null;
    return {
      personId: payload.personId,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      domainUnid: payload.domainUnid,
      domainProfile: payload.domainProfile,
      email: payload.email,
      auth: payload.auth || {},
      exp: payload.exp,
      level: payload.level
    };
  }

  /*
    `opts.domain` overrides; else the constructor `domain`; else
    `opts.fallbackDomain` (the request's Origin/Host, supplied by createApi so
    a same-platform site needs no domain configuration).
  */
  async function verifyIdentityToken(token, opts = {}) {
    return verifyDelegateIdentityToken({
      token,
      delegateUrl,
      domain: opts.domain || domain || opts.fallbackDomain,
      jwks: opts.jwks || jwks,
      issuer: opts.issuer || issuer,
      fetchImpl
    });
  }

  /**
   * Change the person's role (person_segment + optional re-signed session).
   * roleId must be a configured segment UUID (or legacy display name).
   */
  async function changeRole({ personId, roleId, exclusive = true, session = null } = {}) {
    if (!personId) throw new Error('changeRole requires personId');
    if (!roleId) throw new Error('changeRole requires roleId');
    const nextRoles = await grantRole(personId, roleId, { exclusive });
    const nextSession = session
      ? { ...session, personId, roles: nextRoles }
      : { personId, roles: nextRoles, auth: {} };
    return {
      roles: nextRoles,
      session: nextSession,
      token: issueToken(nextSession)
    };
  }

  function identityUrl({ returnTo, prompt, minLevel, maxLevel, fields, nonce, state, responseMode } = {}) {
    return delegateIdentityUrl({
      delegateUrl,
      domain: domain || domainFromUrl(returnTo),
      returnTo,
      prompt,
      minLevel,
      maxLevel,
      fields,
      nonce,
      state,
      responseMode
    });
  }

  /*
    Login from an Identity Token JWT. aud is `domain` (login option, else the
    constructor), else domainFromUrl(returnTo), else `fallbackDomain` (the
    request's own Origin/Host — what `@engine9/id` used as the Domain when the
    page and the API share one origin).
  */
  async function login(
    token,
    { person = {}, returnTo, domain: domainOverride, fallbackDomain } = {}
  ) {
    if (classifyDelegateLoginToken(token) !== 'jwt') {
      throw createDelegateLoginFailure('invalid_identity_token', {
        detail: 'login requires an Identity Token'
      });
    }
    const jwtDomain = domainOverride || domain || domainFromUrl(returnTo) || fallbackDomain;
    const delegateUser = await verifyDelegateIdentityToken({
      token,
      delegateUrl,
      domain: jwtDomain,
      jwks,
      issuer,
      fetchImpl
    });

    const personId = await resolveDelegatePersonId({
      worker,
      delegateUser,
      pluginId,
      remoteInputId,
      inputType,
      person
    });
    const sessionRoles = loadRolesOnLogin ? await rolesForPerson(personId) : [];
    const session = {
      personId,
      roles: sessionRoles,
      domainUnid: delegateUser.domainUnid,
      domainProfile: delegateUser.domainProfile,
      email: delegateUser.email,
      auth: {
        signInProvider: delegateUser.auth?.signInProvider,
        twoFactor: delegateUser.auth?.twoFactor,
        signInSecondFactor: delegateUser.auth?.signInSecondFactor,
        authTime: delegateUser.auth?.authTime
      },
      level: delegateUser.level
    };
    return { session, token: issueToken(session), delegateUser };
  }

  return {
    identityUrl,
    login,
    verify,
    verifyIdentityToken,
    issueToken,
    rolesForPerson,
    grantRole,
    changeRole,
    roleRegistry
  };
}

export default {
  createDelegateLoginFailure,
  normalizeDelegateLoginFailure,
  delegateIdentityUrl,
  verifyDelegateIdentityToken,
  isDelegateIdentityJwt,
  classifyDelegateLoginToken,
  siteOriginFromUrl,
  domainFromUrl,
  resolveDelegatePersonId,
  createSessionToken,
  verifySessionToken,
  createSessionCookieHeaders,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole,
  normalizeRoleRegistry,
  resolveRoleId,
  createDelegateAuth
};
