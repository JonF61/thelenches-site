// worker/src/index.js
// Lenches approvals Worker.
//   GET  /a?t=TOKEN  confirm page only (link scanners just GET, so they can't approve anything)
//   POST /a          verifies the signed token, fires repository_dispatch "approval"
//   cron             watchdog: ingestion still running and site up; alerts via GitHub
// Single use is enforced downstream: the approval Action only changes rows still "pending".

const enc = new TextEncoder();
const dec = new TextDecoder();

const INGEST_STALE_HOURS = 9;        // ingestion pauses overnight for about 7 hours
const ISSUE_TITLE = 'Watchdog alert';

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Returns the payload, { expired: true }, or null if the token is invalid.
async function verifyToken(token, secret) {
  if (!secret) return null;
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  let sigBytes;
  let payload;
  try {
    sigBytes = b64urlToBytes(sig);
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
  if (!ok) return null;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (!payload || !['approve', 'reject'].includes(payload.a)) return null;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(payload.i || ''))) return null;
  if (!payload.e || payload.e < Date.now() / 1000) return { expired: true };
  return payload;
}

function page(title, bodyHtml, status = 200) {
  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#F6F1E4;color:#2b2b2b;margin:0;padding:24px}
main{max-width:520px;margin:40px auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{color:#3F5233;font-size:1.3rem;margin-top:0}
button{font-size:1rem;padding:12px 24px;border:0;border-radius:8px;color:#fff;cursor:pointer}
.approve{background:#3F5233}.reject{background:#A33B2B}
.muted{color:#666;font-size:.9rem}
</style></head><body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
    },
  });
}

const invalidPage = () => page('Invalid link',
  '<h1>Invalid link</h1><p>This link is not valid. Please use the buttons in the latest digest.</p>', 400);
const expiredPage = () => page('Link expired',
  '<h1>Link expired</h1><p>This link has expired. The item is still in the Sheet and will appear in the next digest.</p>', 410);

function github(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lenches-approvals-worker',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

/* ------------------------------------------------------------ approvals -- */

async function handleApproval(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const token = url.searchParams.get('t');
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p) return invalidPage();
    if (p.expired) return expiredPage();
    const verb = p.a === 'approve' ? 'Approve' : 'Reject';
    return page(`${verb} item`, `
<h1>${verb} this item?</h1>
<p><strong>${esc(p.t || p.i)}</strong></p>
<form method="post" action="/a">
  <input type="hidden" name="t" value="${esc(token)}">
  <button class="${p.a}" type="submit">${verb}</button>
</form>
<p class="muted">Item ${esc(p.i)}</p>`);
  }

  if (request.method === 'POST') {
    let token = '';
    try {
      token = (await request.formData()).get('t');
    } catch {
      return invalidPage();
    }
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p) return invalidPage();
    if (p.expired) return expiredPage();

    const res = await github(env, `/repos/${env.REPO}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ event_type: 'approval', client_payload: { id: p.i, action: p.a } }),
    });
    if (res.status !== 204) {
      console.error(`Dispatch failed: HTTP ${res.status} ${await res.text()}`);
      return page('Something went wrong',
        '<h1>Something went wrong</h1><p>GitHub did not accept the request. Please try again in a few minutes; the item is unchanged.</p>', 502);
    }
    const done = p.a === 'approve' ? 'Approved' : 'Rejected';
    return page(done, `
<h1>${done}</h1>
<p><strong>${esc(p.t || p.i)}</strong></p>
<p>Recorded. If this item had already been decided, nothing changes.</p>`);
  }

  return new Response('Method not allowed', { status: 405 });
}

/* ------------------------------------------------------------- watchdog -- */

async function checkIngestion(env, problems) {
  try {
    const r = await github(env, `/repos/${env.REPO}/actions/workflows/ingest.yml/runs?event=schedule&per_page=1`);
    if (!r.ok) {
      problems.push(`GitHub API returned HTTP ${r.status} when checking ingestion runs (token revoked or expired?)`);
      return;
    }
    const run = ((await r.json()).workflow_runs || [])[0];
    const hours = run ? (Date.now() - Date.parse(run.created_at)) / 3600000 : Infinity;
    if (hours > INGEST_STALE_HOURS) {
      problems.push(run
        ? `No scheduled ingestion run for ${Math.floor(hours)} hours (GitHub may have paused the schedule)`
        : 'No scheduled ingestion run found at all');
    }
  } catch (e) {
    problems.push(`Ingestion check failed: ${e.message}`);
  }
}

async function checkSite(env, problems) {
  try {
    const r = await fetch(env.SITE_URL, { redirect: 'follow' });
    if (!r.ok) problems.push(`Website returned HTTP ${r.status}`);
  } catch (e) {
    problems.push(`Website unreachable: ${e.message}`);
  }
}

async function findOpenIssue(env) {
  const r = await github(env, `/repos/${env.REPO}/issues?state=open&per_page=100`);
  if (!r.ok) throw new Error(`Listing issues failed: HTTP ${r.status}`);
  return ((await r.json()) || []).find((i) => i.title === ISSUE_TITLE && !i.pull_request) || null;
}

// One open issue per incident. A new incident also triggers a deliberately failing
// workflow, because GitHub doesn't email you about issues you (via your token) opened.
async function report(env, problems) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const open = await findOpenIssue(env);

  if (problems.length && !open) {
    const body = `The Cloudflare watchdog found problems at ${now}:\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\n`
      + 'This issue closes itself when the next check passes.';
    const c = await github(env, `/repos/${env.REPO}/issues`, {
      method: 'POST', body: JSON.stringify({ title: ISSUE_TITLE, body }),
    });
    if (!c.ok) console.error(`Creating issue failed: HTTP ${c.status}`);
    const d = await github(env, `/repos/${env.REPO}/dispatches`, {
      method: 'POST', body: JSON.stringify({ event_type: 'watchdog-alert', client_payload: { problems } }),
    });
    if (d.status !== 204) console.error(`Alert dispatch failed: HTTP ${d.status}`);
  } else if (!problems.length && open) {
    await github(env, `/repos/${env.REPO}/issues/${open.number}/comments`, {
      method: 'POST', body: JSON.stringify({ body: `All checks passed at ${now}. Closing.` }),
    });
    await github(env, `/repos/${env.REPO}/issues/${open.number}`, {
      method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
  }
}

async function watchdog(env) {
  const problems = [];
  await Promise.all([checkIngestion(env, problems), checkSite(env, problems)]);
  console.log(problems.length ? `Problems: ${problems.join(' | ')}` : 'All checks passed.');
  try {
    await report(env, problems);
  } catch (e) {
    console.error(`Reporting failed: ${e.message}`);
  }
}

/* ---------------------------------------------------------------- entry -- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/a') return handleApproval(request, env);
    return new Response('Lenches approvals', { headers: { 'content-type': 'text/plain' } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env));
  },
};
