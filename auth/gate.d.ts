export interface GateAuth {
  roleRegistry: Record<string, { name?: string; scopes?: string[]; requiredAuth?: object }>;
  verifySession(token: string): Promise<Record<string, any> | null>;
  rolesForSession(session: Record<string, any>): Promise<string[]>;
}

export interface GateOptions {
  auth: GateAuth;
  request: Request;
  /**
   * Role name or id from `auth.roleRegistry`, or several (holding any one is
   * enough). Omit to require only a signed-in browser.
   */
  role?: string | string[];
  cookieName?: string;
  startPath?: string;
  /** Answer as a page load (redirect, HTML) or as `fetch()` (JSON). Default: from the request headers. */
  page?: boolean;
}

export type GateDenial = 'sign_in_required' | 'role_not_held' | 'auth_not_met';

export type GateResult =
  | { ok: true; session: Record<string, any>; roles: string[] }
  | {
      ok: false;
      status: 302 | 401 | 403;
      reason: GateDenial;
      /** Ready to return. Signed out: 302 or 401 JSON. Signed in without access: 403 page or JSON. */
      response: Response;
      /** `/api/auth/start?returnTo=<this page>` */
      signInUrl: string;
      /** The same with `prompt=select&reason=access_denied`: pick another address or account. */
      changeUrl: string;
      /** 403 only: the address this person is signed in with (null without a confirmed one). */
      email?: string | null;
      /** 403 only: the role's name. */
      role?: string;
    };

export function requireRole(options: GateOptions): Promise<GateResult>;
export function sessionFromRequest(options: {
  auth: GateAuth;
  request: Request;
  cookieName?: string;
}): Promise<Record<string, any> | null>;
export function createGate(options: { auth: GateAuth; cookieName?: string; startPath?: string }): {
  requireRole(request: Request, role?: string | string[]): Promise<GateResult>;
  session(request: Request): Promise<Record<string, any> | null>;
};
