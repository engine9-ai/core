/**
 * One-time setup page for wiring a website to the engine9 API.
 * Gated by E9_SETUP_TOKEN. Never shows the admin key.
 */

const META_TABLE = 'e9core_meta';
const KEY_FINISHED = 'setup_finished';
const KEY_ORIGINS = 'allowed_origins';

export function parseOriginList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mergeOrigins(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const origin of parseOriginList(list)) {
      if (seen.has(origin)) continue;
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

export async function ensureSetupMeta(worker) {
  if (!worker) return;
  try {
    await worker.query({ sql: `SELECT 1 AS ok FROM ${META_TABLE} LIMIT 1` });
  } catch {
    await worker.createTable({
      table: META_TABLE,
      columns: [
        { name: 'key', type: 'string' },
        { name: 'value', type: 'text' }
      ],
      indexes: [{ columns: ['key'], primary: true }]
    });
  }
}

export async function getMeta(worker, key) {
  if (!worker) return null;
  await ensureSetupMeta(worker);
  const { data } = await worker.query({
    sql: `SELECT value FROM ${META_TABLE} WHERE key = ?`,
    values: [key]
  });
  return data?.[0]?.value ?? null;
}

export async function setMeta(worker, key, value) {
  if (!worker) return;
  await ensureSetupMeta(worker);
  const existing = await getMeta(worker, key);
  if (existing == null) {
    await worker.query({
      sql: `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`,
      values: [key, String(value)]
    });
  } else {
    await worker.query({
      sql: `UPDATE ${META_TABLE} SET value = ? WHERE key = ?`,
      values: [String(value), key]
    });
  }
}

export async function isSetupFinished(worker) {
  const value = await getMeta(worker, KEY_FINISHED);
  return Boolean(value);
}

export async function markSetupFinished(worker) {
  await setMeta(worker, KEY_FINISHED, new Date().toISOString());
}

export async function getStoredOrigins(worker) {
  const raw = await getMeta(worker, KEY_ORIGINS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parseOriginList(parsed);
  } catch {
    return parseOriginList(raw);
  }
}

export async function setStoredOrigins(worker, origins) {
  await setMeta(worker, KEY_ORIGINS, JSON.stringify(parseOriginList(origins)));
}

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i += 1) out |= left[i] ^ right[i];
  return out === 0;
}

/** Local setup wizard. Served only by `e9core serve`, never by the production Worker. */
export function renderWizardHtml({ token }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>engine9 setup</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; color: #1a1a1a; }
    h1 { font-size: 1.6rem; }
    h2 { font-size: 1.15rem; }
    button, .choice { font: inherit; cursor: pointer; }
    .choices { display: grid; gap: 0.75rem; }
    .choice { text-align: left; padding: 0.9rem 1rem; border: 1px solid #ccc; border-radius: 6px; background: #fff; }
    .choice strong { display: block; }
    button { margin-top: 0.6rem; margin-right: 0.4rem; padding: 0.45rem 0.85rem; }
    pre { background: #f4f4f4; padding: 0.8rem; overflow: auto; border-radius: 4px; font-size: 0.85rem; }
    .note { color: #444; }
    .ok { color: #0a7a32; }
    .err { color: #a40000; }
    label { display: block; font-weight: 600; margin-top: 0.8rem; }
    input, textarea { width: 100%; box-sizing: border-box; margin-top: 0.3rem; padding: 0.45rem; font: inherit; }
    details { margin-top: 1.5rem; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <h1>engine9 setup</h1>
  <p class="note">Pages and the engine9 API stay one website. Choose where that website will run.</p>
  <div id="choose" class="choices">
    <button class="choice" type="button" data-host="cloudflare"><strong>Cloudflare</strong>Recommended when this site should live on Cloudflare.</button>
    <button class="choice" type="button" data-host="node"><strong>Your own servers</strong>Node.js on a machine you run, including this one.</button>
  </div>

  <section id="cloudflare" hidden>
    <h2>Cloudflare</h2>
    <p class="note" id="cf-account">Checking the Cloudflare account on this machine…</p>
    <button type="button" id="cf-login">Log in to Cloudflare</button>
    <button type="button" id="cf-setup">Create the project</button>
    <button type="button" id="cf-preview">Start a local preview</button>
    <p class="note" id="cf-preview-url"></p>
    <label for="cf-domain">Hostname to attach (optional)</label>
    <input id="cf-domain" type="text" placeholder="www.example.com" />
    <button type="button" id="cf-deploy">Put it on the internet</button>
    <p class="note" id="cf-msg"></p>
  </section>

  <section id="node" hidden>
    <h2>Your own servers</h2>
    <button type="button" id="node-setup">Create the database</button>
    <p class="note" id="node-ok"></p>
    <pre id="node-snippet" hidden></pre>
    <button type="button" id="node-write">Write engine9-config.js</button>
    <h3>Try a signup</h3>
    <label for="try-email">Email</label>
    <input id="try-email" type="email" value="alex@example.com" />
    <label for="try-name">Name</label>
    <input id="try-name" type="text" value="Alex" />
    <button type="button" id="node-try">Save this person</button>
    <p class="note" id="node-msg"></p>
  </section>

  <section id="after" hidden>
    <button type="button" id="finish">Finish setup</button>
    <p class="note">Finish closes this wizard. Reopen later with <code>npx e9core serve --setup</code> on this machine.</p>
    <details>
      <summary>Advanced</summary>
      <p class="note">Independent hosts: HTML on another site, API here. List origins (scheme, host, and port), one per line.</p>
      <textarea id="origins" rows="3" placeholder="https://www.example.com"></textarea>
      <button type="button" id="save-origins">Save origins</button>
      <button type="button" id="rotate-public">Replace the public key</button>
      <p class="note" id="adv-msg"></p>
      <p class="note" id="status-line"></p>
    </details>
  </section>
  <script>
    const token = ${JSON.stringify(token)};
    const choose = document.getElementById('choose');
    const cf = document.getElementById('cloudflare');
    const node = document.getElementById('node');
    const after = document.getElementById('after');
    function showMsg(id, text, ok) {
      const el = document.getElementById(id);
      el.textContent = text || '';
      el.className = 'note ' + (ok ? 'ok' : text ? 'err' : '');
    }
    async function post(action, extra) {
      const res = await fetch('/setup?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, extra || {}))
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }
    function showHost(host) {
      choose.hidden = true;
      cf.hidden = host !== 'cloudflare';
      node.hidden = host !== 'node';
      after.hidden = false;
    }
    document.querySelectorAll('[data-host]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const host = btn.getAttribute('data-host');
        await post('choose', { host: host });
        showHost(host);
        if (host === 'cloudflare') refreshAccount();
        if (host === 'node') refreshNode();
      });
    });
    async function refreshAccount() {
      try {
        const data = await post('whoami');
        document.getElementById('cf-account').textContent = data.account
          ? ('Cloudflare account: ' + data.account)
          : 'Not logged in yet. Use the button to open Cloudflare login on this machine.';
      } catch (err) {
        document.getElementById('cf-account').textContent = err.message;
      }
    }
    async function refreshNode() {
      const data = await post('status');
      document.getElementById('node-ok').textContent = data.apiOk ? 'This website is running.' : 'Create the database, then this page will confirm the API.';
      if (data.publicKey) {
        const pre = document.getElementById('node-snippet');
        pre.hidden = false;
        pre.textContent = "const ENGINE9_API = '/api';\\nconst ENGINE9_PUBLIC_KEY = '" + data.publicKey + "';\\nconst ENGINE9_SOURCE = 'website';";
      }
      if (data.origins) document.getElementById('origins').value = data.origins.join('\\n');
      document.getElementById('status-line').textContent = data.statusLine || '';
    }
    document.getElementById('cf-login').onclick = async () => {
      showMsg('cf-msg', '');
      try {
        await post('login');
        showMsg('cf-msg', 'Cloudflare login started in your browser. This page will check again.', true);
        setTimeout(refreshAccount, 2000);
      } catch (err) { showMsg('cf-msg', err.message); }
    };
    document.getElementById('cf-setup').onclick = async () => {
      showMsg('cf-msg', 'Creating the project…', true);
      try {
        const data = await post('setup-cloudflare');
        showMsg('cf-msg', (data.notes || []).join(' '), true);
      } catch (err) { showMsg('cf-msg', err.message); }
    };
    document.getElementById('cf-preview').onclick = async () => {
      showMsg('cf-msg', '');
      try {
        const data = await post('preview');
        document.getElementById('cf-preview-url').textContent = data.url ? ('Local preview: ' + data.url) : '';
        showMsg('cf-msg', 'Preview starting.', true);
      } catch (err) { showMsg('cf-msg', err.message); }
    };
    document.getElementById('cf-deploy').onclick = async () => {
      showMsg('cf-msg', 'Deploying…', true);
      try {
        const domain = document.getElementById('cf-domain').value.trim();
        const data = await post('deploy', { domain: domain });
        showMsg('cf-msg', (data.notes || []).join(' '), true);
      } catch (err) { showMsg('cf-msg', err.message); }
    };
    document.getElementById('node-setup').onclick = async () => {
      showMsg('node-msg', 'Creating the database…', true);
      try {
        await post('setup-node');
        showMsg('node-msg', 'Database created.', true);
        refreshNode();
      } catch (err) { showMsg('node-msg', err.message); }
    };
    document.getElementById('node-write').onclick = async () => {
      try {
        const data = await post('write-config');
        showMsg('node-msg', 'Wrote ' + data.file, true);
      } catch (err) { showMsg('node-msg', err.message); }
    };
    document.getElementById('node-try').onclick = async () => {
      try {
        const data = await post('try-signup', {
          email: document.getElementById('try-email').value,
          givenName: document.getElementById('try-name').value
        });
        showMsg('node-msg', data.message, true);
      } catch (err) { showMsg('node-msg', err.message); }
    };
    document.getElementById('save-origins').onclick = async () => {
      try {
        const origins = document.getElementById('origins').value.split(/\\n|,/).map((s) => s.trim()).filter(Boolean);
        await post('origins', { origins: origins });
        showMsg('adv-msg', 'Saved origins.', true);
      } catch (err) { showMsg('adv-msg', err.message); }
    };
    document.getElementById('rotate-public').onclick = async () => {
      try {
        await post('rotate-public');
        showMsg('adv-msg', 'Public key replaced.', true);
        if (!node.hidden) refreshNode();
      } catch (err) { showMsg('adv-msg', err.message); }
    };
    document.getElementById('finish').onclick = async () => {
      try {
        await post('finish');
        document.body.innerHTML = '<h1>engine9 setup is finished</h1><p>This wizard is closed. The live site does not include it.</p>';
      } catch (err) { showMsg('adv-msg', err.message); }
    };
    post('status').then((data) => {
      if (data.host) showHost(data.host);
      if (data.host === 'cloudflare') refreshAccount();
      if (data.host === 'node') refreshNode();
    }).catch(() => {});
  </script>
</body>
</html>`;
}

export { KEY_FINISHED, KEY_ORIGINS, META_TABLE };
