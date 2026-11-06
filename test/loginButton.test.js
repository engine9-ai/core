import { test } from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { createDelegateAuth } from '../auth/delegate.js';
import { createApi } from '../api/index.js';
import { loginButtonScript, loginButtonSnippet, DEFAULT_ID_SCRIPT } from '../auth/loginButton.js';

const SITE = 'https://site.example.com';
const PUBLIC_KEY = 'e9publickey_test';

function makeApi({ signIn = {}, environment = { E9_PUBLIC_API_KEY: PUBLIC_KEY }, login = true, delegateUrl } = {}) {
  const worker = { accountId: 'test', async query() { return { data: [] }; } };
  const delegateAuth = login
    ? createDelegateAuth({
        worker,
        delegateUrl: delegateUrl || 'https://delegate.network',
        sessionSecret: '0123456789abcdef'.repeat(4),
        pluginId: 'p',
        jwks: { keys: [] }
      })
    : null;
  const keyStore = { verify: async () => ({ valid: false, reason: 'missing_key' }) };
  return createApi({ worker, keyStore, delegateAuth, environment, config: { pluginId: 'p', signIn } });
}

/* Objects made inside the vm have its prototypes; compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const getScript = (api) => api.handleFetch(new Request(`${SITE}/api/auth/login.js`));

/* Run the served script against a fake page and a fake @engine9/id. */
async function runScript(source, { src = `${SITE}/api/auth/login.js`, origin = SITE, href = `${SITE}/`, me } = {}) {
  const calls = { client: null, widget: null, updates: [], logins: 0, errors: [], events: [] };
  const id = {
    core: {
      async login() {
        calls.logins += 1;
        return { session: { email: 'ada@example.com', level: 3 } };
      },
      me: me || (async () => {
        const err = new Error('core /auth/me failed');
        err.details = { status: 401 };
        throw err;
      })
    }
  };
  const widget = { update: (state) => calls.updates.push(state) };
  const window = {
    engine9Id: {
      createEngine9Id(config) {
        calls.client = config;
        return id;
      },
      loginWidget(options) {
        calls.widget = options;
        return widget;
      },
      isSiteKeyRejected: () => false
    }
  };
  const document = {
    readyState: 'complete',
    currentScript: { src },
    dispatchEvent: (event) => calls.events.push(event.type),
    addEventListener() {},
    head: { appendChild() {} }
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const context = {
    window,
    document,
    location: { origin, href, reload() {} },
    console: { error: (...args) => calls.errors.push(args.join(' ')), log() {} },
    CustomEvent,
    URL,
    Object
  };
  vm.runInNewContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, window, id };
}

test('loginButtonSnippet is the two lines a page adds', () => {
  assert.strictEqual(
    loginButtonSnippet(),
    '<span data-e9-login-widget></span>\n<script src="/api/auth/login.js" defer></script>'
  );
  assert.match(loginButtonSnippet('/engine9/'), /src="\/engine9\/auth\/login\.js"/);
});

test('GET /auth/login.js serves the Login button with no API key, wired to core with a cookie session', async () => {
  const api = makeApi({ signIn: { brand: { name: 'Solstice Wave', color: '#a855f7' }, fields: ['email'] } });
  const res = await getScript(api);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=300');
  const body = await res.text();
  assert.ok(body.includes(PUBLIC_KEY));
  assert.ok(body.includes(DEFAULT_ID_SCRIPT));

  const { calls } = await runScript(body);
  assert.deepStrictEqual(plain(calls.client.core), { publicApiKey: PUBLIC_KEY, session: 'cookie', apiUrl: '/api' });
  assert.strictEqual(calls.client.delegateUrl, 'https://delegate.network');
  assert.deepStrictEqual(plain(calls.client.brand), { name: 'Solstice Wave', color: '#a855f7' });
  assert.strictEqual(calls.widget.siteName, 'Solstice Wave');
  assert.deepStrictEqual(plain(calls.widget.fields), ['email']);
  assert.deepStrictEqual(plain(calls.events), ['engine9:login-ready']);

  // onLogin makes core set e9_session and shows the address core confirmed.
  const user = await calls.widget.onLogin({ level: 3, fields: {} }, null);
  assert.strictEqual(calls.logins, 1);
  assert.deepStrictEqual(plain(user), { email: 'ada@example.com', level: 3 });
});

test('the script uses the Delegate host core verifies against', async () => {
  const body = await (await getScript(makeApi({ delegateUrl: 'https://delegate.engine9.ai' }))).text();
  const { calls } = await runScript(body);
  assert.strictEqual(calls.client.delegateUrl, 'https://delegate.engine9.ai');
});

test('the API root comes from the script URL: relative on the same host, absolute on another', async () => {
  const source = loginButtonScript({ publicApiKey: PUBLIC_KEY });
  const same = await runScript(source, { src: `${SITE}/engine9/auth/login.js` });
  assert.strictEqual(same.calls.client.core.apiUrl, '/engine9');
  const other = await runScript(source, { src: 'https://api.example.com/api/auth/login.js' });
  assert.strictEqual(other.calls.client.core.apiUrl, 'https://api.example.com/api');
});

test('a visitor already signed in to core shows as signed in; a 401 shows Login', async () => {
  const source = loginButtonScript({ publicApiKey: PUBLIC_KEY });
  const signedIn = await runScript(source, {
    me: async () => ({ personId: 7, email: 'ada@example.com', level: 3 })
  });
  assert.deepStrictEqual(plain(signedIn.calls.updates), [{ user: { email: 'ada@example.com', level: 3 } }]);

  const signedOut = await runScript(source);
  assert.deepStrictEqual(plain(signedOut.calls.updates), [{ user: null }]);
});

test('a login returning from Delegate is left to onLogin, not overwritten by /auth/me', async () => {
  const source = loginButtonScript({ publicApiKey: PUBLIC_KEY });
  let asked = false;
  const { calls } = await runScript(source, {
    href: `${SITE}/#delegate_token=abc&state=s`,
    me: async () => {
      asked = true;
      return {};
    }
  });
  assert.strictEqual(asked, false);
  assert.deepStrictEqual(plain(calls.updates), []);
});

test('values from config cannot break out of the script', async () => {
  const body = await (await getScript(makeApi({ signIn: { brand: { name: '</script><script>alert(1)</script>' } } }))).text();
  assert.ok(!body.includes('</script>'));
  const { calls } = await runScript(body);
  assert.strictEqual(calls.client.brand.name, '</script><script>alert(1)</script>');
});

test('loginButton.idScript must be https; otherwise the default is used', () => {
  assert.ok(loginButtonScript({ publicApiKey: PUBLIC_KEY, signIn: { loginButton: { idScript: 'https://www.example.com/id.js' } } }).includes('"https://www.example.com/id.js"'));
  assert.ok(loginButtonScript({ publicApiKey: PUBLIC_KEY, signIn: { loginButton: { idScript: 'http://evil.example/id.js' } } }).includes(DEFAULT_ID_SCRIPT));
});

test('optional: loginButton: false turns the route off', async () => {
  const res = await getScript(makeApi({ signIn: { loginButton: false } }));
  assert.strictEqual(res.status, 404);
});

test('login off or no public key: still a script, and it says what to fix in the console', async () => {
  const off = await getScript(makeApi({ login: false }));
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.headers.get('cache-control'), 'no-store');
  const offRun = await runScript(await off.text());
  assert.strictEqual(offRun.calls.client, null);
  assert.match(offRun.calls.errors[0], /SESSION_SECRET/);

  const noKey = await getScript(makeApi({ environment: {} }));
  const noKeyRun = await runScript(await noKey.text());
  assert.strictEqual(noKeyRun.calls.client, null);
  assert.match(noKeyRun.calls.errors[0], /E9_PUBLIC_API_KEY/);
});
