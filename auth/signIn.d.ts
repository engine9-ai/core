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
