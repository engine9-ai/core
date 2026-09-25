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

/** Identity payload from an Identity Token. */
export interface DelegateUser {
  /** Domain UNID (`domain:hex`, JWT `sub`): this person on this Domain. Not the UNID. */
  domainUnid: string;
  /** Domain Profile (`domain:hex` or `domain:anonymous`): the acting Profile. */
  domainProfile?: string;
  /** Earlier Domain UNID for the same person, after Delegate merged a browser's UNID. */
  mergedFrom?: string;
  email?: string;
  emailVerified?: boolean;
  auth: DelegateAuthState;
  returnTo?: string;
  createdAt?: string;
  level?: number;
  profile?: Record<string, unknown>;
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
  /** Domain UNID from the Identity Token `sub`. */
  domainUnid: string;
  /** Domain Profile from the Identity Token. */
  domainProfile?: string;
  email?: string;
  auth: CredentialLevel;
  exp?: number;
  /** Identity Level from the Identity Token. */
  level?: number;
  profile?: Record<string, unknown>;
}

export function delegateIdentityUrl(options: {
  delegateUrl: string;
  /** JWT aud — host or host:port, not a full origin. */
  domain: string;
  returnTo: string;
  prompt?: string;
  minLevel?: number;
  maxLevel?: number;
  fields?: string[] | string;
  nonce?: string;
  state?: string;
  responseMode?: string;
}): string;

export function resolveDelegatePersonId(options: {
  worker: unknown;
  delegateUser: {
    domainUnid: string;
    mergedFrom?: string;
    email?: string;
    emailVerified?: boolean;
    level?: number;
  };
  pluginId?: string;
  remoteInputId?: string;
  inputType?: string;
  person?: Record<string, unknown>;
}): Promise<number>;

/** Full origin from an absolute URL, or null when unparseable. */
export function siteOriginFromUrl(value?: string | null): string | null;

/** Login domain (JWT aud): host or host:port when the URL port is non-empty. */
export function domainFromUrl(value?: string | null): string | null;

/** True when token looks like a JWT (eyJ header + three segments). */
export function isDelegateIdentityJwt(token: string | null | undefined): boolean;

/** Classify a login token: `jwt` or `unknown`. */
export function classifyDelegateLoginToken(
  token: string | null | undefined
): "jwt" | "unknown";

/**
 * Verify a delegate Identity Token (JWT, ES256) via JWKS.
 * `aud` must equal `domain` (host[:port]). Issuer defaults to delegateUrl origin.
 */
export function verifyDelegateIdentityToken(options: {
  token: string;
  delegateUrl: string;
  /** Compared to JWT `aud` — host or host:port, not a full origin. */
  domain: string;
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
  /** Identity Token authorize URL (`/identity/authorize`). */
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
  /**
   * Complete login from an Identity Token JWT. JWT aud is `options.domain`,
   * else the configured domain, else domainFromUrl(returnTo), else
   * `fallbackDomain` (createApi passes the request's Origin/Host).
   */
  login(
    identityToken: string,
    options?: {
      person?: Record<string, unknown>;
      returnTo?: string;
      domain?: string;
      fallbackDomain?: string;
    }
  ): Promise<{
    session: DelegateSession;
    token: string;
    delegateUser: DelegateUser;
  }>;
  /** Verify a Core Session token; null when invalid or expired. Returns level and domainProfile. */
  verify(token: string | null | undefined): DelegateSession | null;
  /** Verify a delegate Identity Token using this auth's delegateUrl / domain / JWKS. */
  verifyIdentityToken(
    token: string,
    options?: {
      domain?: string;
      /** Used only when neither `domain` nor the configured domain is set. */
      fallbackDomain?: string;
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
   * JWT aud (host[:port]). Optional: when unset, login() uses
   * domainFromUrl(returnTo), then the request's own Origin/Host via createApi.
   * Set it when the API is served on a different host than the pages.
   */
  domain?: string;
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
  delegateIdentityUrl: typeof delegateIdentityUrl;
  verifyDelegateIdentityToken: typeof verifyDelegateIdentityToken;
  isDelegateIdentityJwt: typeof isDelegateIdentityJwt;
  classifyDelegateLoginToken: typeof classifyDelegateLoginToken;
  siteOriginFromUrl: typeof siteOriginFromUrl;
  domainFromUrl: typeof domainFromUrl;
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
