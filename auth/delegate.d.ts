/**
 * Hand-written declarations for ./delegate.js so TypeScript consumers (e.g.
 * Astro sites on Cloudflare) get real types for the delegate auth API.
 */

/** Auth state reported by the delegate service for a login. */
export interface DelegateAuthState {
  loggedIn?: boolean;
  firebaseUid?: string;
  email?: string;
  signInProvider?: string;
  twoFactor?: boolean;
  signInSecondFactor?: string;
  idTokenExp?: number;
  authTime?: number;
}

/** Identity payload from an Identity Token or POST {delegateUrl}/handoff/exchange. */
export interface DelegateUser {
  unid: string;
  /** Optional — JWT path does not require it; person resolution uses unid. */
  firebaseUid?: string;
  email?: string;
  emailVerified?: boolean;
  auth: DelegateAuthState;
  returnTo?: string;
  createdAt?: string;
  level?: number;
  profileId?: string;
  profile?: Record<string, unknown>;
  /** Legacy handoff field; login() copies this onto profileId when needed. */
  profile_id?: string;
}

/** Credential level carried inside a local session (auth layer 3). */
export interface CredentialLevel {
  signInProvider?: string;
  twoFactor?: boolean;
  signInSecondFactor?: string;
  authTime?: number;
  level?: number;
}

/** Required Delegate credential constraints on a role (auth layer 2). */
export interface RequiredAuth {
  twoFactor?: boolean;
  /** Minimum Identity Level (0–7). Enforced as credentialLevel.level >= minLevel. */
  minLevel?: number;
}

/** Role registry entry. Keys of the registry are role_id === segment_id UUIDs. */
export interface RoleDefinition {
  /** Public display name */
  name: string;
  scopes?: string[];
  requiredAuth?: RequiredAuth;
}

/** Whether a delegate login failure is a site misconfiguration or a user retry. */
export type DelegateLoginErrorKind = "configuration" | "auth";

/** Thrown when delegate login cannot complete. */
export interface DelegateLoginFailure extends Error {
  reason: string;
  kind: DelegateLoginErrorKind;
  userMessage: string;
  status?: number;
  /** Present on cloudflare_challenge when returnTo was passed to login(). */
  browserExchangeUrl?: string;
}

export function createDelegateLoginFailure(
  reason?: string | null,
  options?: { detail?: string }
): DelegateLoginFailure;

/** Normalize any thrown value into a DelegateLoginFailure for UI redirects. */
export function normalizeDelegateLoginFailure(
  err: unknown,
  options?: { detail?: string }
): DelegateLoginFailure;

/**
 * Local session payload minted after a delegate login.
 * `roles` holds role_ids (segment UUIDs), not display names.
 */
export interface DelegateSession {
  personId: number;
  /** role_id values — each equals a segment_id UUID from the site role registry. */
  roles: string[];
  unid: string;
  email?: string;
  auth: CredentialLevel;
  exp?: number;
  /** Identity Level from the Identity Token (or handoff payload). */
  level?: number;
  /** Profile id (`sub` when it is not `unid:<unid>`). */
  profileId?: string;
  profile?: Record<string, unknown>;
}

export function delegateIdentityUrl(options: {
  delegateUrl: string;
  site: string;
  returnTo: string;
  prompt?: string;
  minLevel?: number;
  maxLevel?: number;
  fields?: string[] | string;
  nonce?: string;
  state?: string;
  responseMode?: string;
}): string;

export function delegateAuthorizeUrl(options: {
  delegateUrl: string;
  returnTo: string;
  /** When 'consent', Delegate requires an explicit button click even if already logged in. */
  prompt?: string;
}): string;

export function delegateBrowserExchangeUrl(options: {
  delegateUrl: string;
  code: string;
  returnTo: string;
}): string;

export function exchangeDelegateCode(options: {
  delegateUrl: string;
  secret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<DelegateUser>;

export function verifyHandoffBridgeToken(options: {
  secret: string;
  token: string;
  expectedReturnTo?: string;
}): DelegateUser;

export function resolveDelegatePersonId(options: {
  worker: unknown;
  delegateUser: {
    unid: string;
    email?: string;
    emailVerified?: boolean;
    level?: number;
  };
  pluginId?: string;
  remoteInputId?: string;
  inputType?: string;
  person?: Record<string, unknown>;
}): Promise<number>;

/** Site origin from an absolute URL, or null when unparseable. */
export function siteOriginFromUrl(value?: string | null): string | null;

/** True when token looks like a JWT (eyJ header + three segments). */
export function isDelegateIdentityJwt(token: string | null | undefined): boolean;

/** Classify a login token: `jwt` | `bridge` | `code` | `unknown`. */
export function classifyDelegateLoginToken(
  token: string | null | undefined
): "jwt" | "bridge" | "code" | "unknown";

/**
 * Verify a delegate Identity Token (JWT, ES256) via JWKS.
 * `aud` must equal `site` (Site origin). Issuer defaults to delegateUrl origin.
 */
export function verifyDelegateIdentityToken(options: {
  token: string;
  delegateUrl: string;
  /** Site origin — compared to JWT `aud`. */
  site: string;
  jwks?: { keys: Record<string, unknown>[] } | Record<string, unknown>[];
  issuer?: string;
  fetchImpl?: typeof fetch;
}): Promise<DelegateUser>;

/**
 * Set-Cookie header value for a host-delivered Core Session.
 * Cookie clear on logout is the host's job.
 */
export function createSessionCookieHeaders(
  token: string,
  options?: {
    cookieName?: string;
    maxAge?: number;
    secure?: boolean;
    sameSite?: string;
    path?: string;
  }
): string;

export function createSessionToken(
  payload: object,
  options: { secret: string; ttlSeconds?: number }
): string;

export function verifySessionToken(
  token: string | null | undefined,
  options: { secret: string }
): Record<string, unknown> | null;

/** True when the session holds any of the given role_ids (segment UUIDs). */
export function sessionHasRole(
  session: { roles?: readonly string[] } | null | undefined,
  ...roleIds: string[]
): boolean;

/** First role_id from the site's roleOrder present on the session, or null. */
export function sessionPrimaryRole(
  session: { roles?: readonly string[] } | null | undefined,
  roleOrder?: readonly string[]
): string | null;

/** Logged in, but the site has not assigned any roles on this session yet. */
export function sessionNeedsRole(
  session: { roles?: readonly unknown[] } | null | undefined
): boolean;

export function normalizeRoleRegistry(options?: {
  roles?: Record<string, RoleDefinition | string>;
  /** @deprecated Prefer `roles` keyed by segment UUID. */
  roleSegments?: Record<string, string>;
}): Record<string, RoleDefinition>;

export function resolveRoleId(
  registry: Record<string, RoleDefinition>,
  roleIdOrName: string
): string | null;

export interface DelegateAuth {
  /** Browser URL that starts a delegate login for this site. */
  loginUrl(options: { returnTo: string; prompt?: string }): string;
  /** Preferred Identity Token authorize URL (`/identity/authorize`). */
  identityUrl(options: {
    returnTo: string;
    prompt?: string;
    minLevel?: number;
    maxLevel?: number;
    fields?: string[] | string;
    nonce?: string;
    state?: string;
    responseMode?: string;
  }): string;
  /** Browser URL that finishes a blocked local code exchange via Delegate. */
  browserExchangeUrl(options: { code: string; returnTo: string }): string;
  /**
   * Complete login from an Identity Token JWT, ?delegate_code= (server
   * exchange), or ?delegate_bridge= (signed browser token). JWT path does not
   * require handoffSecret. Pass returnTo so CF-challenge errors include a
   * browserExchangeUrl, and so JWT aud can default to the returnTo origin.
   */
  login(
    codeOrBridgeOrJwt: string,
    options?: { person?: Record<string, unknown>; returnTo?: string; site?: string }
  ): Promise<{
    session: DelegateSession;
    token: string;
    delegateUser: DelegateUser;
  }>;
  /** Verify a Core Session token; null when invalid or expired. Returns level and profileId. */
  verify(token: string | null | undefined): DelegateSession | null;
  /** Verify a delegate Identity Token using this auth's delegateUrl / site / JWKS. */
  verifyIdentityToken(
    token: string,
    options?: {
      site?: string;
      jwks?: { keys: Record<string, unknown>[] };
      issuer?: string;
    }
  ): Promise<DelegateUser>;
  /** Re-sign an updated session payload. */
  issueToken(session: DelegateSession): string;
  /** role_ids from person_segment membership for configured roles. */
  rolesForPerson(personId: number): Promise<string[]>;
  /**
   * Upsert the person_segment row for a role_id (segment UUID); returns refreshed roles.
   * Pass exclusive: true to remove other configured role segments first.
   * Display names are accepted for compat and resolved via the registry.
   */
  grantRole(
    personId: number,
    roleId: string,
    options?: { exclusive?: boolean }
  ): Promise<string[]>;
  /**
   * Grant a role and re-sign a session token.
   * Preferred entry point for change-role HTTP handlers.
   */
  changeRole(options: {
    personId: number;
    roleId: string;
    exclusive?: boolean;
    session?: DelegateSession | null;
  }): Promise<{ roles: string[]; session: DelegateSession; token: string }>;
  /** Normalized UUID-keyed role registry. */
  roleRegistry: Record<string, RoleDefinition>;
}

export function createDelegateAuth(config: {
  worker: unknown;
  delegateUrl: string;
  /**
   * DELEGATE_SHARED_SECRET — Bearer for POST /handoff/exchange / bridge HMAC.
   * Optional when the Site only accepts Identity Tokens (JWT).
   */
  handoffSecret?: string;
  /** Site origin for JWT `aud` checks. Defaults to returnTo origin on login(). */
  site?: string;
  /** JWT iss; defaults to delegateUrl origin. */
  issuer?: string;
  /** Preloaded JWKS; skips fetch of /.well-known/jwks.json. */
  jwks?: { keys: Record<string, unknown>[] };
  sessionSecret: string;
  sessionTtlSeconds?: number;
  pluginId?: string;
  remoteInputId?: string;
  inputType?: string;
  /**
   * Preferred role registry. Keys are role_id === segment_id UUIDs.
   */
  roles?: Record<string, RoleDefinition>;
  /**
   * @deprecated Prefer `roles` keyed by segment UUID.
   * Legacy map of display name -> segment id; normalized into `roleRegistry`.
   */
  roleSegments?: Record<string, string>;
  /**
   * When false, login() always returns session.roles = [] so the site can
   * re-prompt role selection every login. Default true.
   */
  loadRolesOnLogin?: boolean;
  fetchImpl?: typeof fetch;
}): DelegateAuth;

declare const _default: {
  createDelegateLoginFailure: typeof createDelegateLoginFailure;
  normalizeDelegateLoginFailure: typeof normalizeDelegateLoginFailure;
  delegateAuthorizeUrl: typeof delegateAuthorizeUrl;
  delegateBrowserExchangeUrl: typeof delegateBrowserExchangeUrl;
  exchangeDelegateCode: typeof exchangeDelegateCode;
  verifyHandoffBridgeToken: typeof verifyHandoffBridgeToken;
  verifyDelegateIdentityToken: typeof verifyDelegateIdentityToken;
  isDelegateIdentityJwt: typeof isDelegateIdentityJwt;
  classifyDelegateLoginToken: typeof classifyDelegateLoginToken;
  siteOriginFromUrl: typeof siteOriginFromUrl;
  resolveDelegatePersonId: typeof resolveDelegatePersonId;
  createSessionToken: typeof createSessionToken;
  verifySessionToken: typeof verifySessionToken;
  createSessionCookieHeaders: typeof createSessionCookieHeaders;
  sessionHasRole: typeof sessionHasRole;
  sessionPrimaryRole: typeof sessionPrimaryRole;
  sessionNeedsRole: typeof sessionNeedsRole;
  normalizeRoleRegistry: typeof normalizeRoleRegistry;
  resolveRoleId: typeof resolveRoleId;
  createDelegateAuth: typeof createDelegateAuth;
};
export default _default;
