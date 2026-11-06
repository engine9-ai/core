/*
  GET /api/admin/status opened in a browser: the same report as the JSON
  route, as a page for a signed-in admin (api/index.js gates it with
  requireRole). Read-only. No script; the page links nowhere that changes
  anything. Each failing check shows the fix that needs no terminal
  (`fix_web`) first and the command (`fix`) second.
*/

const AREAS = ['account', 'project', 'secrets', 'audit', 'database', 'handle', 'core', 'keys', 'upgrades', 'plugins'];
const MARK = { pass: '✔', warn: '⚠', fail: '✖', skip: '·' };
const COLOR = { pass: '#137333', warn: '#b06000', fail: '#c5221f', skip: '#5f6368' };

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#202124}
h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.5rem 0 .5rem;border-bottom:1px solid #e0e0e0;padding-bottom:.25rem}
.meta{color:#5f6368;font-size:13px}.summary{font-weight:600;margin:1rem 0}
ul{list-style:none;padding:0;margin:0}li{margin:.35rem 0}.detail{color:#3c4043;font-size:14px;margin:.15rem 0 0 1.4rem}
.fix{font-size:14px;margin:.15rem 0 0 1.4rem}.cmd{font:12px ui-monospace,monospace;color:#5f6368;margin:.1rem 0 0 1.4rem;word-break:break-all}`;

function checkItem(c) {
  const color = COLOR[c.status] || '#202124';
  const lines = [`<li><span style="color:${color}">${MARK[c.status] || '?'}</span> ${escapeHtml(c.title)}`];
  if (c.status !== 'pass') {
    if (c.detail) lines.push(`<div class="detail">${escapeHtml(c.detail)}</div>`);
    if (c.fix_web) lines.push(`<div class="fix"><strong>Fix:</strong> ${escapeHtml(c.fix_web)}</div>`);
    if (c.fix) lines.push(`<div class="cmd">${c.fix_web ? 'or, with a terminal: ' : 'Fix: '}${escapeHtml(c.fix)}</div>`);
  }
  lines.push('</li>');
  return lines.join('');
}

/** The status report as a complete HTML document. `email` is who is signed in. */
export function renderStatusPage(report, { email = null, site = '' } = {}) {
  const byArea = new Map();
  for (const c of report.checks || []) {
    if (!byArea.has(c.area)) byArea.set(c.area, []);
    byArea.get(c.area).push(c);
  }
  const order = [...AREAS.filter((a) => byArea.has(a)), ...[...byArea.keys()].filter((a) => !AREAS.includes(a))];
  const sections = order.map((area) => {
    const checks = byArea.get(area);
    // Passing plugin checks are many and say little; count them instead.
    const shown = area === 'plugins' ? checks.filter((c) => c.status !== 'pass') : checks;
    const items = shown.map(checkItem);
    if (area === 'plugins') {
      const plugins = new Set(checks.map((c) => c.plugin));
      const bad = new Set(checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.plugin));
      items.push(`<li><span style="color:${COLOR.pass}">${MARK.pass}</span> ${plugins.size - bad.size} of ${plugins.size} plugins match the code</li>`);
    }
    return `<h2>${escapeHtml(area[0].toUpperCase() + area.slice(1))}</h2><ul>${items.join('')}</ul>`;
  });
  const s = report.summary || {};
  const versions = [
    report.core_version && `@engine9/core ${report.core_version}`,
    report.schemas_version && `@engine9/schemas ${report.schemas_version}`
  ].filter(Boolean).join(', ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Site status</title><style>${STYLE}</style></head><body>
<h1>Site status${site ? `: ${escapeHtml(site)}` : ''}</h1>
<div class="meta">${escapeHtml(versions)}${report.generated_at ? ` · ${escapeHtml(report.generated_at)}` : ''}${email ? ` · signed in as ${escapeHtml(email)}` : ''}</div>
<p class="summary" style="color:${s.fail ? COLOR.fail : s.warn ? COLOR.warn : COLOR.pass}">${s.fail || 0} failed, ${s.warn || 0} warnings, ${s.pass || 0} passed${s.skip ? `, ${s.skip} skipped` : ''}</p>
${sections.join('\n')}
<p class="meta">Read-only. The same report as JSON: GET /api/admin/status with the admin key, or npx e9core status --remote.</p>
</body></html>`;
}

/** A short page for when the status page itself cannot be shown. */
export function messagePage(title, paragraphs) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</body></html>`;
}
