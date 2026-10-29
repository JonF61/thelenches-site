// worker/src/index.js
// Lenches approvals Worker.
//   GET  /a?t=TOKEN  confirm page only (link scanners just GET, so they can't act on anything)
//   POST /a          verifies the signed token, fires repository_dispatch
//   GET  /u?t=TOKEN  unsubscribe confirm page (people clicking the footer link)
//   POST /u?t=TOKEN  one-click unsubscribe (RFC 8058: mail providers POST here) or the
//                    confirm page's button; fires repository_dispatch "unsubscribe"
//   POST /f          reader feedback form (feedback.js): Turnstile, rate limit, validation,
//                    then a Feedback tab row.
//   POST /s          newsletter sign-up form (signup.js): as /f, then a Sign-ups row and
//                    repository_dispatch "signup" (send), which emails a confirmation link
//   GET  /s?t=TOKEN  sign-up confirm page (a button: link scanners only GET)
//   POST /s?t=TOKEN  the button; fires repository_dispatch "signup" (confirm)
//   GET  /c?t=TOKEN  a link in a sent newsletter: one anonymous click counted, then 302 on
//   GET  /o?i=DATE   the newsletter's 1x1 image: one anonymous open counted (track.js)
//                    Public: Cloudflare Access must never cover /a, /u, /f, /s, /c or /o
//                    (readers and mail providers have no Access login).
//   /admin, /admin/*  admin panel (admin/index.js): Cloudflare Access only, decisions go
//                    through the same decide() as POST /a (core.js)
//   cron WATCHDOG_CRON  ingestion and daily diagnostic still running, site up, and on
//                       Thursdays from 07:30 UK that the newsletter build has started;
//                       alerts via GitHub
//   cron SCHEDULE_CRON  UK-time schedule: Wed 18:30 digest; Thu 06:30 newsletter build,
//                       08:00 auto-send (does nothing unless holiday mode + live), 12:00
//                       and 17:00 reminders. A failed dispatch raises a watchdog alert.
//   cron NIGHTLY_CRON   00:10 UK every night: fires repository_dispatch "rebuild" so
//                       build.yml rebuilds the site and yesterday's events drop off.
//   cron HOURLY_CRON    :17 past even UK hours 06-22: fires repository_dispatch "ingest"
//                       (GitHub's own cron ran hours late; it stays in ingest.yml as a backup).
//                       07:00 UK every day: fires "daily-approvals" (daily approvals email).
//                       One cron string for both keeps the Worker within Cloudflare's
//                       5-cron-per-account free limit.
// Actions: approve/reject (Pending items), approve_own/approve_rewrite (approve with the
// submitter's own wording or our rewrite), trust (add the item's sender or feed to the
// Trusted tab and approve that item), send/skip (the Approve and Reject buttons for replies;
// Reject's page takes an optional reason), edit (a form showing the reply draft carried in
// the signed link; the edited text is sent on to GitHub as client_payload.body), redraft (a
// page asking what to change, required, sent on as client_payload.reason), close ("Close,
// no reply needed" for an email still owed a reply), nlsend/nlbuild
// (newsletter Send and Rebuild buttons). Single use and every send safeguard are enforced
// downstream: the Worker only passes signed requests on to GitHub.
// The Rebuild button's build carries rebuild: true, which lifts the Wednesday 18:00
// deadline cutoff (the scheduled 06:30 build keeps it).

import { handleClick, handleOpen } from './track.js';
import {
  ACTIONS, PANEL_ONLY, validPayload, github, dispatch, decide, cleanReason, cleanBody,
} from './core.js';
import { handleAdmin } from './admin/index.js';
import { handleFeedback } from './feedback.js';
import { handleSignup } from './signup.js';

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
// Minutes only, every hour and day ("*"): never day numbers here.
const HOURLY_CRON = '0,17 * * * *';
const INGEST_MINUTE = '17';
const DAILY_HM = '07:00';            // UK time, every day: daily approvals email
const INGEST_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22]; // UK hours, as ingest.yml's gate

// UK times. payload(date) gets the UK date (YYYY-MM-DD) of the slot.
const SLOTS = [
  { dow: 'Wed', hm: '18:30', event: 'digest', payload: () => ({}) },
  { dow: 'Thu', hm: '06:30', event: 'newsletter', payload: (d) => ({ action: 'build', issue_date: d }) },
  { dow: 'Thu', hm: '08:00', event: 'newsletter', payload: (d) => ({ action: 'autosend', issue_date: d }) },
  { dow: 'Thu', hm: '12:00', event: 'newsletter', payload: (d) => ({ action: 'remind', issue_date: d }) },
  { dow: 'Thu', hm: '17:00', event: 'newsletter', payload: (d) => ({ action: 'remind', issue_date: d }) },
];

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




/* ------------------------------------------------------------ approvals -- */

function confirmExtra(p) {
  if (p.a === 'trust') {
    const what = /^https?:/i.test(p.k) ? 'the feed' : 'the email address';
    return `<p>This trusts ${what} <strong>${esc(p.k)}</strong> and approves this item.</p>`
      + '<p class="muted">Future items from it are published without asking, except anything with people in images, political or commercial content, official notices, anonymous or out-of-scope mail, classified ads or low confidence. Its other items already waiting are not approved. To undo, delete its row in the Trusted tab.</p>';
  }
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
  if (p.a === 'edit') return 'Recorded. Your text goes out within a few minutes, unless the reply had already been sent or rejected.';
  if (p.a === 'redraft') return 'Recorded. Holly writes a new draft and emails you a fresh card within a few minutes; the old draft is closed. If the reply had already been sent or closed, nothing changes.';
  if (p.a === 'close') return 'Recorded. This email no longer appears under "Still owed a reply", and any draft still waiting is closed. Nothing is sent.';
  if (p.a === 'trust') return `Recorded. ${p.k} is added to the Trusted tab (once) and this item is approved if it was still waiting.`;
  return 'Recorded. If this had already been decided, nothing changes.';
}

async function handleApproval(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const token = url.searchParams.get('t');
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p || p.a === 'unsub' || p.a === 'signup' || PANEL_ONLY.includes(p.a)) return invalidPage();
    if (p.expired) return expiredPage();
    const [verb, , cls] = ACTIONS[p.a];
    return page(verb, `
<h1>${esc(verb)}?</h1>
<p><strong>${esc(p.t || p.i)}</strong></p>
${confirmExtra(p)}
<form method="post" action="/a">
  <input type="hidden" name="t" value="${esc(token)}">
  ${p.a === 'edit' ? `<p><label for="body">Change the reply below, then press the button. It is sent exactly as it stands.</label><br><textarea id="body" name="body" rows="16" maxlength="3000" style="width:100%;max-width:560px;padding:8px;font-size:16px;font-family:Arial,Helvetica,sans-serif;line-height:1.4;">${esc(p.b)}</textarea></p>
  <p><label for="reason">Why did you change it? (optional, kept in the Reply feedback tab, never sent)</label><br><input id="reason" name="reason" type="text" maxlength="300" style="width:100%;max-width:560px;padding:8px;font-size:16px;"></p>` : ''}
  ${p.a === 'redraft' && typeof p.b === 'string' && p.b ? `<p>The draft now:</p><div style="white-space:pre-wrap;max-width:560px;padding:8px 12px;border-left:4px solid #4A5D73;background:#F6F1E4;font-size:15px;line-height:1.4;">${esc(p.b)}</div>` : ''}
  ${p.a === 'redraft' ? '<p><label for="reason">What should Holly change? (required; kept in the Reply feedback tab, never sent)</label><br><textarea id="reason" name="reason" rows="5" maxlength="500" required style="width:100%;max-width:560px;padding:8px;font-size:16px;font-family:Arial,Helvetica,sans-serif;line-height:1.4;"></textarea></p><p class="muted">Holly writes a new draft from their email, the old draft and this, and emails you a fresh card to approve.</p>' : ''}
  ${p.a === 'close' ? '<p>This stops the reminder for this email. Nothing is sent to them; any draft still waiting is closed.</p>' : ''}
  ${p.a === 'skip' ? '<p><label for="reason">Why? (optional, kept in the Reply feedback tab, never sent)</label><br><input id="reason" name="reason" type="text" maxlength="300" style="width:100%;max-width:420px;padding:8px;font-size:16px;"></p>' : ''}
  <button class="${cls}" type="submit">${esc(p.a === 'nlsend' ? (p.t || verb) : verb)}</button>
</form>
<p class="muted">${esc(p.i)}</p>`);
  }

  if (request.method === 'POST') {
    let token = '';
    let reason = '';
    let body = '';
    try {
      const form = await request.formData();
      token = form.get('t');
      reason = form.get('reason');
      body = cleanBody(form.get('body'));
    } catch {
      return invalidPage();
    }
    const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
    if (!p || p.a === 'unsub' || p.a === 'signup' || PANEL_ONLY.includes(p.a)) return invalidPage();
    if (p.expired) return expiredPage();
    reason = cleanReason(reason, p.a === 'redraft' ? 500 : 300);
    if (p.a === 'redraft' && reason.length < 3) return page('Nothing to change', '<h1>Say what to change</h1><p>The box was empty. Go back and type what Holly should change.</p>', 400);

    if (p.a === 'edit' && body.length < 10) return page('Nothing to send', '<h1>Nothing to send</h1><p>The reply text was empty. Go back and try again.</p>', 400);
    if (!(await decide(env, p, reason, body))) return failedPage();
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

/* --------------------------------------------------- sign-up confirmation -- */

// The link in the confirmation email (scripts/signup). GET shows a button, so a mail
// scanner opening the link confirms nothing; the button's POST fires the subscribe run.
async function handleSignupConfirm(request, env) {
  const url = new URL(request.url);
  const site = esc(String(env.SITE_URL || 'https://thelenches.org.uk/'));
  const expired = () => page('Link expired',
    `<h1>Link expired</h1><p>This confirmation link has expired. You can sign up again using the form on <a href="${site}">the website</a>.</p>`, 410);
  let token = url.searchParams.get('t');
  if (request.method === 'POST' && !token) {
    try { token = (await request.formData()).get('t'); } catch { token = ''; }
  }
  const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
  if (!p || (!p.expired && p.a !== 'signup')) return invalidPage();
  if (p.expired) return expired();

  if (request.method === 'GET') {
    return page('Confirm your sign-up', `
<h1>Join The Lenches Newsletter?</h1>
<p>It's free and comes out every Thursday morning.</p>
<form method="post" action="/s?t=${esc(token)}">
  <button class="approve" type="submit">Yes, add me to the list</button>
</form>`);
  }
  if (request.method === 'POST') {
    if (!(await dispatch(env, 'signup', { action: 'confirm', id: p.i }, 2))) return failedPage();
    return page('You\'re on the list', `
<h1>You're on the list</h1>
<p>The next newsletter will arrive on Thursday morning. There's an unsubscribe link at the bottom of every issue.</p>
<p><a href="${site}">Back to the website</a></p>`);
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

// Daily approvals email at 07:00 UK every day (scripts/digest, DIGEST_MODE=daily).
async function runDaily(env, ms) {
  const uk = ukNow(ms);
  if (uk.hm !== DAILY_HM) return;
  if (String(env.DAILY || 'on').toLowerCase() !== 'on') {
    console.log('Daily approvals email is switched off (wrangler.toml DAILY).');
    return;
  }
  const ok = await dispatch(env, 'daily-approvals', { date: uk.date }, 3);
  console.log(`${uk.date} ${uk.hm} UK: daily approvals ${ok ? 'dispatched' : 'FAILED'}`);
  if (!ok) await alertDispatchFailed(env, `Daily approvals email at ${uk.hm} UK could not be sent to GitHub`);
}

// Ingestion at :17 past the even UK hours 06-22. ingest.yml treats the dispatch like a
// scheduled run (RSS only on its feed hours). A late GitHub cron run as well is harmless:
// the concurrency group queues it and the Log tab stops anything being processed twice.
async function runIngest(env, ms) {
  const uk = ukNow(ms);
  if (!uk.hm.endsWith(`:${INGEST_MINUTE}`)) return;
  if (String(env.INGEST || 'on').toLowerCase() !== 'on') {
    console.log('Worker-fired ingestion is switched off (wrangler.toml INGEST).');
    return;
  }
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
    if (url.pathname === '/f') return handleFeedback(request, env);
    // Anonymous newsletter counts (track.js): public, never behind Cloudflare Access.
    if (url.pathname === '/c') return handleClick(request, env);
    if (url.pathname === '/o') return handleOpen(request, env);
    if (url.pathname === '/s') {
      return url.searchParams.has('t') ? handleSignupConfirm(request, env) : handleSignup(request, env);
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(request, env);
    return new Response('Lenches approvals', { headers: { 'content-type': 'text/plain' } });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === SCHEDULE_CRON) ctx.waitUntil(runSchedule(env, event.scheduledTime));
    else if (event.cron === NIGHTLY_CRON) ctx.waitUntil(runNightly(env, event.scheduledTime));
    else if (event.cron === HOURLY_CRON) {
      ctx.waitUntil(runIngest(env, event.scheduledTime));
      ctx.waitUntil(runDaily(env, event.scheduledTime));
    }
    else ctx.waitUntil(watchdog(env));
  },
};
