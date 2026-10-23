export interface GateAuth {
  roleRegistry: Record<string, { name?: string; scopes?: string[]; requiredAuth?: object }>;
  verifySession(token: string): Promise<Record<string, any> | null>;
  rolesForSession(session: Record<string, any>): Promise<string[]>;
}

export interface GateOptions {
  auth: GateAuth;
  request: Request;
  /** Role name or id from `auth.roleRegistry`. Omit to require only a signed-in browser. */
  role?: string;
  cookieName?: string;
  startPath?: string;
}

export type GateResult =
  | { ok: true; session: Record<string, any>; roles: string[] }
  | { ok: false; status: 302 | 401 | 403; response: Response };

export function requireRole(options: GateOptions): Promise<GateResult>;
export function sessionFromRequest(options: {
  auth: GateAuth;
  request: Request;
  cookieName?: string;
}): Promise<Record<string, any> | null>;
export function createGate(options: { auth: GateAuth; cookieName?: string; startPath?: string }): {
  requireRole(request: Request, role?: string): Promise<GateResult>;
  session(request: Request): Promise<Record<string, any> | null>;
};
