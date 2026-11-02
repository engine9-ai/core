export const DEFAULT_SESSION_COOKIE: string;
export function safeReturnPath(value: unknown, options?: { origin?: string; fallback?: string }): string;
export function withQueryParam(path: string, name: string, value: string): string;
export function plausibleEmail(value: unknown): string | undefined;
export function sessionTokenFromCookie(cookieHeader: string | null | undefined, cookieName?: string): string | null;
export function sessionCookie(
  token: string,
  options?: { cookieName?: string; maxAge?: number; secure?: boolean }
): string;
export function clearSessionCookie(options?: { cookieName?: string; secure?: boolean }): string;
export const DEFAULT_START_PATH: string;
/** `/api/auth/start?returnTo=<path>`: sign in, then come back. */
export function signInUrl(returnTo: string, options?: { startPath?: string }): string;
/**
 * `/api/auth/start?returnTo=<path>&prompt=select`: sign in with another
 * address or account. `reason: 'access_denied'` from an access-denied page.
 */
export function changeSignInUrl(
  returnTo: string,
  options?: { startPath?: string; reason?: 'access_denied' }
): string;
/** A page load (link, form, address bar), not `fetch()` from page code. */
export function isPageRequest(request: Request): boolean;
