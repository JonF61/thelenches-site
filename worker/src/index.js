// worker/src/index.js
// Lenches approvals Worker.
//   GET  /a?t=TOKEN  confirm page only (link scanners just GET, so they can't act on anything)
//   POST /a          verifies the signed token, fires repository_dispatch
//   GET  /u?t=TOKEN  unsubscribe confirm page (people clicking the footer link)
//   POST /u?t=TOKEN  one-click unsubscribe (RFC 8058: mail providers POST here) or the
//                    confirm page's button; fires repository_dispatch "unsubscribe"
//   cron WATCHDOG_CRON  ingestion and daily diagnostic still running, site up, and on
//                       Thursdays from 07:30 UK that the newsletter build has started;
//                       alerts via GitHub
//   cron SCHEDULE_CRON  UK-time schedule: Wed 18:30 digest; Thu 06:30 newsletter build,
//                       08:00 auto-send (does nothing unless holiday mode + live), 12:00
//                       and 17:00 reminders. A failed dispatch raises a watchdog alert.
//   cron NIGHTLY_CRON   00:10 UK every night: fires repository_dispatch "rebuild" so
//                       build.yml rebuilds the site and yesterday's events drop off.
//   cron INGEST_CRON    :17 past even UK hours 06-22: fires repository_dispatch "ingest"
//                       (GitHub's own cron ran hours late; it stays in ingest.yml as a backup).
// Actions: approve/reject (Pending items), approve_own/approve_rewrite (approve with the
// submitter's own wording or our rewrite), send/skip (submitter replies), nlsend/nlbuild
// (newsletter Send and Rebuild buttons). Single use and every send safeguard are enforced
// downstream: the Worker only passes signed requests on to GitHub.
// The Rebuild button's build carries rebuild: true, which lifts the Wednesday 18:00
// deadline cutoff (the scheduled 06:30 build keeps it).

const enc = new TextEncoder();
const dec = new TextDecoder();

const INGEST_STALE_HOURS = 9;        // ingestion pauses overnight for about 8 hours
const DIAGNOSTIC_STALE_HOURS = 30;   // daily run, plus slack for GitHub cron delays
const NEWSLETTER_DUE_HM = '07:30';   // UK, Thursdays: the 06:30 build should have started
const ISSUE_TITLE = 'Watchdog alert';
const WATCHDOG_CRON = '23 */3 * * *';
// Day names, not numbers: Cloudflare counts 1=Sunday..7=Saturday, so '3,4' was Tue/Wed (8 Oct 2026).
const SCHEDULE_CRON = '0,30 * * * WED,THU';
const NIGHTLY_CRON = '10 23,0 * * *';
const NIGHTLY_HM = '00:10';          // UK time; BST fires on the 23:10 UTC slot, GMT on 00:10
const INGEST_CRON = '17 * * * *';
const INGEST_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22]; // UK hours, as ingest.yml's gate
const NL_MODES = ['shadow', 'canary', 'live'];

// UK times. payload(date) gets the UK date (YYYY-MM-DD) of the slot.
const SLOTS = [
  { dow: 'Wed', hm: '18:30', event: 'digest', payload: () => ({}) },
  { dow: 'Thu', hm: '06:30', event: 'newsletter', payload: (d) => ({ action: 'build', issue_date: d }) },
  { dow: 'Thu', hm: '08:00', event: 'newsletter', payload: (d) => ({ action: 'autosend', issue_date: d }) },
  { dow: 'Thu', hm: '12:00', event: 'newsletter', payload: (d) => ({ action: 'remind', issue_date: d }) },
  { dow: 'Thu', hm: '17:00', event: 'newsletter', payload: (d) => ({ action: 'remind', issue_date: d }) },
];

// action -> [confirm verb, done word, button class]
const ACTIONS = {
  approve: ['Approve', 'Approved', 'approve'],
  reject: ['Reject', 'Rejected', 'reject'],
  approve_own: ['Approve with their wording', 'Approved with their wording', 'approve'],
  approve_rewrite: ['Approve with rewrite', 'Approved with our rewrite', 'approve'],
  send: ['Send reply', 'Reply queued to send', 'approve'],
  skip: ['Skip reply', 'Reply skipped', 'reject'],
  nlsend: ['Send newsletter', 'Send started', 'approve'],
  nlbuild: ['Rebuild newsletter', 'Rebuild started', 'approve'],
  unsub: ['Unsubscribe', 'Unsubscribed', 'reject'],
};

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function validPayload(p) {
  if (!p || !Object.prototype.hasOwnProperty.call(ACTIONS, p.a)) return false;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(p.i || ''))) return false;
  if (p.a === 'nlsend' || p.a === 'nlbuild') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.i)) return false;
  }
  if (p.a === 'nlsend') {
    if (!/^[0-9a-f]{12,64}$/.test(String(p.h || ''))) return false;
    if (!Number.isInteger(p.n) || p.n < 0 || p.n > 5000) return false;
    if (!NL_MODES.includes(p.m)) return false;
  }
  return true;
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
  if (!validPayload(payload)) return null;
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
.warn{color:#A33B2B;font-weight:bold}
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
  '<h1>Invalid link</h1><p>This link is not valid. Please use the buttons in the latest email.</p>', 400);
const expiredPage = () => page('Link expired',
  '<h1>Link expired</h1><p>This link has expired. Nothing has changed.</p>', 410);
const failedPage = () => page('Something went wrong',
  '<h1>Something went wrong</h1><p>GitHub did not accept the request. Please try again in a few minutes; nothing has changed.</p>', 502);

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

// repository_dispatch with retries. Returns true on HTTP 204.
async function dispatch(env, eventType, clientPayload, tries = 1) {
  let last = '';
  for (let n = 1; n <= tries; n += 1) {
    try {
      const r = await github(env, `/repos/${env.REPO}/dispatches`, {
        method: 'POST', body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
      });
      if (r.status === 204) return true;
      last = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
    } catch (e) {
      last = e.message;
    }
    if (n < tries) await sleep(3000 * n);
  }
  console.error(`Dispatch "${eventType}" failed: ${last}`);
  return false;
}

function dispatchFor(p) {
  if (p.a === 'nlsend') {
    return ['newsletter', {
      action: 'send', issue_date: p.i, confirm_count: String(p.n), expect_hash: p.h, expect_mode: p.m,
    }];
  }
  if (p.a === 'nlbuild') return ['newsletter', { action: 'build', issue_date: p.i, rebuild: true }];
  return ['approval', { id: p.i, action: p.a }];
}

/* ------------------------------------------------------------ approvals -- */

function confirmExtra(p) {
  if (p.a === 'nlsend' && p.m === 'live') {
    return '<p class="warn">This emails every subscriber. It cannot be undone.</p>';
  }
  if (p.a === 'nlsend') return `<p class="muted">Mode: ${esc(p.m)}. No subscriber receives anything in this mode.</p>`;
  if (p.a === 'nlbuild') return '<p class="muted">Builds the issue again with any approvals, including items that arrived after the Wednesday 6pm deadline, then sends a new test copy and preview. Older Send buttons stop working.</p>';
  return '';
}

function doneText(p) {
  if (p.a === 'nlsend') return 'Started. GitHub emails you if any safety check refuses it; the Issues and Sends tabs show progress.';
  if (p.a === 'nlbuild') return 'Started. A new test copy and preview should arrive in a few minutes.';
  return 'Recorded. If this had already been decided, nothing changes.';
}

async function handleApproval(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const token = url.searchParams.get('t');
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p || p.a === 'unsub') return invalidPage();
    if (p.expired) return expiredPage();
    const [verb, , cls] = ACTIONS[p.a];
    return page(verb, `
<h1>${esc(verb)}?</h1>
<p><strong>${esc(p.t || p.i)}</strong></p>
${confirmExtra(p)}
<form method="post" action="/a">
  <input type="hidden" name="t" value="${esc(token)}">
  <button class="${cls}" type="submit">${esc(p.a === 'nlsend' ? (p.t || verb) : verb)}</button>
</form>
<p class="muted">${esc(p.i)}</p>`);
  }

  if (request.method === 'POST') {
    let token = '';
    try {
      token = (await request.formData()).get('t');
    } catch {
      return invalidPage();
    }
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p || p.a === 'unsub') return invalidPage();
    if (p.expired) return expiredPage();

    const [eventType, payload] = dispatchFor(p);
    if (!(await dispatch(env, eventType, payload, 2))) return failedPage();
    const [, done] = ACTIONS[p.a];
    return page(done, `
<h1>${esc(done)}</h1>
<p><strong>${esc(p.t || p.i)}</strong></p>
<p>${esc(doneText(p))}</p>`);
  }

  return new Response('Method not allowed', { status: 405 });
}

/* ---------------------------------------------------------- unsubscribe -- */

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const expired = () => page('Link expired',
    '<h1>Link expired</h1><p>This unsubscribe link has expired. Reply UNSUBSCRIBE to any newsletter and we will remove you.</p>', 410);

  if (request.method === 'GET') {
    const token = url.searchParams.get('t');
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p || (!p.expired && p.a !== 'unsub')) return invalidPage();
    if (p.expired) return expired();
    return page('Unsubscribe', `
<h1>Unsubscribe from The Lenches Newsletter?</h1>
<p>You will stop receiving the weekly email. You can rejoin at any time by emailing website@thelenches.org.uk.</p>
<form method="post" action="/u?t=${esc(token)}">
  <button class="reject" type="submit">Unsubscribe</button>
</form>`);
  }

  if (request.method === 'POST') {
    // One-click POSTs carry the token in the URL (body "List-Unsubscribe=One-Click").
    let token = url.searchParams.get('t');
    if (!token) {
      try { token = (await request.formData()).get('t'); } catch { token = ''; }
    }
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p || (!p.expired && p.a !== 'unsub')) return invalidPage();
    if (p.expired) return expired();
    if (!(await dispatch(env, 'unsubscribe', { id: p.i }, 2))) return failedPage();
    return page('Unsubscribed', `
<h1>You're unsubscribed</h1>
<p>You won't receive The Lenches Newsletter any more. It can take a few minutes to take effect.</p>`);
  }

  return new Response('Method not allowed', { status: 405 });
}

/* ------------------------------------------------------------- schedule -- */

function ukNow(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return { dow: p.weekday, date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, hour: Number(p.hour) };
}

async function alertDispatchFailed(env, what) {
  try {
    await report(env, [what]);
  } catch (e) {
    console.error(`Reporting failed: ${e.message}`);
  }
}

async function runSchedule(env, ms) {
  if (String(env.SCHEDULE || 'on').toLowerCase() !== 'on') {
    console.log('Schedule is switched off (wrangler.toml SCHEDULE).');
    return;
  }
  const uk = ukNow(ms);
  for (const s of SLOTS.filter((x) => x.dow === uk.dow && x.hm === uk.hm)) {
    const payload = s.payload(uk.date);
    const ok = await dispatch(env, s.event, payload, 3);
    console.log(`${uk.dow} ${uk.hm} UK: ${s.event} ${JSON.stringify(payload)} ${ok ? 'dispatched' : 'FAILED'}`);
    if (!ok) {
      await alertDispatchFailed(env,
        `Scheduled ${s.event}${payload.action ? ` (${payload.action})` : ''} at ${uk.hm} UK could not be sent to GitHub`);
    }
  }
}

// Nightly site rebuild. Two UTC slots cover BST and GMT; only the one landing on
// 00:10 UK fires. The build itself works out "today" in UK time (.eleventy.js).
async function runNightly(env, ms) {
  if (String(env.NIGHTLY || 'on').toLowerCase() !== 'on') {
    console.log('Nightly rebuild is switched off (wrangler.toml NIGHTLY).');
    return;
  }
  const uk = ukNow(ms);
  if (uk.hm !== NIGHTLY_HM) return;
  const ok = await dispatch(env, 'rebuild', { date: uk.date }, 3);
  console.log(`${uk.date} ${uk.hm} UK: nightly rebuild ${ok ? 'dispatched' : 'FAILED'}`);
  if (!ok) await alertDispatchFailed(env, `Nightly site rebuild at ${uk.hm} UK could not be sent to GitHub`);
}

// Ingestion at :17 past the even UK hours 06-22. ingest.yml treats the dispatch like a
// scheduled run (RSS only on its feed hours). A late GitHub cron run as well is harmless:
// the concurrency group queues it and the Log tab stops anything being processed twice.
async function runIngest(env, ms) {
  if (String(env.INGEST || 'on').toLowerCase() !== 'on') {
    console.log('Worker-fired ingestion is switched off (wrangler.toml INGEST).');
    return;
  }
  const uk = ukNow(ms);
  if (!INGEST_HOURS.includes(uk.hour)) return;
  const ok = await dispatch(env, 'ingest', { date: uk.date, hm: uk.hm }, 3);
  console.log(`${uk.date} ${uk.hm} UK: ingest ${ok ? 'dispatched' : 'FAILED'}`);
  if (!ok) await alertDispatchFailed(env, `Ingestion run at ${uk.hm} UK could not be sent to GitHub`);
}

/* ------------------------------------------------------------- watchdog -- */

// Latest run of a workflow for one trigger event, or null.
async function latestRun(env, workflow, event) {
  const r = await github(env, `/repos/${env.REPO}/actions/workflows/${workflow}/runs?event=${event}&per_page=1`);
  if (!r.ok) throw new Error(`GitHub API returned HTTP ${r.status} when checking ${workflow} ${event} runs (token revoked or expired?)`);
  return ((await r.json()).workflow_runs || [])[0] || null;
}

// Counts both Worker-fired (repository_dispatch) and GitHub-cron (schedule) runs;
// manual runs don't count, so a forgotten schedule can't hide behind testing.
async function checkIngestion(env, problems) {
  try {
    const runs = (await Promise.all([
      latestRun(env, 'ingest.yml', 'repository_dispatch'),
      latestRun(env, 'ingest.yml', 'schedule'),
    ])).filter(Boolean);
    const newest = runs.length ? Math.max(...runs.map((x) => Date.parse(x.created_at))) : 0;
    const hours = newest ? (Date.now() - newest) / 3600000 : Infinity;
    if (hours > INGEST_STALE_HOURS) {
      problems.push(newest
        ? `No automatic ingestion run for ${Math.floor(hours)} hours (Worker dispatch and GitHub schedule both quiet)`
        : 'No automatic ingestion run found at all');
    }
  } catch (e) {
    problems.push(`Ingestion check failed: ${e.message}`);
  }
}

// Thursdays from 07:30 UK: a newsletter.yml run has started today. Catches a schedule
// that never wakes (8 Oct 2026: wrong cron day numbers, so nothing ran and nothing
// alerted). A manual build counts too, so the alert clears once the issue is built by
// hand. Skipped when the Wed/Thu schedule is switched off. Off Thursdays it never
// reports, so an open alert closes itself at the first check on Friday.
async function checkNewsletterBuild(env, problems) {
  if (String(env.SCHEDULE || 'on').toLowerCase() !== 'on') return;
  const uk = ukNow(Date.now());
  if (uk.dow !== 'Thu' || uk.hm < NEWSLETTER_DUE_HM) return;
  try {
    const runs = (await Promise.all([
      latestRun(env, 'newsletter.yml', 'repository_dispatch'),
      latestRun(env, 'newsletter.yml', 'workflow_dispatch'),
    ])).filter(Boolean);
    const startedToday = runs.some((r) => {
      const t = ukNow(Date.parse(r.created_at));
      return t.date === uk.date && t.hm >= '06:00';
    });
    if (!startedToday) {
      problems.push(`No newsletter build has started today (${uk.date}); the 06:30 UK build was not dispatched. Run "Newsletter build and send" by hand (build).`);
    }
  } catch (e) {
    problems.push(`Newsletter build check failed: ${e.message}`);
  }
}

// Tolerates diagnostic.yml not existing yet (404 = not deployed, no alert), and a
// newly added workflow with no scheduled run yet (measured from its creation time).
async function checkDiagnostic(env, problems) {
  try {
    const w = await github(env, `/repos/${env.REPO}/actions/workflows/diagnostic.yml`);
    if (w.status === 404) {
      console.log('Diagnostic workflow not yet deployed; skipping check.');
      return;
    }
    if (!w.ok) {
      problems.push(`GitHub API returned HTTP ${w.status} when checking the diagnostic workflow`);
      return;
    }
    const wf = await w.json();
    const r = await github(env, `/repos/${env.REPO}/actions/workflows/diagnostic.yml/runs?event=schedule&per_page=1`);
    if (!r.ok) {
      problems.push(`GitHub API returned HTTP ${r.status} when checking diagnostic runs`);
      return;
    }
    const run = ((await r.json()).workflow_runs || [])[0];
    const since = Date.parse(run ? run.created_at : wf.created_at);
    const hours = (Date.now() - since) / 3600000;
    if (hours > DIAGNOSTIC_STALE_HOURS) {
      problems.push(run
        ? `No scheduled diagnostic run for ${Math.floor(hours)} hours (GitHub may have paused the schedule)`
        : `Diagnostic workflow added ${Math.floor(hours)} hours ago but has never run on schedule`);
    }
  } catch (e) {
    problems.push(`Diagnostic check failed: ${e.message}`);
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
  await Promise.all([
    checkIngestion(env, problems), checkDiagnostic(env, problems),
    checkSite(env, problems), checkNewsletterBuild(env, problems),
  ]);
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
    if (url.pathname === '/u') return handleUnsubscribe(request, env);
    return new Response('Lenches approvals', { headers: { 'content-type': 'text/plain' } });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === SCHEDULE_CRON) ctx.waitUntil(runSchedule(env, event.scheduledTime));
    else if (event.cron === NIGHTLY_CRON) ctx.waitUntil(runNightly(env, event.scheduledTime));
    else if (event.cron === INGEST_CRON) ctx.waitUntil(runIngest(env, event.scheduledTime));
    else ctx.waitUntil(watchdog(env));
  },
};
