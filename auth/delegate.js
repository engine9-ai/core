/*
  Delegate authentication for core deployments (auth layer 3 + role helpers).

  "Delegate" is the shared, cross-organization authentication service. A core
  deployment never talks to the identity provider itself; it:

    1. sends the browser to delegate's /handoff/authorize with a return_to
       pointing at its own callback (`delegateAuthorizeUrl`)
    2. receives a one-time ?delegate_code= on that callback and exchanges it
       server-to-server using DELEGATE_SHARED_SECRET (`exchangeDelegateCode`)
    3. runs the returned identity through the normal person pipeline so the
       delegate unid becomes a person_id via id_type "delegate"
       (`resolveDelegatePersonId` -> person_id_delegate on SQLite/D1)
    4. mints its own signed local session containing the person_id and the
       credential level delegate reported (`createSessionToken` /
       `verifySessionToken`)

  Roles (auth layer 2): role_id === segment_id (UUID). The site supplies a
  UUID-keyed `roles` registry (display name, scopes, requiredAuth). Session
  `roles` is an array of those segment UUIDs. Legacy `roleSegments: { name: uuid }`
  is normalized to the UUID-keyed shape. Omit `roles` / `roleSegments` when unused.

  This is the *core handoff* mechanism. Engine9 API hosts use a different
  mechanism (session bridge) with the same DELEGATE_SHARED_SECRET — see the
  Engine9 auth map in the package README.
*/
import {
  parseSharedSecrets,
  base64urlEncode,
  base64urlDecode,
  signPayload,
  verifySignedPayload,
  splitSignedToken
} from './hmac.js';

/*
  Classify delegate login failures for end-user messaging.

  configuration — site/deployment misconfiguration; retrying sign-in will not help
  auth          — normal sign-in flow failure; the user can try again
*/
const DELEGATE_LOGIN_ERRORS = {
  invalid_shared_secret: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site is misconfigured: DELEGATE_SHARED_SECRET does not match the delegate service. Contact the site operator.'
  },
  invalid_return_to: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site callback URL is not allowed by the delegate service. Contact the site operator.'
  },
  invalid_json_body: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site sent an invalid request to the delegate service. Contact the site operator.'
  },
  missing_code: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site did not send a handoff code to the delegate service. Contact the site operator.'
  },
  incomplete_delegate_payload: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because the delegate service returned an unexpected response. Contact the site operator.'
  },
  person_resolution_failed: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site could not create or look up your person record. Contact the site operator.'
  },
  missing_handoff_secret: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site is misconfigured: DELEGATE_SHARED_SECRET is not set. Contact the site operator.'
  },
  missing_session_secret: {
    kind: 'configuration',
    message:
      'Sign-in cannot be completed because this site is misconfigured: SESSION_SECRET is not set. Contact the site operator.'
  },
  invalid_or_expired_code: {
    kind: 'auth',
    message: 'Your sign-in link expired or was already used. Please sign in again.'
  },
  cloudflare_challenge: {
    kind: 'configuration',
    message:
      'Local development needs an extra browser step: Cloudflare blocks server-to-server handoff from your machine. Open the continue link to finish sign-in in your browser.'
  },
  missing_delegate_code: {
    kind: 'auth',
    message: 'Sign-in did not finish because no authorization code was received. Please sign in again.'
  },
  login_failed: {
    kind: 'auth',
    message:
      'Sign-in did not finish on this site after Delegate sent you back. Please try signing in again.'
  }
};

/** Map unexpected Error messages to a known delegate login reason when possible. */
function inferLoginReasonFromMessage(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return null;
  if (text.includes('delegate_shared_secret')) return 'missing_handoff_secret';
  if (text.includes('sessionsecret') || text.includes('session_secret')) {
    return 'missing_session_secret';
  }
  if (text.includes('person resolution') || text.includes('processpeople')) {
    return 'person_resolution_failed';
  }
  return null;
}

/**
 * Build login failure metadata for a delegate handoff reason code.
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
          'Sign-in cannot be completed because this site could not exchange the authorization code with the delegate service. Contact the site operator.'
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
    if (candidate.browserExchangeUrl) failure.browserExchangeUrl = candidate.browserExchangeUrl;
    if (candidate.status) failure.status = candidate.status;
    return failure;
  }

  const message = detail || candidate.message || String(err || '');
  const reason =
    candidate.reason ||
    inferLoginReasonFromMessage(message) ||
    (candidate.status ? `status_${candidate.status}` : 'login_failed');
  const failure = createDelegateLoginFailure(reason, { detail: message });
  if (candidate.browserExchangeUrl) failure.browserExchangeUrl = candidate.browserExchangeUrl;
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

/** Build the browser URL that starts a delegate login for this site. */
export function delegateAuthorizeUrl({ delegateUrl, returnTo, prompt }) {
  if (!delegateUrl) throw new Error('delegateAuthorizeUrl requires delegateUrl');
  if (!returnTo) throw new Error('delegateAuthorizeUrl requires returnTo (absolute callback URL)');
  const url = new URL('/handoff/authorize', delegateUrl);
  url.searchParams.set('return_to', returnTo);
  // prompt=consent: Delegate shows its login/continue page and requires a
  // button click even when the user already has a Delegate session.
  if (prompt) url.searchParams.set('prompt', prompt);
  return url.toString();
}

/**
 * Browser URL that converts a one-time handoff code into a signed
 * ?delegate_bridge= redirect. Used when local POST /handoff/exchange is
 * blocked by Cloudflare Bot Fight.
 */
export function delegateBrowserExchangeUrl({ delegateUrl, code, returnTo }) {
  if (!delegateUrl) throw new Error('delegateBrowserExchangeUrl requires delegateUrl');
  if (!code) throw new Error('delegateBrowserExchangeUrl requires code');
  if (!returnTo) throw new Error('delegateBrowserExchangeUrl requires returnTo');
  const url = new URL('/handoff/browser-exchange', delegateUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('return_to', returnTo);
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

/**
 * Verify a browser-delivered handoff bridge token (HMAC with DELEGATE_SHARED_SECRET).
 * Accepts comma-separated secrets for rotation. Returns the same identity shape
 * as exchangeDelegateCode, or throws.
 */
export function verifyHandoffBridgeToken({ secret, token, expectedReturnTo }) {
  if (!secret) throw new Error('verifyHandoffBridgeToken requires DELEGATE_SHARED_SECRET');
  const parts = splitSignedToken(token);
  if (!parts) {
    throw createDelegateLoginFailure('invalid_or_expired_code', {
      detail: 'delegate bridge token missing or malformed'
    });
  }
  const secrets = parseSharedSecrets(typeof secret === 'string' ? secret : String(secret));
  const list = secrets.length ? secrets : [String(secret)];
  if (!verifySignedPayload(parts.encoded, parts.signature, list)) {
    throw createDelegateLoginFailure('invalid_or_expired_code', {
      detail: 'delegate bridge token signature mismatch'
    });
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts.encoded));
  } catch {
    throw createDelegateLoginFailure('incomplete_delegate_payload', {
      detail: 'delegate bridge token is not valid JSON'
    });
  }
  if (!payload?.unid || !payload?.firebaseUid) {
    throw createDelegateLoginFailure('incomplete_delegate_payload');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
    throw createDelegateLoginFailure('invalid_or_expired_code', {
      detail: 'delegate bridge token expired'
    });
  }
  if (expectedReturnTo) {
    try {
      if (new URL(payload.returnTo).origin !== new URL(expectedReturnTo).origin) {
        throw createDelegateLoginFailure('invalid_return_to', {
          detail: 'delegate bridge returnTo origin mismatch'
        });
      }
    } catch (err) {
      if (err.reason) throw err;
      throw createDelegateLoginFailure('invalid_return_to');
    }
  }
  return {
    unid: payload.unid,
    firebaseUid: payload.firebaseUid,
    email: payload.email,
    auth: payload.auth || {},
    returnTo: payload.returnTo,
    createdAt: payload.createdAt
  };
}

/*
  Exchange a one-time delegate_code for the delegate identity payload.
  Server-to-server: authenticated with the shared handoff secret, never the
  browser. Returns:
    { unid, firebaseUid, email?, auth: { loggedIn, signInProvider, twoFactor,
      signInSecondFactor?, idTokenExp?, authTime? }, returnTo, createdAt }
*/
export async function exchangeDelegateCode({ delegateUrl, secret, code, fetchImpl = fetch }) {
  if (!delegateUrl) throw new Error('exchangeDelegateCode requires delegateUrl');
  if (!secret) throw new Error('exchangeDelegateCode requires DELEGATE_SHARED_SECRET');
  if (!code) throw new Error('exchangeDelegateCode requires a code');
  const url = new URL('/handoff/exchange', delegateUrl);
  // Use the first secret when rotating (comma-separated).
  const secrets = parseSharedSecrets(secret);
  const bearer = secrets[0] || secret;
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code })
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error body (e.g. Cloudflare challenge HTML) */
  }
  if (!response.ok) {
    // 403 with no JSON error is almost always Cloudflare Bot Fight / managed
    // challenge blocking a non-browser POST (common for local → production).
    const reason =
      body?.error ||
      (response.status === 403 && !body
        ? 'cloudflare_challenge'
        : `status_${response.status}`);
    const error = createDelegateLoginFailure(reason, {
      detail: `delegate handoff exchange failed: ${reason}`
    });
    error.status = response.status;
    throw error;
  }
  if (!body?.unid || !body?.firebaseUid) {
    throw createDelegateLoginFailure('incomplete_delegate_payload', {
      detail: 'delegate handoff exchange returned an incomplete payload'
    });
  }
  return body;
}

/*
  Run a delegate identity through the normal inbound person pipeline so the
  unid is recognized/deduped via id_type "delegate" (person_id_delegate on
  SQLite/D1). Email (when delegate provides one) rides along so a delegate
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
  if (!delegateUser?.unid) throw new Error('resolveDelegatePersonId requires delegateUser.unid');
  const record = { delegate_id: delegateUser.unid, ...person };
  if (delegateUser.email && !record.email) record.email = delegateUser.email;
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

/* ---------------------------------------------------------------------------
   Session shape helpers (pure -- no worker or secrets required).

   A delegate session payload is:
     { personId, roles: [role_id...], unid, email?, auth: { signInProvider?,
       twoFactor?, signInSecondFactor?, authTime? }, exp }

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
      handoffSecret,               // DELEGATE_SHARED_SECRET (Bearer on /handoff/exchange)
      sessionSecret,               // HMAC key for the local session cookie
      pluginId,                    // plugin used for person pipeline writes
      remoteInputId: 'delegate',   // input the delegate logins record under
      // Preferred — role_id === segment UUID:
      roles: {
        '<segment-uuid>': { name: 'Admin', scopes: ['admin'], requiredAuth: {} }
      },
      // Legacy (deprecated): roleSegments: { admin: '<segment uuid>' },
      sessionTtlSeconds: 86400
    });

    auth.loginUrl({ returnTo, prompt? })
    await auth.login(code)
    auth.verify(token)
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
  handoffSecret,
  sessionSecret,
  sessionTtlSeconds = 86400,
  pluginId,
  remoteInputId = 'delegate',
  inputType = 'api',
  roles,
  roleSegments = {},
  loadRolesOnLogin = true,
  fetchImpl = fetch
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
      unid: payload.unid,
      email: payload.email,
      auth: payload.auth || {},
      exp: payload.exp
    };
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
      : { personId, roles: nextRoles, unid: session?.unid, email: session?.email, auth: session?.auth || {} };
    // Prefer full session fields when provided
    if (session) {
      nextSession.unid = session.unid;
      nextSession.email = session.email;
      nextSession.auth = session.auth || {};
    }
    return {
      roles: nextRoles,
      session: nextSession,
      token: issueToken(nextSession)
    };
  }

  function loginUrl({ returnTo, prompt } = {}) {
    return delegateAuthorizeUrl({ delegateUrl, returnTo, prompt });
  }

  function browserExchangeUrl({ code, returnTo }) {
    return delegateBrowserExchangeUrl({ delegateUrl, code, returnTo });
  }

  /*
    Full login from either:
      - a one-time ?delegate_code= (server POST /handoff/exchange), or
      - a signed ?delegate_bridge= token (browser delivery for localhost /
        Cloudflare Bot Fight bypass).

    Bridge tokens contain a "." and are not 64-char hex codes. On a
    cloudflare_challenge from exchange, the thrown error includes
    `browserExchangeUrl` when returnTo is provided.
  */
  async function login(token, { person = {}, returnTo } = {}) {
    let delegateUser;
    const isBridge =
      typeof token === 'string' && token.includes('.') && !/^[0-9a-f]{64}$/i.test(token);

    if (isBridge) {
      delegateUser = verifyHandoffBridgeToken({
        secret: handoffSecret,
        token,
        expectedReturnTo: returnTo
      });
    } else {
      try {
        delegateUser = await exchangeDelegateCode({
          delegateUrl,
          secret: handoffSecret,
          code: token,
          fetchImpl
        });
      } catch (err) {
        if (err?.reason === 'cloudflare_challenge' && returnTo && token) {
          err.browserExchangeUrl = delegateBrowserExchangeUrl({
            delegateUrl,
            code: token,
            returnTo
          });
        }
        throw err;
      }
    }

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
      unid: delegateUser.unid,
      email: delegateUser.email,
      auth: {
        signInProvider: delegateUser.auth?.signInProvider,
        twoFactor: delegateUser.auth?.twoFactor,
        signInSecondFactor: delegateUser.auth?.signInSecondFactor,
        authTime: delegateUser.auth?.authTime
      }
    };
    return { session, token: issueToken(session), delegateUser };
  }

  return {
    loginUrl,
    browserExchangeUrl,
    login,
    verify,
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
  delegateAuthorizeUrl,
  delegateBrowserExchangeUrl,
  exchangeDelegateCode,
  verifyHandoffBridgeToken,
  resolveDelegatePersonId,
  createSessionToken,
  verifySessionToken,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole,
  normalizeRoleRegistry,
  resolveRoleId,
  createDelegateAuth
};
