/*
  Delegate authentication for core deployments (auth layer 3 + role helpers).

  "Delegate" is the shared, cross-organization identity service. A core host
  never talks to the identity provider itself. Preferred path:

    1. Browser obtains a delegate-signed Identity Token (JWT, ES256) via
       /identity/authorize or /identity/bridge
    2. The host verifies the JWT with JWKS (`verifyDelegateIdentityToken`) — no
       shared secret. Claims: sub (Domain UNID), level, fields,
       auth, merged_from; aud is the Domain (host[:port])
    3. Maps the Domain UNID → person_id (`resolveDelegatePersonId`) and
       optionally mints a local HMAC Core Session (`createSessionToken`)

  Roles (auth layer 2): role_id === segment_id (UUID). The host supplies a
  UUID-keyed `roles` registry (display name, scopes, requiredAuth including
  minLevel). Session `roles` is an array of those segment UUIDs.

  Engine9 API hosts sign their own operator session with SESSION_SECRET.
  That is not this protocol.
*/
import crypto from 'node:crypto';
import { jwtVerify, createLocalJWKSet, errors as joseErrors } from 'jose';
import {
  base64urlEncode,
  base64urlDecode,
  signPayload,
  verifySignedPayload,
  splitSignedToken
} from './hmac.js';
import {
  standardRoleRegistry,
  roleSegmentId,
  ensureRoleSegments,
  addPeopleToSegment,
  removePeopleFromSegment,
  listSegmentMembers
} from './roles.js';
import { ROLE_NAMES } from './roleNames.js';
import { isSuperadmin } from './superadmins.js';

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
  plugin_registry_missing: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site was deployed without its schema plugins. The Worker must alias @engine9/core/plugins/site to the file written by e9core build-plugins, then be deployed again. Retrying sign-in will not fix it.'
  },
  schema_update_failed: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site could not update its database while installing schema plugins. D1 cannot add a column whose default is CURRENT_TIMESTAMP; that table has to be rebuilt. Retrying sign-in will not fix it.'
  },
  database_error: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site\'s database returned an error while finishing sign-in. Retrying sign-in will not fix it. The detail is the database message for the site operator.'
  },
  invalid_identity_token: {
    kind: 'auth',
    message: 'Your sign-in token is invalid or expired. Please sign in again.'
  },
  invalid_domain: {
    kind: 'auth',
    message: 'This identity token is not valid for this domain. Please sign in again.'
  },
  // Not an expiry: the return belongs to a sign-in this browser did not start
  // (another browser, an old tab, a link someone sent). Start sign-in again.
  state_mismatch: {
    kind: 'auth',
    message: 'Please sign in again.'
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
  if (
    text.includes('no plugin registry') ||
    text.includes('plugin_config_invalid') ||
    text.includes('e9core build-plugins')
  ) {
    return 'plugin_registry_missing';
  }
  if (text.includes('non-constant default') || text.includes('has to be rebuilt')) {
    return 'schema_update_failed';
  }
  if (text.includes('d1_error') || text.includes('sqlite_error')) {
    return 'database_error';
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

/**
 * Identity Token lifetime core asks for. A host exchanges the token for its
 * own Core Session at once, and with response_mode=query the token rides in
 * the return URL (logs, history, Referer), so it should not outlive the hop.
 */
export const LOGIN_TOKEN_TTL_SECONDS = 300;

/** Browser URL that starts Identity Token authorize. */
export function delegateIdentityUrl({
  delegateUrl,
  domain,
  returnTo,
  prompt,
  minLevel,
  maxLevel,
  fields,
  optionalFields,
  loginLevel,
  loginProviders,
  brand,
  loginHint,
  nonce,
  state,
  responseMode = 'query',
  expiresIn = LOGIN_TOKEN_TTL_SECONDS
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
  if (optionalFields) {
    url.searchParams.set(
      'optional_fields',
      Array.isArray(optionalFields) ? optionalFields.join(',') : optionalFields
    );
  }
  // Delegate sign-in screen: 2 adds an email sign-in link; default is trusted providers.
  if (loginLevel !== undefined) url.searchParams.set('login_level', String(loginLevel));
  // Sign-in buttons Delegate offers, in order. Default is Google only; Delegate
  // drops any provider its operator has not enabled.
  const providers = Array.isArray(loginProviders) ? loginProviders.join(',') : loginProviders;
  if (typeof providers === 'string' && providers.trim()) {
    url.searchParams.set('login_providers', providers.trim());
  }
  // Sign-in page and email branding. Delegate stores none of it.
  if (brand?.name) url.searchParams.set('brand_name', brand.name);
  if (brand?.color) url.searchParams.set('brand_color', brand.color);
  if (brand?.logo) url.searchParams.set('brand_logo', brand.logo);
  if (brand?.wordmark) url.searchParams.set('brand_wordmark', brand.wordmark);
  if (brand?.background) url.searchParams.set('brand_background', brand.background);
  if (brand?.text) url.searchParams.set('brand_text', brand.text);
  if (brand?.card) url.searchParams.set('brand_card', brand.card);
  if (brand?.cardText) url.searchParams.set('brand_card_text', brand.cardText);
  if (brand?.font) url.searchParams.set('brand_font', brand.font);
  if (brand?.google) url.searchParams.set('brand_google', brand.google);
  // The visitor's email when the site knows it; Google can skip its account chooser.
  if (typeof loginHint === 'string' && loginHint.trim()) {
    url.searchParams.set('login_hint', loginHint.trim());
  }
  if (nonce) url.searchParams.set('nonce', nonce);
  if (state) url.searchParams.set('state', state);
  if (responseMode) url.searchParams.set('response_mode', responseMode);
  // null leaves the lifetime to Delegate (8 hours by default).
  if (expiresIn != null) url.searchParams.set('expires_in', String(expiresIn));
  return url.toString();
}

/**
 * Normalize site role config to a UUID-keyed registry.
 *
 * Preferred:
 *   roles: { '<segment-uuid>': { name, scopes?, requiredAuth? } }
 *
 * Standard names (auth/roleNames.js), ids derived from the account id:
 *   roles: 'standard'            (requires accountId)
 *
 * Legacy (deprecated):
 *   roleSegments: { admin: '<segment-uuid>', vip: '<segment-uuid>' }
 */
export function normalizeRoleRegistry({ roles, roleSegments, accountId } = {}) {
  const out = {};
  if (roles === 'standard') {
    if (!accountId) throw new Error("roles: 'standard' requires accountId");
    Object.assign(out, standardRoleRegistry(accountId));
  } else if (roles && typeof roles === 'object') {
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
 * Checks alg ES256, iss (default delegateUrl origin), aud === domain, exp (±60s),
 * and `nonce` when one is passed (the value this browser put in the
 * authorize URL; a mismatch is `state_mismatch`).
 *
 * `sub` is the Domain UNID (`domain:hex`): the person on this Domain, and the
 * id an Engine9 API host stores. `fields` holds the values the User shared.
 * `merged_from` is an earlier Domain UNID for the same person.
 */
export async function verifyDelegateIdentityToken({
  token,
  delegateUrl,
  domain,
  jwks,
  issuer,
  nonce,
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

  if (nonce !== undefined && payload?.nonce !== nonce) {
    throw createDelegateLoginFailure('state_mismatch', {
      detail: 'identity token nonce does not match the sign-in this browser started'
    });
  }

  const domainPrefix = `${domain}:`;
  const domainUnid = typeof payload?.sub === 'string' ? payload.sub : '';
  if (!domainUnid.startsWith(domainPrefix) || domainUnid.length === domainPrefix.length) {
    throw createDelegateLoginFailure('invalid_identity_token', {
      detail: 'identity token sub is not a Domain UNID for this domain'
    });
  }
  const mergedFrom =
    typeof payload.merged_from === 'string' &&
    payload.merged_from.startsWith(domainPrefix) &&
    payload.merged_from !== domainUnid
      ? payload.merged_from
      : undefined;

  const rawAuth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : undefined;
  const emailVerified = fields?.email_verified === true;
  const email = emailVerified && fields?.email ? String(fields.email) : undefined;
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
    fields
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

   Every token names its purpose (`typ`). A reader accepts only its own
   purpose, so a sign-in cookie, or anything else a host signs with the same
   secret, is never read as a session.
--------------------------------------------------------------------------- */

export const SESSION_TOKEN_TYPE = 'e9.session';
export const LOGIN_REQUEST_TOKEN_TYPE = 'e9.login';

function randomToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Create a signed token. `payload` is any JSON-serializable object; `typ`,
 * `iat` and `exp` (unix ms) are added, and a session also gets a random `sid`.
 */
export function createSessionToken(payload, { secret, ttlSeconds = 86400, typ = SESSION_TOKEN_TYPE }) {
  if (!secret) throw new Error('createSessionToken requires a secret');
  const now = Date.now();
  const body = { ...payload, typ, iat: now, exp: now + ttlSeconds * 1000 };
  if (typ === SESSION_TOKEN_TYPE && !body.sid) body.sid = randomToken();
  const encoded = base64urlEncode(JSON.stringify(body));
  return `${encoded}.${signPayload(encoded, secret)}`;
}

/**
 * Verify a signed token of one purpose; returns the payload or null when
 * invalid, expired, or of another purpose. `acceptUntyped` reads tokens
 * minted before `typ` existed (sessions only, for one session lifetime).
 */
export function verifySessionToken(token, { secret, typ = SESSION_TOKEN_TYPE, acceptUntyped = false }) {
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
  if (payload.typ !== typ && !(acceptUntyped && payload.typ === undefined)) return null;
  return payload;
}

/** One cookie's value from a Cookie request header, or null. */
export function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
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
     { personId, roles: [role_id...], domainUnid, email?, level?,
       auth: { signInProvider?, twoFactor?, signInSecondFactor?, authTime? },
       typ, sid, iat, exp }

   `roles` is an array of role_id values (segment UUIDs) copied from
   person_segment when the token was minted. Helpers below only inspect that
   copy: use them for what to show, and rolesForPerson() for a privileged
   decision (see auth/README.md, "Permissions").
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
      // Legacy (deprecated):       roleSegments: { admin: '<segment uuid>' },
      superadmins,                 // optional: emails (array, or a function read on each
                                   // request) that act as this account's admin role
      sessionTtlSeconds: 86400,
      sessionRevocations: null,    // KV-like { get, put } for logout()
      acceptLegacySessions: true   // sessions minted before `typ`; turn off a day after upgrading
    });

    auth.beginLogin({ returnTo, ... })      // { url, cookie, state, nonce }
    await auth.finishLogin(token, { state, cookie })  // checks state + nonce
    auth.identityUrl({ returnTo, prompt?, minLevel?, loginLevel?, loginProviders?, brand?, loginHint? })
    await auth.login(token, { nonce? })     // Identity Token JWT
    await auth.verifyIdentityToken(jwt)
    auth.verify(sessionToken)               // signature, purpose, expiry
    await auth.verifySession(sessionToken)  // + revocation
    await auth.logout(sessionToken)         // revoke until it would expire
    auth.issueToken(session)
    await auth.rolesForPerson(id)           // role_ids from person_segment, now
    await auth.rolesForSession(session)     // the same, plus admin for a superadmin
    await auth.grantRole(id, roleId, opts?)
    await auth.changeRole({ personId, roleId, exclusive?, session? })
    await auth.ensureSegments()             // create segment rows for the registry
    await auth.addPeople({ role, emails?, personIds? })     // membership by email
    await auth.removePeople({ role, emails?, personIds? })
    await auth.members({ role })            // [{ person_id, emails }]
    auth.roleRegistry                       // normalized UUID-keyed map

    roles: 'standard' uses the canonical names in auth/roleNames.js
    (admin) with ids derived from worker.accountId
    (see auth/roles.js). Other role names are site-specific.

  loadRolesOnLogin (default true): when false, login() always returns
  session.roles = [] so the site can re-prompt role selection every login.

  A session's roles are a copy made when the token was minted. Removing
  someone from a role does not change a token they already hold, so a
  privileged decision reads person_segment with rolesForPerson().
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
  superadmins = null,
  loadRolesOnLogin = true,
  sessionRevocations = null,
  acceptLegacySessions = true,
  fetchImpl = fetch,
  domain,
  issuer,
  jwks
}) {
  if (!worker) throw new Error('createDelegateAuth requires a worker (PersonWorker)');
  if (!sessionSecret) throw new Error('createDelegateAuth requires a sessionSecret');
  const accountId = worker.accountId;
  const roleRegistry = normalizeRoleRegistry({ roles, roleSegments, accountId });
  /* Superadmins act as this account's `admin` role. Make sure the registry
     knows that role even when the site listed its own roles. */
  const superadminRoleId = superadmins && accountId ? roleSegmentId(accountId, ROLE_NAMES.ADMIN) : null;
  if (superadminRoleId && !roleRegistry[superadminRoleId]) {
    roleRegistry[superadminRoleId] = {
      name: ROLE_NAMES.ADMIN,
      scopes: ['admin'],
      requiredAuth: { minLevel: 3 }
    };
  }
  const roleIds = Object.keys(roleRegistry);

  /* A superadmin (a verified email on the list, Identity Level 3 or more)
     holds the admin role first in `roles`. Re-evaluated on every verify,
     and never written to person_segment or into a token, so removing an
     email from the list ends it on the next request. */
  function withSuperadmin(session) {
    if (!session || !superadminRoleId) return session;
    if (!isSuperadmin(superadmins, session.email, session.level)) return session;
    const roles = Array.isArray(session.roles) ? session.roles : [];
    const held = roles.filter((id) => id !== superadminRoleId);
    // `superadmin` marks the role as granted by the list (not person_segment)
    // so issueToken leaves it out of the token.
    return {
      ...session,
      roles: [superadminRoleId, ...held],
      superadmin: !roles.includes(superadminRoleId) || session.superadmin === true
    };
  }

  function requireRoleId(roleIdOrName, fn) {
    const roleId = resolveRoleId(roleRegistry, roleIdOrName);
    if (!roleId) {
      throw new Error(
        `${fn}: unknown role '${roleIdOrName}' -- configured roles: ${
          roleIds.map((id) => `${roleRegistry[id].name} (${id})`).join(', ') || '(none)'
        }`
      );
    }
    return roleId;
  }

  /* Membership management. A "user" is a person in a role segment; these
     add or remove that membership by email (creating the person when new)
     or by person_id. Emails are the key: Delegate login with a verified
     email later merges into the same person. */
  async function addPeople({ role, emails, personIds } = {}) {
    const segmentId = requireRoleId(role, 'addPeople');
    return addPeopleToSegment({ worker, pluginId, segmentId, emails, personIds, remoteInputId });
  }

  async function removePeople({ role, emails, personIds } = {}) {
    const segmentId = requireRoleId(role, 'removePeople');
    return removePeopleFromSegment({ worker, segmentId, emails, personIds });
  }

  async function members({ role } = {}) {
    const segmentId = requireRoleId(role, 'members');
    return listSegmentMembers({ worker, segmentId });
  }

  /* Create the segment rows behind the registry (idempotent). Only the
     standard registry has account-derived ids; explicit registries name
     segments the site created itself. */
  async function ensureSegments() {
    if (roles !== 'standard') {
      throw new Error("ensureSegments applies to roles: 'standard'; explicit registries own their segment rows");
    }
    await ensureRoleSegments({ worker, accountId });
    return roleRegistry;
  }

  async function rolesForPerson(personId) {
    if (roleIds.length === 0) return [];
    const { data } = await worker.query({
      sql: `select segment_id from person_segment where person_id=? and segment_id in (${roleIds.map(() => '?').join(',')})`,
      values: [personId, ...roleIds]
    });
    const found = new Set(data.map((row) => row.segment_id));
    return roleIds.filter((id) => found.has(id));
  }

  /* Roles this session holds now: person_segment, plus the admin role when
     its verified email is a superadmin. Use this, not rolesForPerson, for a
     privileged decision on a session. */
  async function rolesForSession(session) {
    if (!session) return [];
    const held = Number.isInteger(session.personId) ? await rolesForPerson(session.personId) : [];
    return withSuperadmin({ ...session, roles: held }).roles;
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
    const { typ: _typ, sid: _sid, iat: _iat, exp: _exp, superadmin, ...rest } = session || {};
    if (superadmin && superadminRoleId && Array.isArray(rest.roles)) {
      rest.roles = rest.roles.filter((id) => id !== superadminRoleId);
    }
    return createSessionToken(rest, { secret: sessionSecret, ttlSeconds: sessionTtlSeconds });
  }

  function verify(token) {
    const payload = verifySessionToken(token, { secret: sessionSecret, acceptUntyped: acceptLegacySessions });
    if (!payload || !Number.isInteger(payload.personId)) return null;
    return withSuperadmin({
      personId: payload.personId,
      roles: Array.isArray(payload.roles) ? payload.roles.filter((id) => typeof id === 'string') : [],
      domainUnid: payload.domainUnid,
      email: payload.email,
      auth: payload.auth && typeof payload.auth === 'object' ? payload.auth : {},
      sid: payload.sid,
      iat: payload.iat,
      exp: payload.exp,
      level: payload.level
    });
  }

  const revokedKey = (sid) => `e9:revoked-session:${sid}`;

  /** verify(), then null when the session was logged out (sessionRevocations). */
  async function verifySession(token) {
    const session = verify(token);
    if (!session) return null;
    if (sessionRevocations && session.sid && (await sessionRevocations.get(revokedKey(session.sid)))) {
      return null;
    }
    return session;
  }

  /** Record the session as ended until it would have expired. No-op without sessionRevocations. */
  async function logout(token) {
    const session = verify(token);
    if (!session?.sid || !sessionRevocations) return false;
    const ttl = Math.max(60, Math.ceil((session.exp - Date.now()) / 1000));
    await sessionRevocations.put(revokedKey(session.sid), '1', { expirationTtl: ttl });
    return true;
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

  function identityUrl({
    returnTo,
    prompt,
    minLevel,
    maxLevel,
    fields,
    optionalFields,
    loginLevel,
    loginProviders,
    brand,
    loginHint,
    nonce,
    state,
    responseMode,
    expiresIn
  } = {}) {
    return delegateIdentityUrl({
      delegateUrl,
      domain: domain || domainFromUrl(returnTo),
      returnTo,
      prompt,
      minLevel,
      maxLevel,
      fields,
      optionalFields,
      loginLevel,
      loginProviders,
      brand,
      loginHint,
      nonce,
      state,
      responseMode,
      ...(expiresIn !== undefined ? { expiresIn } : {})
    });
  }

  const LOGIN_REQUEST_TTL_SECONDS = 600;

  function clearCookieHeader(cookieName, secure) {
    return `${cookieName}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
  }

  /*
    Start a sign-in bound to this browser. Send the browser to `url` with
    `cookie` as its Set-Cookie header. The cookie holds this request's state
    and nonce, signed and tagged so nothing else reads as one.
  */
  function beginLogin({ returnTo, cookieName = 'e9_login', secure, data, ...urlOptions } = {}) {
    const state = randomToken();
    const nonce = randomToken();
    // `data` (JSON) rides in the signed cookie and comes back from finishLogin, so a
    // callback can know where to send the browser without trusting its query string.
    const value = createSessionToken(
      { state, nonce, ...(data === undefined ? {} : { data }) },
      { secret: sessionSecret, ttlSeconds: LOGIN_REQUEST_TTL_SECONDS, typ: LOGIN_REQUEST_TOKEN_TYPE }
    );
    const isSecure = secure ?? String(returnTo || '').startsWith('https:');
    return {
      url: identityUrl({ ...urlOptions, returnTo, state, nonce }),
      state,
      nonce,
      cookie: createSessionCookieHeaders(value, {
        cookieName,
        maxAge: LOGIN_REQUEST_TTL_SECONDS,
        secure: isSecure
      })
    };
  }

  /*
    The sign-in this browser started, from its cookie and the return's `state`:
    `{ data }` (what beginLogin kept), or null when there is none or `state`
    is not the one this browser started. Reads only; it does not finish anything.
    Used for a return that carries `error=` instead of a token.
  */
  function readLoginRequest({ cookie, state, cookieName = 'e9_login' } = {}) {
    const raw = readCookie(cookie, cookieName);
    const pending = raw
      ? verifySessionToken(raw, { secret: sessionSecret, typ: LOGIN_REQUEST_TOKEN_TYPE })
      : null;
    if (!pending || !state || pending.state !== state) return null;
    return { data: pending.data };
  }

  /*
    Finish a sign-in from the return URL's `delegate_token` and `state`, and
    the request's Cookie header. A return this browser did not start (no
    cookie, other state, other nonce) throws `state_mismatch`: send the
    browser to sign in again, do not show an error. Always send
    `clearCookie` (also on the thrown error) so the request is used once.
  */
  async function finishLogin(token, { state, cookie, cookieName = 'e9_login', secure, ...loginOptions } = {}) {
    const raw = readCookie(cookie, cookieName);
    const pending = raw
      ? verifySessionToken(raw, { secret: sessionSecret, typ: LOGIN_REQUEST_TOKEN_TYPE })
      : null;
    const clearCookie = clearCookieHeader(cookieName, Boolean(secure));
    if (!pending || !state || pending.state !== state) {
      const failure = createDelegateLoginFailure('state_mismatch', {
        detail: pending ? 'state does not match this browser\'s sign-in' : 'no sign-in was started in this browser'
      });
      failure.clearCookie = clearCookie;
      throw failure;
    }
    try {
      const result = await login(token, { ...loginOptions, nonce: pending.nonce });
      return { ...result, clearCookie, data: pending.data };
    } catch (err) {
      if (err && typeof err === 'object') err.clearCookie = clearCookie;
      throw err;
    }
  }

  /*
    Login from an Identity Token JWT. aud is `domain` (login option, else the
    constructor), else domainFromUrl(returnTo), else `fallbackDomain` (the
    request's own Origin/Host — what `@engine9/id` used as the Domain when the
    page and the API share one origin).
  */
  async function login(
    token,
    { person = {}, returnTo, domain: domainOverride, fallbackDomain, nonce } = {}
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
      nonce,
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
      email: delegateUser.email,
      auth: {
        signInProvider: delegateUser.auth?.signInProvider,
        twoFactor: delegateUser.auth?.twoFactor,
        signInSecondFactor: delegateUser.auth?.signInSecondFactor,
        authTime: delegateUser.auth?.authTime
      },
      level: delegateUser.level
    };
    // The token carries person_segment roles only; the superadmin role is
    // added on the returned session and on every later verify().
    return { session: withSuperadmin(session), token: issueToken(session), delegateUser };
  }

  return {
    identityUrl,
    beginLogin,
    finishLogin,
    readLoginRequest,
    login,
    verify,
    verifySession,
    logout,
    verifyIdentityToken,
    issueToken,
    withSuperadmin,
    rolesForSession,
    rolesForPerson,
    grantRole,
    changeRole,
    addPeople,
    removePeople,
    members,
    ensureSegments,
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
  readCookie,
  createSessionCookieHeaders,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole,
  normalizeRoleRegistry,
  resolveRoleId,
  createDelegateAuth
};
