// scripts/diagnostic/index.js
// Daily diagnostic (step 7). Checks the pipeline end to end, applies a few safe
// fixes once only, and records one row per run in the Health tab.
//
// Never touches code, workflow files, subscriber sends or reply resends.
// Alerts by failing the job (GitHub emails Jon), only when a problem is new
// compared with the previous Health row. Details go to $GITHUB_STEP_SUMMARY.
//
// Tokens: GITHUB_TOKEN (actions: write) for runs, re-runs, job logs, re-enabling;
// DISPATCH_TOKEN (checked for validity; opens issues; keep-alive commit).
'use strict';

const fs = require('fs');
const tls = require('tls');
const dns = require('dns').promises;
const { google } = require('googleapis');
const g = require('../ingest/google');

const REPO = process.env.GITHUB_REPOSITORY || 'JonF61/thelenches-site';
const SITE_HOST = process.env.SITE_HOST || 'thelenches.org.uk';
const WORKER_URL = (process.env.WORKER_URL || 'https://approvals.lenches.workers.dev').replace(/\/+$/, '');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const DKIM_SELECTOR = process.env.DKIM_SELECTOR || 'google';
const GMAIL_LABEL = process.env.GMAIL_LABEL || 'Pipeline';
const TZ = 'Europe/London';

const DAY = 86400000;
const CERT_WARN_DAYS = 14;
const PENDING_STALE_DAYS = 8;
const KEEPALIVE_DAYS = 50;           // GitHub pauses cron after 60 days without activity
const LOG_MAX_RETRIES = 3;           // matches ingest MAX_RETRIES

const EXCLUDE = ['watchdog-alert.yml', 'diagnostic.yml'];
const RERUNNABLE = ['ingest.yml', 'publish.yml', 'build.yml', 'deploy-worker.yml', 'approval.yml'];
const FAILED = ['failure', 'timed_out', 'startup_failure'];

const problems = [];   // stable strings: compared with the previous Health row
const fixes = [];      // "requeued <id>" etc.; also the once-only record
const notes = [];      // details, varying numbers, error text
const stats = {};
const issueCandidates = [];

/* -------------------------------------------------------------- helpers -- */

const clip = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
const redact = (s) => String(s || '').replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[email]');
const errText = (e) => {
  const d = e && e.response && e.response.data;
  return clip((d && (d.error_description || (d.error && d.error.message) || d.error)) || (e && e.message) || e, 200);
};

function problem(text, detail) {
  if (!problems.includes(text)) problems.push(text);
  if (detail) notes.push(`${text}: ${clip(redact(detail), 200)}`);
}

function londonStamp(ms) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${d} ${t}`;
}
const today = londonStamp(Date.now()).slice(0, 10);

// Runs a check; an unexpected crash is recorded as a stable problem, never thrown.
async function safe(name, fn) {
  try {
    await fn();
  } catch (e) {
    problem(`${name}: check crashed`, errText(e));
    console.error(`${name}:`, e && e.stack ? e.stack : e);
  }
}

function gh(path, { token = process.env.GITHUB_TOKEN, method = 'GET', body } = {}) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lenches-diagnostic',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function ghJson(path, opts = {}) {
  const r = await gh(path, opts);
  if (!r.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${path}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

let gmailClient;
function gmail() {
  if (!gmailClient) {
    const key = JSON.parse(process.env.GOOGLE_SA_KEY || '{}');
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      subject: process.env.GMAIL_USER,
    });
    gmailClient = google.gmail({ version: 'v1', auth });
  }
  return gmailClient;
}

/* ------------------------------------------------------------ workflows -- */

async function logExcerpt(run) {
  try {
    const { jobs } = await ghJson(`/repos/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
    const job = (jobs || []).find((j) => FAILED.includes(j.conclusion)) || (jobs || [])[0];
    if (!job) return '(no jobs found)';
    const r = await gh(`/repos/${REPO}/actions/jobs/${job.id}/logs`);
    if (!r.ok) return `(log unavailable: HTTP ${r.status})`;
    const lines = (await r.text()).split('\n')
      .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').trimEnd())
      .filter(Boolean);
    return redact(lines.slice(-40).join('\n')).replace(/```/g, "'''");
  } catch (e) {
    return `(log unavailable: ${errText(e)})`;
  }
}

function workflowProblem(file, reason, run) {
  const text = `${file}: ${reason}`;
  problem(text, `run #${run.run_number} ${run.html_url}`);
  issueCandidates.push({ file, reason, run, text });
}

async function checkWorkflows() {
  const since = Date.now() - DAY;
  const { workflows } = await ghJson(`/repos/${REPO}/actions/workflows?per_page=100`);
  let total = 0;
  let failed = 0;

  for (const wf of workflows || []) {
    const file = wf.path.split('/').pop();
    if (EXCLUDE.includes(file)) continue;

    if (wf.state === 'disabled_inactivity') {
      const r = await gh(`/repos/${REPO}/actions/workflows/${wf.id}/enable`, { method: 'PUT' });
      if (r.status === 204) fixes.push(`re-enabled ${file} (paused by GitHub)`);
      else problem(`${file}: paused by GitHub and re-enable failed`, `HTTP ${r.status}`);
      continue;
    }
    if (wf.state !== 'active') {
      notes.push(`${file} is ${wf.state}`);
      continue;
    }
    // Keep-alive: harmless on an active workflow.
    await gh(`/repos/${REPO}/actions/workflows/${wf.id}/enable`, { method: 'PUT' });

    const { workflow_runs: runs = [] } = await ghJson(
      `/repos/${REPO}/actions/workflows/${wf.id}/runs?status=completed&per_page=10`
    );
    const recent = runs.filter((r) => Date.parse(r.updated_at) >= since);
    total += recent.length;
    failed += recent.filter((r) => FAILED.includes(r.conclusion)).length;

    const considered = runs.filter((r) => !['cancelled', 'skipped'].includes(r.conclusion));
    const latest = considered[0];
    if (!latest || !FAILED.includes(latest.conclusion) || Date.parse(latest.updated_at) < since) continue;

    const last3 = considered.slice(0, 3);
    if (last3.length === 3 && last3.every((r) => FAILED.includes(r.conclusion))) {
      workflowProblem(file, 'last 3 runs failed', latest);
    } else if (latest.run_attempt > 1) {
      workflowProblem(file, 'still failing after a re-run', latest);
    } else if (!RERUNNABLE.includes(file)) {
      workflowProblem(file, 'latest run failed', latest);
    } else {
      const r = await gh(`/repos/${REPO}/actions/runs/${latest.id}/rerun-failed-jobs`, { method: 'POST' });
      if (r.status === 201) fixes.push(`re-ran ${file} run #${latest.run_number}`);
      else workflowProblem(file, 'latest run failed and re-run was refused', latest);
    }
  }
  stats.runs = `${total} runs/24h, ${failed} failed`;
}

/* --------------------------------------------------------------- Google -- */

async function checkGmail() {
  try {
    const res = await gmail().users.labels.list({ userId: 'me' });
    const found = (res.data.labels || []).some((l) => l.name.toLowerCase() === GMAIL_LABEL.toLowerCase());
    if (!found) problem(`Gmail: label "${GMAIL_LABEL}" missing`);
  } catch (e) {
    problem('Gmail: access failed (auth or delegation)', errText(e));
  }
}

async function checkSheets(ctx) {
  try {
    ctx.settings = (await g.readSettings()).settings;
    ctx.sheetsOk = true;
  } catch (e) {
    problem('Google Sheets: access failed', errText(e));
  }
}

/* --------------------------------------------------------------- Claude -- */

async function claudeOnce() {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  });
  return { status: r.status, body: await r.text() };
}

async function checkClaude() {
  let res = await claudeOnce();
  if (res.status >= 500) {
    await new Promise((ok) => setTimeout(ok, 15000));
    res = await claudeOnce();
  }
  if (res.status === 200) return;
  if (res.status === 401 || res.status === 403) problem('Claude API: key rejected', res.body);
  else if (res.status === 400 && /credit|billing|balance/i.test(res.body)) problem('Claude API: out of credit (billing)', res.body);
  else if (res.status >= 500) notes.push(`Claude API temporarily unavailable (HTTP ${res.status}); not alerted`);
  else problem(`Claude API: HTTP ${res.status}`, res.body);
}

/* ------------------------------------------------------- Worker, site, DNS -- */

async function checkWorker() {
  try {
    const r = await fetch(`${WORKER_URL}/`);
    const text = await r.text();
    if (!r.ok || !text.includes('Lenches approvals')) problem('Approvals Worker: not responding correctly', `HTTP ${r.status}`);
  } catch (e) {
    problem('Approvals Worker: unreachable', errText(e));
  }
}

function certExpiry(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const cert = s.getPeerCertificate();
      s.end();
      resolve(Date.parse(cert.valid_to));
    });
    s.on('error', reject);
    s.on('timeout', () => s.destroy(new Error('TLS timeout')));
  });
}

async function checkHttps() {
  for (const host of [SITE_HOST, `www.${SITE_HOST}`]) {
    try {
      const days = Math.floor((await certExpiry(host) - Date.now()) / DAY);
      if (host === SITE_HOST) stats.cert = `cert ${days}d`;
      if (days < CERT_WARN_DAYS) problem(`TLS: certificate for ${host} expires within ${CERT_WARN_DAYS} days`, `${days} days left`);
    } catch (e) {
      problem(`TLS: certificate for ${host} invalid or unreachable`, errText(e));
    }
  }
  try {
    const r = await fetch(`http://${SITE_HOST}/`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    if (![301, 308].includes(r.status) || !loc.startsWith('https://')) {
      problem('HTTPS: http:// does not redirect to https://', `HTTP ${r.status} ${loc}`);
    }
  } catch (e) {
    problem('HTTPS: http:// check failed', errText(e));
  }
}

async function txt(name) {
  try {
    return (await dns.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

async function checkDns() {
  const [root, dmarc, dkim] = await Promise.all([
    txt(SITE_HOST), txt(`_dmarc.${SITE_HOST}`), txt(`${DKIM_SELECTOR}._domainkey.${SITE_HOST}`),
  ]);
  if (!root.some((t) => /^v=spf1\b/i.test(t))) problem('DNS: SPF record missing');
  if (!dmarc.some((t) => /^v=DMARC1\b/i.test(t))) problem('DNS: DMARC record missing');
  if (!dkim.some((t) => /v=DKIM1|k=rsa|p=/i.test(t))) problem(`DNS: DKIM record (${DKIM_SELECTOR}) missing`);
}

/* ------------------------------------------------ DISPATCH_TOKEN, keep-alive -- */

async function checkDispatchAndKeepAlive() {
  const token = process.env.DISPATCH_TOKEN;
  const r = await gh(`/repos/${REPO}`, { token });
  if (!r.ok) {
    problem('DISPATCH_TOKEN: rejected by GitHub (approvals and watchdog will fail)', `HTTP ${r.status}`);
    return;
  }
  const repo = await r.json();
  const idle = Math.floor((Date.now() - Date.parse(repo.pushed_at)) / DAY);
  if (idle < KEEPALIVE_DAYS) return;

  try {
    const branch = repo.default_branch || 'main';
    const ref = await ghJson(`/repos/${REPO}/git/ref/heads/${branch}`, { token });
    const head = await ghJson(`/repos/${REPO}/git/commits/${ref.object.sha}`, { token });
    const commit = await ghJson(`/repos/${REPO}/git/commits`, {
      token, method: 'POST',
      body: { message: 'Keep-alive (daily diagnostic)', tree: head.tree.sha, parents: [head.sha] },
    });
    await ghJson(`/repos/${REPO}/git/refs/heads/${branch}`, { token, method: 'PATCH', body: { sha: commit.sha } });
    fixes.push(`keep-alive commit (${idle} days since last push)`);
  } catch (e) {
    problem('Keep-alive commit failed', errText(e));
  }
}

/* -------------------------------------------------------- Sheet-based -- */

async function checkLog(pastFixes) {
  const rows = await g.readTable('Log');
  for (const r of rows) {
    if (r.status !== 'error' || (Number(r.retries) || 0) < LOG_MAX_RETRIES) continue;
    const key = `requeued ${r.message_id}`;
    if (pastFixes.includes(key)) {
      problem(`Log: message ${r.message_id} still failing after requeue`, r.error);
      continue;
    }
    await g.updateRow('Log', r._row, {
      retries: LOG_MAX_RETRIES - 1,
      error: clip(`${r.error} [requeued by diagnostic ${today}]`, 500),
    });
    fixes.push(key);
  }
}

async function checkReplies() {
  const rows = await g.readTable('Replies');
  const failed = rows.filter((r) => r.status === 'failed').map((r) => r.reply_id).sort();
  if (failed.length) problem(`Replies failed (not resent): ${failed.join(', ')}`);
}

async function countStalePending() {
  const rows = await g.readTable('Pending');
  const cutoff = Date.now() - PENDING_STALE_DAYS * DAY;
  const n = rows.filter((r) => {
    if (r.status !== 'pending') return false;
    const t = Date.parse(`${String(r.received).trim().replace(' ', 'T')}:00Z`);
    return Number.isFinite(t) && t < cutoff;
  }).length;
  stats.pending = `${n} pending >${PENDING_STALE_DAYS}d`;
}

// Dormant until step 5b: only acts on addresses in the Subscribers tab.
async function checkBounces() {
  const list = await gmail().users.messages.list({
    userId: 'me', q: 'from:mailer-daemon newer_than:2d', maxResults: 50,
  });
  const msgs = list.data.messages || [];
  if (!msgs.length) return;

  const subs = await g.readTable('Subscribers');
  const dns_ = await g.readTable('Do Not Send');
  const emailKey = (rows) => Object.keys(rows[0] || {}).find((k) => /e-?mail/i.test(k));
  const subKey = emailKey(subs);
  const dnsHeaders = Object.keys(dns_[0] || {});
  const dnsKey = emailKey(dns_);
  if (!subKey) return;
  const subscribed = new Set(subs.map((r) => String(r[subKey]).trim().toLowerCase()).filter(Boolean));
  const blocked = new Set(dnsKey ? dns_.map((r) => String(r[dnsKey]).trim().toLowerCase()) : []);

  let bounces = 0;
  for (const m of msgs) {
    const res = await gmail().users.messages.get({
      userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['X-Failed-Recipients'],
    });
    const hdr = ((res.data.payload && res.data.payload.headers) || [])
      .find((h) => h.name.toLowerCase() === 'x-failed-recipients');
    if (!hdr) continue;
    const snippet = res.data.snippet || '';
    const hard = /\b5\.\d\.\d+\b|address not found|does not exist|user unknown|no such user/i.test(snippet)
      && !/temporar|delay|will retry|4\.\d\.\d+/i.test(snippet);
    for (const addr of hdr.value.split(',').map((a) => g.addressOf(a)).filter(Boolean)) {
      if (!subscribed.has(addr)) continue;
      bounces += 1;
      if (!hard || blocked.has(addr)) continue;
      if (!dnsKey) {
        problem('Do Not Send tab: no email column found; hard bounce not recorded');
        continue;
      }
      const row = { [dnsKey]: addr };
      dnsHeaders.forEach((h) => {
        if (/reason/i.test(h)) row[h] = 'Hard bounce (daily diagnostic)';
        else if (/date|added/i.test(h)) row[h] = today;
        else if (/source/i.test(h)) row[h] = 'diagnostic';
      });
      await g.appendRows('Do Not Send', [row]);
      blocked.add(addr);
      fixes.push(`Do Not Send: added a hard-bounced subscriber`);
    }
  }
  if (bounces) stats.bounces = `${bounces} subscriber bounce(s)/2d`;
}

/* --------------------------------------------------------------- issues -- */

async function openIssues(newProblems) {
  const token = process.env.DISPATCH_TOKEN;
  const cands = issueCandidates.filter((c) => newProblems.includes(c.text));
  if (!cands.length) return;
  const open = await ghJson(`/repos/${REPO}/issues?state=open&per_page=100`, { token });
  for (const c of cands) {
    const title = `Diagnostic: ${c.file} failing`;
    if ((open || []).some((i) => i.title === title && !i.pull_request)) continue;
    const excerpt = await logExcerpt(c.run);
    const body = [
      `The daily diagnostic found **${c.file}: ${c.reason}** (${today}).`,
      '',
      `Run: ${c.run.html_url}`,
      '',
      'Log excerpt (last 40 lines of the failed job, email addresses redacted):',
      '```text',
      excerpt,
      '```',
      '',
      'Starter prompt for a new chat:',
      '```text',
      `Lenches pipeline: ${c.file} is failing (${c.reason}). Read Project_Plan (HOW I WORK), then the GitHub issue "${title}" in JonF61/thelenches-site for the run link and log excerpt. Read the failing script, diagnose, and show me the proposed fix before committing.`,
      '```',
      '',
      'The diagnostic never changes code. Close this issue once fixed.',
    ].join('\n');
    const r = await gh(`/repos/${REPO}/issues`, { token, method: 'POST', body: { title, body } });
    if (r.ok) notes.push(`opened issue "${title}"`);
    else notes.push(`opening issue "${title}" failed: HTTP ${r.status}`);
  }
}

/* ----------------------------------------------------------------- main -- */

function writeSummary(row, newProblems) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');
  const md = [
    `## Daily diagnostic ${row.date}: ${row.status}`,
    '',
    row.summary,
    '',
    '### Problems',
    list(problems.map((p) => (newProblems.includes(p) ? `**NEW** ${p}` : p))),
    '',
    '### Fixes applied',
    list(fixes),
    '',
    '### Notes',
    list(notes),
    '',
  ].join('\n');
  console.log(md);
  if (file) fs.appendFileSync(file, md);
}

async function main() {
  const ctx = {};
  await checkSheets(ctx);

  let health = [];
  if (ctx.sheetsOk) {
    try {
      health = await g.readTable('Health');
    } catch (e) {
      problem('Health tab: unreadable', errText(e));
    }
  }
  const pastFixes = health.map((r) => r.fixes || '').join(' | ');
  const prev = health[health.length - 1];
  const prevProblems = new Set(String((prev && prev.problems) || '').split(' | ').filter(Boolean));

  await Promise.all([
    safe('Workflows', checkWorkflows),
    safe('Gmail', checkGmail),
    safe('Claude API', checkClaude),
    safe('Approvals Worker', checkWorker),
    safe('HTTPS', checkHttps),
    safe('DNS', checkDns),
    safe('DISPATCH_TOKEN', checkDispatchAndKeepAlive),
  ]);
  if (ctx.sheetsOk) {
    await safe('Log requeue', () => checkLog(pastFixes));
    await safe('Replies', checkReplies);
    await safe('Pending', countStalePending);
    await safe('Bounces', checkBounces);
  }

  const newProblems = problems.filter((p) => !prevProblems.has(p));
  await safe('Issues', () => openIssues(newProblems));

  const status = problems.length ? 'PROBLEMS' : (fixes.length ? 'FIXED' : 'OK');
  const summary = [
    status,
    problems.length ? `${problems.length} problem(s)` : '',
    fixes.length ? `${fixes.length} fix(es)` : '',
    stats.runs, stats.pending, stats.cert, stats.bounces,
  ].filter(Boolean).join(' · ');

  const row = {
    date: londonStamp(Date.now()),
    status,
    summary,
    problems: problems.join(' | '),
    fixes: fixes.join(' | '),
    notes: clip(notes.join(' | '), 1500),
  };

  let recorded = false;
  if (ctx.sheetsOk) {
    try {
      await g.appendRows('Health', [row]);
      recorded = true;
    } catch (e) {
      console.error(`Writing Health row failed: ${errText(e)}`);
    }
  }
  writeSummary(row, newProblems);

  // Fail (GitHub emails) only for new problems, or when the row couldn't be recorded
  // (without it, tomorrow can't tell new from old).
  if (newProblems.length || !recorded) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
