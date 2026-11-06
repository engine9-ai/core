/*
  The Delegate Login button, served by core: `GET /api/auth/login.js`.

  A page adds two lines and gets the button demo-festival has in its header:

    <span data-e9-login-widget></span>
    <script src="/api/auth/login.js" defer></script>

  The script loads `@engine9/id` (unless the page already has `window.engine9Id`)
  and calls `loginWidget` on a client with `core: { session: 'cookie' }`. Its
  `onLogin` calls `id.core.login()`, so core sets `e9_session`.

  Core writes the site's public key into the script from its own environment
  (`E9_PUBLIC_API_KEY`), so the page never needs a copy. That matters most for
  a site set up only in GitHub and Cloudflare: the workflow makes the key and
  stores it as a Worker secret no person can read. The key is the same one any
  page using `@engine9/id` carries; it can add people and log in, nothing else.

  Optional. Nothing appears unless a page includes the script, and a site turns
  the route off with `config.signIn.loginButton: false` (E9_SIGN_IN on the
  shipped Worker: `{"loginButton": false}`).
*/

/** Where the script loads `@engine9/id` from when the page has not loaded it. */
export const DEFAULT_ID_SCRIPT = 'https://unpkg.com/@engine9/id@1/dist/id.iife.js';

/** Path of the route under the API root. */
export const LOGIN_BUTTON_PATH = '/auth/login.js';

/** The two lines a page adds, for docs and setup output. */
export function loginButtonSnippet(apiPath = '/api') {
  const base = String(apiPath || '/api').replace(/\/$/, '');
  return `<span data-e9-login-widget></span>\n<script src="${base}${LOGIN_BUTTON_PATH}" defer></script>`;
}

/* JSON safe to put inside a script (no `</script>`, no line separators). */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function https(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The script source. Pure: everything it needs is passed in.
 *
 * The API root is not passed: the script takes it from its own URL
 * (`…/auth/login.js`), so it is right behind a proxy and on another host.
 *
 * @param {object} opts
 * @param {string} opts.publicApiKey   `e9publickey_…`
 * @param {string} [opts.delegateUrl]  the Delegate host core verifies tokens from
 * @param {object} [opts.signIn]       `config.signIn` (minLevel, fields, brand, …)
 */
export function loginButtonScript({ publicApiKey, delegateUrl, signIn = {} }) {
  const button = signIn.loginButton && typeof signIn.loginButton === 'object' ? signIn.loginButton : {};
  const client = {
    core: { publicApiKey, session: 'cookie' }
  };
  if (delegateUrl) client.delegateUrl = delegateUrl;
  if (signIn.brand) client.brand = signIn.brand;
  if (signIn.loginLevel) client.loginLevel = signIn.loginLevel;
  if (signIn.loginProviders) client.loginProviders = signIn.loginProviders;

  const widget = {};
  if (signIn.minLevel) widget.minLevel = signIn.minLevel;
  if (signIn.maxLevel) widget.maxLevel = signIn.maxLevel;
  if (signIn.fields) widget.fields = signIn.fields;
  if (signIn.optionalFields) widget.optionalFields = signIn.optionalFields;
  const siteName = button.siteName || signIn.brand?.name;
  if (siteName) widget.siteName = siteName;

  const idScript = https(button.idScript) || DEFAULT_ID_SCRIPT;

  return `/* @engine9/core: the Delegate Login button. Docs: https://github.com/engine9-ai/core/blob/main/docs/sign-in.md */
(function () {
  "use strict";
  var CLIENT = ${scriptJson(client)};
  var WIDGET = ${scriptJson(widget)};
  var ID_SCRIPT = ${scriptJson(idScript)};
  var TAG = "[engine9 login]";
  // The API root is where this script came from, less /auth/login.js.
  var SRC = (document.currentScript && document.currentScript.src) || "";
  var API = SRC ? new URL(SRC) : null;
  CLIENT.core.apiUrl = API
    ? (API.origin === location.origin ? "" : API.origin) + API.pathname.replace(/\\/auth\\/login\\.js$/, "")
    : "/api";

  function start() {
    var e9 = window.engine9Id;
    if (!e9 || !e9.loginWidget) {
      console.error(TAG, "@engine9/id did not load from " + ID_SCRIPT + ".");
      return;
    }
    var id = e9.createEngine9Id(CLIENT);
    var options = Object.assign({}, WIDGET, {
      id: id,
      onLogin: function (identity) {
        // core checks the nonce it issued and sets the e9_session cookie.
        return id.core.login().then(function (result) {
          var session = (result && result.session) || {};
          return {
            email: session.email || (identity && identity.fields && identity.fields.email) || null,
            level: session.level != null ? session.level : identity && identity.level
          };
        });
      },
      onLoggedOut: function () {
        location.reload();
      }
    });
    var widget = e9.loginWidget(options);
    window.engine9Login = { id: id, widget: widget };

    // Signed in already (another tab, or core's /api/auth/start link): show it.
    // Not while a login is returning from Delegate; onLogin answers that one.
    if (!/[?#&]delegate_token=/.test(location.href)) {
      id.core.me().then(function (me) {
        if (me && me.personId != null) widget.update({ user: { email: me.email || null, level: me.level } });
      }, function (err) {
        if (e9.isSiteKeyRejected && e9.isSiteKeyRejected(err)) console.error(TAG, err.message);
        else if (err && err.details && err.details.status === 401) widget.update({ user: null });
      });
    }
    document.dispatchEvent(new CustomEvent("engine9:login-ready", { detail: { id: id, widget: widget } }));
  }

  function load() {
    if (window.engine9Id) return start();
    var script = document.createElement("script");
    script.src = ID_SCRIPT;
    script.onload = start;
    script.onerror = function () {
      console.error(TAG, "Could not load @engine9/id from " + ID_SCRIPT + ".");
    };
    document.head.appendChild(script);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
`;
}

/**
 * The script for a site whose login is off or has no public key: valid
 * JavaScript that says why in the console, so a script tag never fails silently.
 */
export function loginButtonUnavailable(reason) {
  return `/* @engine9/core: the Delegate Login button is not available. */\nconsole.error(${scriptJson(`[engine9 login] ${reason}`)});\n`;
}
