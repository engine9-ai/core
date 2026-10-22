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
  /** Earlier Domain UNID for the same person, after Delegate merged a browser's UNID. */
  mergedFrom?: string;
  email?: string;
  emailVerified?: boolean;
  auth: DelegateAuthState;
  returnTo?: string;
  createdAt?: string;
  level?: number;
  /** Values of the fields the User shared with this Domain. */
  fields?: Record<string, unknown>;
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
  email?: string;
  auth: CredentialLevel;
  /** Random session id; what logout() revokes. */
  sid?: string;
  iat?: number;
  exp?: number;
  /** Identity Level from the Identity Token. */
  level?: number;
}

/** A sign-in provider Delegate can offer (`login_providers`). */
export type DelegateLoginProvider = "google" | "facebook";

/**
 * Delegate sign-in branding (`brand_name`, `brand_color`, `brand_logo`,
 * `brand_wordmark`, `brand_background`, `brand_text`, `brand_card`,
 * `brand_card_text`, `brand_font`, `brand_google`). Sent on each request;
 * delegate stores none of it, shows the Domain next to the name, and ignores
 * invalid values. `logo` and `wordmark` must be https on the Domain or a
 * subdomain.
 */
export interface DelegateSignInBrand {
  /** Up to 60 characters. */
  name?: string;
  /** `#rgb` or `#rrggbb`. */
  color?: string;
  logo?: string;
  /** Wide logo, up to 240px wide on the sign-in page in place of `logo`. */
  wordmark?: string;
  /** `#rgb` or `#rrggbb` for the sign-in page (not the email). */
  background?: string;
  /** `#rgb` or `#rrggbb` text on `background`. Ignored below 4.5:1 contrast. */
  text?: string;
  /** `#rgb` or `#rrggbb` for the card, in place of a tint of `background`. */
  card?: string;
  /** `#rgb` or `#rrggbb` text on `card`. Ignored below 4.5:1 contrast. */
  cardText?: string;
  /** `system`, `sans`, `serif`, `rounded`, `mono`, or a Google Fonts family name. */
  font?: string;
  /**
   * `standard`: Google's white button. `brand`: brand color, "Continue with
   * Google". `skip`: straight to Google when Google is the only choice
   * (this authorize redirect); otherwise `brand`.
   */
  google?: 'standard' | 'brand' | 'skip';
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
  optionalFields?: string[] | string;
  /** Delegate sign-in screen. `2` adds an email sign-in link; default trusted providers. */
  loginLevel?: 2 | 3 | 4;
  /**
   * Sign-in buttons Delegate offers (`login_providers`), in order:
   * `['google', 'facebook']` or `'google,facebook'`. Default Google only.
   * Delegate drops any provider its operator has not enabled.
   */
  loginProviders?: DelegateLoginProvider[] | string;
  brand?: DelegateSignInBrand;
  nonce?: string;
  state?: string;
  responseMode?: string;
  /**
   * Identity Token lifetime in seconds (`expires_in`). Default
   * LOGIN_TOKEN_TTL_SECONDS (300); `null` leaves it to Delegate (8 hours).
   */
  expiresIn?: number | null;
}): string;

/** Identity Token lifetime core requests by default (seconds). */
export const LOGIN_TOKEN_TTL_SECONDS: number;
/** `typ` of a Core Session token. */
export const SESSION_TOKEN_TYPE: "e9.session";
/** `typ` of the beginLogin() cookie. */
export const LOGIN_REQUEST_TOKEN_TYPE: "e9.login";

/** One cookie's value from a Cookie request header, or null. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null;

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
  /** The nonce this browser sent; a different token nonce throws `state_mismatch`. */
  nonce?: string;
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

/** Signed token with `typ` (default SESSION_TOKEN_TYPE), `iat`, `exp`, and for sessions a `sid`. */
export function createSessionToken(
  payload: object,
  options: { secret: string; ttlSeconds?: number; typ?: string }
): string;

/** Payload of a valid, unexpired token of purpose `typ`, else null. */
export function verifySessionToken(
  token: string | null | undefined,
  options: { secret: string; typ?: string; acceptUntyped?: boolean }
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
  /** UUID-keyed map, or `'standard'` (requires accountId; see auth/roles). */
  roles?: Record<string, RoleDefinition | string> | "standard";
  /** @deprecated Prefer `roles` keyed by segment UUID. */
  roleSegments?: Record<string, string>;
  accountId?: string;
}): Record<string, RoleDefinition>;

/** Membership operations take a role name from the registry or a segment id. */
export interface RoleMembershipOptions {
  role: string;
  emails?: string[];
  personIds?: Array<number | string>;
}

export interface RoleMember {
  person_id: number;
  emails: string[];
}

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
    optionalFields?: string[] | string;
    /**
     * Delegate sign-in screen (`login_level`). Default (omit, `3`, or `4`):
     * trusted providers only. `2`: those or an email sign-in link, which
     * reaches Level 2 at most. Ignored by delegate when `minLevel` is 3 or more.
     */
    loginLevel?: 2 | 3 | 4;
    /**
     * Sign-in buttons Delegate offers (`login_providers`), in order.
     * Default Google only. Delegate drops any provider its operator has not
     * enabled.
     */
    loginProviders?: DelegateLoginProvider[] | string;
    /** Name, colors, logo, font, and Google button on delegate's sign-in page (name, color, and logo in the email too). */
    brand?: DelegateSignInBrand;
    nonce?: string;
    state?: string;
    responseMode?: string;
    /** Default 300 seconds; `null` leaves it to Delegate. */
    expiresIn?: number | null;
  }): string;
  /**
   * Start a sign-in bound to this browser: redirect to `url` and send
   * `cookie` as Set-Cookie. Takes the identityUrl options.
   */
  beginLogin(options: Parameters<DelegateAuth["identityUrl"]>[0] & {
    cookieName?: string;
    /** Default: returnTo is https. */
    secure?: boolean;
  }): { url: string; state: string; nonce: string; cookie: string };
  /**
   * Finish a beginLogin() sign-in from the return's `delegate_token` and
   * `state` and the request's Cookie header. Throws `state_mismatch` for a
   * return this browser did not start (sign in again; not an error). Send
   * `clearCookie` as Set-Cookie either way (it is also on the thrown error).
   */
  finishLogin(
    identityToken: string,
    options: {
      state: string | null | undefined;
      cookie: string | null | undefined;
      cookieName?: string;
      secure?: boolean;
      person?: Record<string, unknown>;
      returnTo?: string;
      domain?: string;
      fallbackDomain?: string;
    }
  ): Promise<{
    session: DelegateSession;
    token: string;
    delegateUser: DelegateUser;
    clearCookie: string;
  }>;
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
      /** The nonce this browser sent; a different token nonce throws `state_mismatch`. */
      nonce?: string;
    }
  ): Promise<{
    session: DelegateSession;
    token: string;
    delegateUser: DelegateUser;
  }>;
  /** Verify a Core Session token (signature, purpose, expiry); null when invalid. Does not see revocations. */
  verify(token: string | null | undefined): DelegateSession | null;
  /** verify(), plus the sessionRevocations check. */
  verifySession(token: string | null | undefined): Promise<DelegateSession | null>;
  /** Revoke the session until it would expire. False without sessionRevocations. */
  logout(token: string | null | undefined): Promise<boolean>;
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
  /** Add the admin role to a session whose verified email is a superadmin. */
  withSuperadmin<T extends DelegateSession>(session: T): T;
  /** role_ids a session holds now: person_segment plus `admin` for a superadmin. Use for privileged decisions on a session. */
  rolesForSession(session: DelegateSession): Promise<string[]>;
  /** role_ids the person holds now (person_segment, configured roles). Use for privileged decisions. */
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
  /** Create the segment rows behind the standard registry (idempotent). `roles: 'standard'` only. */
  ensureSegments(): Promise<Record<string, RoleDefinition>>;
  /**
   * Add people to a role by email (new emails become people first) or person_id.
   * A "user" is a person in a role segment; this is how one is created.
   */
  addPeople(options: RoleMembershipOptions): Promise<{
    segmentId: string;
    personIds: number[];
    byEmail: Record<string, number>;
    added: number[];
  }>;
  /** Remove people from a role. Unknown emails are ignored; never creates people. */
  removePeople(options: RoleMembershipOptions): Promise<{
    segmentId: string;
    personIds: number[];
    removed: number[];
  }>;
  /** Members of a role with their emails. */
  members(options: { role: string }): Promise<RoleMember[]>;
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
   * `'standard'` derives the registry from worker.accountId with the names in
   * auth/roleNames.js (admin). Other role names are site-specific
   * and belong in an explicit registry, not in `'standard'`.
   */
  roles?: Record<string, RoleDefinition> | "standard";
  /**
   * Superadmins: verified emails (Identity Level 3 or more) that act as this
   * account's `admin` role without a person_segment row. An array, or a
   * function returning one, read on every request (see
   * `@engine9/core/superadmins/node`).
   */
  superadmins?: string[] | (() => string[]);
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
  /** KV-like store (Cloudflare KV works) that logout() writes revoked session ids to. */
  sessionRevocations?: {
    get(key: string): Promise<unknown>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  } | null;
  /** Accept sessions minted before `typ` existed. Default true; turn off one session lifetime after upgrading. */
  acceptLegacySessions?: boolean;
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
  readCookie: typeof readCookie;
  createSessionCookieHeaders: typeof createSessionCookieHeaders;
  sessionHasRole: typeof sessionHasRole;
  sessionPrimaryRole: typeof sessionPrimaryRole;
  sessionNeedsRole: typeof sessionNeedsRole;
  normalizeRoleRegistry: typeof normalizeRoleRegistry;
  resolveRoleId: typeof resolveRoleId;
  createDelegateAuth: typeof createDelegateAuth;
};
export default _default;
