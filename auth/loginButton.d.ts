/** Where the script loads `@engine9/id` from when the page has not loaded it. */
export declare const DEFAULT_ID_SCRIPT: string;
/** Path of the route under the API root (`/auth/login.js`). */
export declare const LOGIN_BUTTON_PATH: string;

/** The two lines a page adds: the button's slot and `<script src="/api/auth/login.js" defer>`. */
export declare function loginButtonSnippet(apiPath?: string): string;

export interface LoginButtonOptions {
  /** Shown on the dialog and on Delegate's sign-in page. Default: `signIn.brand.name`, else the hostname. */
  siteName?: string;
  /** An https URL to load `@engine9/id` from instead of unpkg. */
  idScript?: string;
}

/** The script `GET /api/auth/login.js` serves. The API root comes from the script's own URL. */
export declare function loginButtonScript(opts: {
  publicApiKey: string;
  delegateUrl?: string;
  signIn?: {
    minLevel?: number;
    maxLevel?: number;
    fields?: string[];
    optionalFields?: string[];
    loginLevel?: number;
    loginProviders?: string[] | string;
    brand?: Record<string, string>;
    /** `false` turns the route off. */
    loginButton?: false | LoginButtonOptions;
  };
}): string;

/** A script that only reports `reason` in the console. */
export declare function loginButtonUnavailable(reason: string): string;
