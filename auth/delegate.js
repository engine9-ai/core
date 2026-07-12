/*
  Delegate authentication for core deployments.

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

  Delegate knows nothing about person_id or segments; everything person-related
  happens here, on the core deployment.

  This is the *core handoff* mechanism. Engine9 API hosts use a different
  mechanism (session bridge) with the same DELEGATE_SHARED_SECRET — see the
  delegate service docs.
*/
import crypto from 'node:crypto';

/** Build the browser URL that starts a delegate login for this site. */
export function delegateAuthorizeUrl({ delegateUrl, returnTo }) {
  if (!delegateUrl) throw new Error('delegateAuthorizeUrl requires delegateUrl');
  if (!returnTo) throw new Error('delegateAuthorizeUrl requires returnTo (absolute callback URL)');
  const url = new URL('/handoff/authorize', delegateUrl);
  url.searchParams.set('return_to', returnTo);
  return url.toString();
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
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code })
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    const reason = body?.error || `status_${response.status}`;
    const error = new Error(`delegate handoff exchange failed: ${reason}`);
    error.status = response.status;
    error.reason = reason;
    throw error;
  }
  if (!body?.unid || !body?.firebaseUid) {
    throw new Error('delegate handoff exchange returned an incomplete payload');
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
  if (!personId) throw new Error('delegate person resolution did not produce a person_id');
  return personId;
}

/* ---------------------------------------------------------------------------
   Signed local sessions.

   Core has no server-side session storage; the session is a compact
   HMAC-SHA256-signed token in an HttpOnly cookie. The payload carries the
   person_id plus the credential level reported by delegate.
--------------------------------------------------------------------------- */

function base64urlEncode(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(encoded, secret) {
  return crypto.createHmac('sha256', String(secret)).update(encoded).digest('base64url');
}

/**
 * Create a signed session token. `payload` is any JSON-serializable object;
 * an `exp` (unix ms) is added from ttlSeconds.
 */
export function createSessionToken(payload, { secret, ttlSeconds = 86400 }) {
  if (!secret) throw new Error('createSessionToken requires a secret');
  const encoded = base64urlEncode(
    JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })
  );
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verify a session token; returns the payload or null when invalid/expired. */
export function verifySessionToken(token, { secret }) {
  if (!secret) throw new Error('verifySessionToken requires a secret');
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encoded));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  return payload;
}

/* ---------------------------------------------------------------------------
   Session shape helpers (pure -- no worker or secrets required).

   A delegate session payload is:
     { personId, roles: [...], unid, email?, auth: { signInProvider?,
       twoFactor?, signInSecondFactor?, authTime? }, exp }
--------------------------------------------------------------------------- */

/** True when the session holds any of the given roles. */
export function sessionHasRole(session, ...roles) {
  if (!session || !Array.isArray(session.roles)) return false;
  return roles.some((role) => session.roles.includes(role));
}

/** First role from roleOrder present on the session, or null. */
export function sessionPrimaryRole(session, roleOrder = []) {
  if (!session || !Array.isArray(session.roles)) return null;
  return roleOrder.find((role) => session.roles.includes(role)) ?? null;
}

/** Logged in, but no role has been assigned/granted yet. */
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
      roleSegments: { admin: '<segment uuid>', vip: '<segment uuid>' },
      sessionTtlSeconds: 86400
    });

    auth.loginUrl({ returnTo })    // browser URL that starts a delegate login
    await auth.login(code)         // exchange + person pipeline + roles + token
    auth.verify(token)             // session payload | null
    auth.issueToken(session)       // re-sign an updated session
    await auth.rolesForPerson(id)  // roles from person_segment membership
    await auth.grantRole(id, role) // add person_segment row, return new roles

  Roles are segments: roleSegments maps role names to segment ids in this
  deployment's segment/person_segment tables. Whether (and when) to grantRole
  is deployment policy -- core only provides the mechanism.
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
  roleSegments = {},
  fetchImpl = fetch
}) {
  if (!worker) throw new Error('createDelegateAuth requires a worker (PersonWorker)');
  if (!sessionSecret) throw new Error('createDelegateAuth requires a sessionSecret');
  const roleNames = Object.keys(roleSegments);

  async function rolesForPerson(personId) {
    if (roleNames.length === 0) return [];
    const segmentIds = roleNames.map((role) => roleSegments[role]);
    const { data } = await worker.query({
      sql: `select segment_id from person_segment where person_id=? and segment_id in (${segmentIds.map(() => '?').join(',')})`,
      values: [personId, ...segmentIds]
    });
    const found = new Set(data.map((row) => row.segment_id));
    return roleNames.filter((role) => found.has(roleSegments[role]));
  }

  async function grantRole(personId, role) {
    const segmentId = roleSegments[role];
    if (!segmentId) {
      throw new Error(`Unknown role '${role}' -- configured roles: ${roleNames.join(', ')}`);
    }
    await worker.upsertArray({
      table: 'person_segment',
      array: [{ person_id: personId, segment_id: segmentId }]
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

  function loginUrl({ returnTo }) {
    return delegateAuthorizeUrl({ delegateUrl, returnTo });
  }

  /*
    Full login: exchange the one-time code, resolve/dedupe the person via
    id_type "delegate", snapshot roles, and mint the signed session (which
    carries the credential level delegate reported).
  */
  async function login(code, { person = {} } = {}) {
    const delegateUser = await exchangeDelegateCode({
      delegateUrl,
      secret: handoffSecret,
      code,
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
    const roles = await rolesForPerson(personId);
    const session = {
      personId,
      roles,
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
    login,
    verify,
    issueToken,
    rolesForPerson,
    grantRole
  };
}

export default {
  delegateAuthorizeUrl,
  exchangeDelegateCode,
  resolveDelegatePersonId,
  createSessionToken,
  verifySessionToken,
  sessionHasRole,
  sessionPrimaryRole,
  sessionNeedsRole,
  createDelegateAuth
};
