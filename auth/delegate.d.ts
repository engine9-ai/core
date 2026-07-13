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

/** Identity payload returned by POST {delegateUrl}/handoff/exchange. */
export interface DelegateUser {
  unid: string;
  firebaseUid: string;
  email?: string;
  auth: DelegateAuthState;
  returnTo?: string;
  createdAt?: string;
}

/** Credential level carried inside a local session. */
export interface CredentialLevel {
  signInProvider?: string;
  twoFactor?: boolean;
  signInSecondFactor?: string;
  authTime?: number;
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

/** Local session payload minted after a delegate login. */
export interface DelegateSession<Role extends string = string> {
  personId: number;
  /**
   * Site-defined role names only. Core and Delegate define no role vocabulary;
   * strings come from the implementing site's `roleSegments` / grantRole policy.
   */
  roles: Role[];
  unid: string;
  email?: string;
  auth: CredentialLevel;
  exp?: number;
}

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
  delegateUser: { unid: string; email?: string };
  pluginId?: string;
  remoteInputId?: string;
  inputType?: string;
  person?: Record<string, unknown>;
}): Promise<number>;

export function createSessionToken(
  payload: object,
  options: { secret: string; ttlSeconds?: number }
): string;

export function verifySessionToken(
  token: string | null | undefined,
  options: { secret: string }
): Record<string, unknown> | null;

/** True when the session holds any of the given site-defined roles. */
export function sessionHasRole(
  session: { roles?: readonly string[] } | null | undefined,
  ...roles: string[]
): boolean;

/** First role from the site's roleOrder present on the session, or null. */
export function sessionPrimaryRole<Role extends string>(
  session: { roles?: readonly string[] } | null | undefined,
  roleOrder?: readonly Role[]
): Role | null;

/** Logged in, but the site has not assigned any roles on this session yet. */
export function sessionNeedsRole(
  session: { roles?: readonly unknown[] } | null | undefined
): boolean;

export interface DelegateAuth<Role extends string = string> {
  /** Browser URL that starts a delegate login for this site. */
  loginUrl(options: { returnTo: string; prompt?: string }): string;
  /** Browser URL that finishes a blocked local code exchange via Delegate. */
  browserExchangeUrl(options: { code: string; returnTo: string }): string;
  /**
   * Complete login from ?delegate_code= (server exchange) or ?delegate_bridge=
   * (signed browser token). Pass returnTo so CF-challenge errors include a
   * browserExchangeUrl for the local-dev continue step.
   */
  login(
    codeOrBridge: string,
    options?: { person?: Record<string, unknown>; returnTo?: string }
  ): Promise<{
    session: DelegateSession<Role>;
    token: string;
    delegateUser: DelegateUser;
  }>;
  /** Verify a session token; null when invalid or expired. */
  verify(token: string | null | undefined): DelegateSession<Role> | null;
  /** Re-sign an updated session payload. */
  issueToken(session: DelegateSession<Role>): string;
  /** Roles from person_segment membership for the site-configured roleSegments. */
  rolesForPerson(personId: number): Promise<Role[]>;
  /**
   * Upsert the person_segment row for a site-defined role; returns refreshed roles.
   * Pass exclusive: true to remove other configured roleSegments first.
   * Role names must appear in this auth instance's roleSegments — core has none built in.
   */
  grantRole(
    personId: number,
    role: Role,
    options?: { exclusive?: boolean }
  ): Promise<Role[]>;
}

export function createDelegateAuth<Role extends string = string>(config: {
  worker: unknown;
  delegateUrl: string;
  /** DELEGATE_SHARED_SECRET — Bearer for POST /handoff/exchange / bridge HMAC. */
  handoffSecret: string;
  sessionSecret: string;
  sessionTtlSeconds?: number;
  pluginId?: string;
  remoteInputId?: string;
  inputType?: string;
  /**
   * Site-owned role map only. Core and Delegate define no roles (no vip/admin builtins).
   * Keys are opaque role names chosen by the implementing site; values are that
   * deployment's segment ids. Omit or pass {} when the site does not use roles.
   */
  roleSegments?: Record<Role, string>;
  /**
   * When false, login() always returns session.roles = [] so the site can
   * re-prompt role selection every login. Default true.
   */
  loadRolesOnLogin?: boolean;
  fetchImpl?: typeof fetch;
}): DelegateAuth<Role>;

declare const _default: {
  createDelegateLoginFailure: typeof createDelegateLoginFailure;
  delegateAuthorizeUrl: typeof delegateAuthorizeUrl;
  delegateBrowserExchangeUrl: typeof delegateBrowserExchangeUrl;
  exchangeDelegateCode: typeof exchangeDelegateCode;
  verifyHandoffBridgeToken: typeof verifyHandoffBridgeToken;
  resolveDelegatePersonId: typeof resolveDelegatePersonId;
  createSessionToken: typeof createSessionToken;
  verifySessionToken: typeof verifySessionToken;
  sessionHasRole: typeof sessionHasRole;
  sessionPrimaryRole: typeof sessionPrimaryRole;
  sessionNeedsRole: typeof sessionNeedsRole;
  createDelegateAuth: typeof createDelegateAuth;
};
export default _default;
