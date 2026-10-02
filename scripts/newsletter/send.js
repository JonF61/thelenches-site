// scripts/newsletter/send.js
// Step 5b part 2: sends a built-and-tested issue, as set by Settings newsletter_mode:
//   off     refuses.
//   shadow  dry run: every pre-check, counts would-be recipients, records them on the
//           Issues row (the >10% baseline) and marks a tested issue "shadow". Sends nothing.
//   canary  real sends to Settings canary_to only (code-limited to CANARY_DOMAINS).
//           Sends rows use issue_id "<issue>:canary"; the issue's status is unchanged.
//   live    real sends to Subscribers minus Do Not Send. Only on/after LIVE_FROM (code).
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, ISSUE_DATE (required), CONFIRM_COUNT
// (canary/live: must equal the computed recipient count), RUN_ID (lock owner).
// Safeguards: re-render must match the tested hash; Send-mail-as guard and From re-check
// (message 1, then every 25th); Sends rows "sending" before and "sent" after each batch;
// a resume skips sent, marks leftover "sending" as stuck (never resent) and checks Sent;
// 1,500 per rolling 24h (Sends + Replies); abort if recipients drop >10% vs last issue.
'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const g = require('../ingest/google');
const { select } = require('./select');
const { render } = require('./render');

const TZ = 'Europe/London';
const ROOT = path.join(__dirname, '..', '..');
const SITE = 'https://thelenches.org.uk';
const FROM = 'website@thelenches.org.uk';
const LIVE_FROM = '2026-10-22';
const DAY_LIMIT = 1500;
const MAX_DROP = 0.10;
const BATCH = 10;
const GAP_MS = 1000;
const FROM_CHECK_EVERY = 25;
const MAX_CONSECUTIVE_FAILS = 5;
const TIME_BUDGET_MS = 50 * 60 * 1000; // workflow timeout is 60 min
const CANARY_DOMAINS = ['thelenches.org.uk', 'alphaquad.co.uk'];
const MODES = ['off', 'shadow', 'canary', 'live'];
const COUNTED = ['sent', 'shadow'];
const SENDS_HEADERS = ['issue_id', 'email', 'status', 'started_at', 'sent_at', 'gmail_id', 'run_id', 'notes'];
const ISSUES_HEADERS = ['issue_id', 'issue_date', 'status', 'content_hash', 'item_keys', 'image_keys',
  'subject', 'sent_at', 'recipients', 'notes', 'send_run', 'counts_applied_at'];
const PENDING_HEADERS = ['id', 'newsletter_count', 'flyer_count'];
// Lower case only (inputs are lower-cased first). No quotes: sendMail rejects them.
const ADDRESS_RE = /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 200);
const londonDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);

// "YYYY-MM-DD HH:MM:SS", UK time (the Sheet's other tabs use UK time too).
function stamp(ms = Date.now()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// Any Sheet timestamp (ISO UTC, or UK "YYYY-MM-DD HH:MM[:SS]") as UK "YYYY-MM-DD HH:MM", or ''.
function minuteKey(v) {
  const s = str(v);
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))) return stamp(Date.parse(s)).slice(0, 16);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : '';
}

const appendNote = (old, add) => [str(old), add].filter(Boolean).join('; ').slice(-500);

/* ------------------------------------------- same inputs as index.js -- */

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function jpegFor(webpUrl) {
  const rel = webpUrl.replace(/\.webp$/, '.jpg');
  return fs.existsSync(path.join(ROOT, 'src', rel)) ? `${SITE}${rel}` : '';
}

/* ------------------------------------------------------ Google helpers -- */

let sheetsClient;
let gmailReadClient;

function saKey() {
  return JSON.parse(process.env.GOOGLE_SA_KEY || '{}');
}

function sheets() {
  if (!sheetsClient) {
    const key = saKey();
    const auth = new google.auth.JWT({
      email: key.client_email, key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

// Read-only Gmail, used only to look for a message in Sent after a crash.
function gmailRead() {
  if (!gmailReadClient) {
    const key = saKey();
    const auth = new google.auth.JWT({
      email: key.client_email, key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      subject: process.env.GMAIL_USER,
    });
    gmailReadClient = google.gmail({ version: 'v1', auth });
  }
  return gmailReadClient;
}

function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function headersOf(tab) {
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: g.spreadsheetId(), range: `'${tab}'!1:1` });
  return ((res.data.values || [])[0] || []).map((h) => str(h));
}

// Many rows in ONE Sheets write. updates: [[rowNumber, { header: value }], ...].
// Setting values is idempotent, so a failed write is retried (up to 3 tries).
async function writeRows(tab, headers, updates) {
  const data = [];
  for (const [row, fields] of updates) {
    for (const [k, v] of Object.entries(fields)) {
      if (!headers.includes(k)) continue;
      data.push({ range: `'${tab}'!${colLetter(headers.indexOf(k))}${row}`, values: [[v ?? '']] });
    }
  }
  if (!data.length) return;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sheets().spreadsheets.values.batchUpdate({
        spreadsheetId: g.spreadsheetId(),
        requestBody: { valueInputOption: 'RAW', data },
      });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`Sheets write to ${tab} failed (${errMsg(err)}); retrying.`);
      await sleep(5000 * attempt);
    }
  }
}

// Gmail ID of a message in Sent to `email` with this exact subject (last 3 days), or ''.
async function findInSent(email, subject) {
  const after = Math.floor((Date.now() - 3 * 86400000) / 1000);
  const res = await gmailRead().users.messages.list({ userId: 'me', q: `in:sent to:${email} after:${after}`, maxResults: 10 });
  for (const m of res.data.messages || []) {
    const msg = await g.getMessage(m.id);
    if (msg.subject === subject) return m.id;
  }
  return '';
}

async function assertSendAs() {
  const allowed = await g.sendAsAddresses();
  if (!allowed.includes(FROM)) throw new Error(`${FROM} is not a "Send mail as" address on ${process.env.GMAIL_USER}`);
}

function isQuota(err) {
  const status = err && err.response && err.response.status;
  return status === 429 || /quota|rate ?limit|limit exceeded|too many/i.test(errMsg(err));
}

/* ---------------------------------------------------------- Recipients -- */

// Subscribers minus Do Not Send: lower-cased, trimmed, deduped, syntax-checked.
// If Subscribers has a status column, only blank or "active" rows count.
function buildRecipients(subscribers, dns, problems) {
  if (!subscribers.length) { problems.push('Subscribers tab is empty'); return { list: [], info: '' }; }
  if (!subscribers.some((r) => 'email' in r)) { problems.push('Subscribers has no "email" header'); return { list: [], info: '' }; }
  if (dns.length && !dns.some((r) => 'email' in r)) { problems.push('Do Not Send has no "email" header'); return { list: [], info: '' }; }
  const blocked = new Set(dns.map((r) => lc(r.email)).filter(Boolean));
  const seen = new Set();
  let invalid = 0;
  let inactive = 0;
  let onDns = 0;
  let dupes = 0;
  for (const r of subscribers) {
    const e = lc(r.email);
    if (!e) continue;
    if ('status' in r && str(r.status) && lc(r.status) !== 'active') { inactive += 1; continue; }
    if (!ADDRESS_RE.test(e)) { invalid += 1; console.warn(`Invalid address skipped: Subscribers row ${r._row}`); continue; }
    if (blocked.has(e)) { onDns += 1; continue; }
    if (seen.has(e)) { dupes += 1; continue; }
    seen.add(e);
  }
  const info = `${onDns} on Do Not Send, ${dupes} duplicate, ${invalid} invalid, ${inactive} not active`;
  return { list: [...seen].sort(), info };
}

function canaryList(value, problems) {
  const list = [...new Set(str(value).toLowerCase().split(/[\s,;]+/).filter(Boolean))];
  if (!list.length) problems.push('Settings canary_to is blank');
  for (const e of list) {
    const domain = e.split('@')[1] || '';
    if (!ADDRESS_RE.test(e) || !CANARY_DOMAINS.includes(domain)) {
      problems.push(`canary_to "${e}" is not allowed (only @${CANARY_DOMAINS.join(', @')})`);
    }
  }
  return list;
}

// Recipient count of the latest earlier issue that was sent or shadowed.
function baseline(issues, issueDate) {
  const prev = issues
    .filter((r) => str(r.issue_date).slice(0, 10) < issueDate && COUNTED.includes(lc(r.status)) && Number(r.recipients) > 0)
    .sort((x, y) => str(x.issue_date).localeCompare(str(y.issue_date)));
  const last = prev[prev.length - 1];
  return last ? { issue: str(last.issue_id), count: Number(last.recipients) } : null;
}

// Messages sent in the last 24h by the pipeline (Sends + Replies).
function usedLast24h(sends, replies) {
  const since = stamp(Date.now() - 86400000).slice(0, 16);
  const recent = (rows, statuses) => rows.filter((r) => statuses.includes(lc(r.status)) && minuteKey(r.sent_at || r.started_at) >= since).length;
  return recent(sends, ['sent', 'sending', 'stuck']) + recent(replies, ['sent', 'sending']);
}

/* ----------------------------------------------------- Pending counts -- */

// After a live send: Pending newsletter_count / flyer_count = the Issues tally
// (sent or shadow issues, this one included), never lowered. Runs once per issue.
async function applyCounts(issueDate) {
  const [issues, pending, pHeaders] = await Promise.all([g.readTable('Issues'), g.readTable('Pending'), headersOf('Pending')]);
  const row = issues.filter((r) => str(r.issue_id) === issueDate).pop();
  if (!row || lc(row.status) !== 'sent') throw new Error(`applyCounts: issue ${issueDate} is not sent`);
  if (str(row.counts_applied_at)) { console.log('Pending counts already applied.'); return; }
  const tally = (field) => {
    const map = new Map();
    for (const r of issues.filter((x) => COUNTED.includes(lc(x.status)))) {
      for (const k of new Set(str(r[field]).split(/\s+/).filter(Boolean))) map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };
  const shown = tally('item_keys');
  const imaged = tally('image_keys');
  const mine = new Set(str(row.item_keys).split(/\s+/).filter(Boolean));
  const mineImg = new Set(str(row.image_keys).split(/\s+/).filter(Boolean));
  const updates = [];
  for (const p of pending) {
    const k = `p:${str(p.id)}`;
    if (!str(p.id) || !mine.has(k)) continue;
    const fields = { newsletter_count: Math.max(Number(p.newsletter_count) || 0, shown.get(k) || 0) };
    if (mineImg.has(k)) fields.flyer_count = Math.max(Number(p.flyer_count) || 0, imaged.get(k) || 0);
    updates.push([p._row, fields]);
  }
  await writeRows('Pending', pHeaders, updates);
  await g.updateRow('Issues', row._row, { counts_applied_at: new Date().toISOString() });
  console.log(`Pending counts updated on ${updates.length} rows.`);
}

/* -------------------------------------------------------- Send loop -- */

async function sendAll({ key, targets, issue, fromName, runId, startedMs }) {
  const sHeaders = await headersOf('Sends');
  const target = new Set(targets);
  const mineOf = async () => (await g.readTable('Sends')).filter((r) => str(r.issue_id) === key);

  // 1. Resume: leftover "sending" rows (a crash mid-batch) become "stuck", never resent.
  let rows = await mineOf();
  const leftovers = rows.filter((r) => lc(r.status) === 'sending');
  if (leftovers.length) {
    const upd = [];
    for (const r of leftovers) {
      let note = 'stuck: was "sending" at resume; not resent';
      try {
        const id = await findInSent(lc(r.email), issue.subject);
        note += id ? `; found in Sent (${id})` : '; not found in Sent';
      } catch (err) { note += `; Sent check failed (${errMsg(err)})`; }
      upd.push([r._row, { status: 'stuck', notes: appendNote(r.notes, note) }]);
    }
    await writeRows('Sends', sHeaders, upd);
    console.warn(`${leftovers.length} row(s) marked stuck (see Sends notes).`);
  }

  // 2. Queue every target address that has no row yet, in one write.
  const have = new Set(rows.map((r) => lc(r.email)));
  const fresh = targets.filter((e) => !have.has(e));
  if (fresh.length) {
    await g.appendRows('Sends', fresh.map((email) => ({ issue_id: key, email, status: 'queued', run_id: runId })));
    console.log(`Queued ${fresh.length} new row(s).`);
  }
  rows = await mineOf();

  // 3. Queued rows whose address has since left the list are not sent.
  const gone = rows.filter((r) => lc(r.status) === 'queued' && !target.has(lc(r.email)));
  if (gone.length) {
    await writeRows('Sends', sHeaders, gone.map((r) => [r._row, { status: 'failed', notes: 'not sent: no longer a recipient' }]));
  }
  const queue = rows.filter((r) => lc(r.status) === 'queued' && target.has(lc(r.email))).sort((a, b) => a._row - b._row);
  console.log(`${queue.length} to send now (${rows.filter((r) => lc(r.status) === 'sent').length} already sent).`);

  // 4. Batches of 10: mark sending, send ~1/sec, record results.
  let sentThisRun = 0;
  let consecutive = [];
  let stop = '';
  let fromRewritten = '';
  for (let i = 0; i < queue.length && !stop; i += BATCH) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { stop = 'time budget reached'; break; }
    const batch = queue.slice(i, i + BATCH);
    await writeRows('Sends', sHeaders, batch.map((r) => [r._row, { status: 'sending', started_at: stamp(), run_id: runId }]));
    const results = [];
    for (const r of batch) {
      if (stop) { results.push([r._row, { status: 'queued', started_at: '', notes: `not attempted (${stop})` }]); continue; }
      const t0 = Date.now();
      const email = lc(r.email);
      try {
        const id = await g.sendMail({
          to: email, from: FROM, fromName, subject: issue.subject, html: issue.html, text: issue.text,
          headers: {
            'List-Unsubscribe': `<mailto:${FROM}?subject=UNSUBSCRIBE>`,
            'Auto-Submitted': 'auto-generated',
            Precedence: 'bulk',
          },
        });
        sentThisRun += 1;
        consecutive = [];
        let note = '';
        if (sentThisRun === 1 || sentThisRun % FROM_CHECK_EVERY === 0) {
          const check = await g.getMessage(id);
          if (check.fromAddress !== FROM) {
            fromRewritten = `Gmail rewrote From to ${check.fromAddress} (message ${id})`;
            stop = 'From rewritten';
            note = fromRewritten;
          } else note = 'From checked';
        }
        results.push([r._row, { status: 'sent', sent_at: stamp(), gmail_id: id, notes: note }]);
      } catch (err) {
        if (!err || !err.response) {
          // No answer from Gmail: it may have sent. Never retry.
          results.push([r._row, { status: 'stuck', notes: `no response from Gmail, may have sent: ${errMsg(err)}` }]);
          stop = 'no response from Gmail';
        } else if (isQuota(err)) {
          results.push([r._row, { status: 'queued', started_at: '', notes: `quota: ${errMsg(err)}` }]);
          stop = 'Gmail quota or rate limit';
        } else {
          results.push([r._row, { status: 'failed', notes: errMsg(err) }]);
          consecutive.push(r._row);
          if (consecutive.length >= MAX_CONSECUTIVE_FAILS) stop = `${MAX_CONSECUTIVE_FAILS} failures in a row`;
        }
      }
      await sleep(Math.max(0, GAP_MS - (Date.now() - t0)));
    }
    await writeRows('Sends', sHeaders, results);
    if (stop === `${MAX_CONSECUTIVE_FAILS} failures in a row`) {
      // Probably systemic, not bad addresses: put them back in the queue for the resume.
      await writeRows('Sends', sHeaders, consecutive.map((row) => [row, { status: 'queued', started_at: '' }]));
    }
  }

  const final = await mineOf();
  const count = (s) => final.filter((r) => lc(r.status) === s).length;
  return {
    stop, fromRewritten, sentThisRun,
    sent: count('sent'), queued: count('queued'), failed: count('failed'), stuck: count('stuck'),
  };
}

/* -------------------------------------------------------------- Main -- */

async function main() {
  const startedMs = Date.now();
  const today = londonDate(startedMs);
  const issueDate = str(process.env.ISSUE_DATE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error('ISSUE_DATE (YYYY-MM-DD) is required for a send');
  const runId = str(process.env.RUN_ID) || `local-${startedMs}`;
  const confirm = str(process.env.CONFIRM_COUNT);

  const [{ sources, settings }, pending, issues, subscribers, dns, sends, replies, iHeaders, sHeaders, pHeaders] = await Promise.all([
    g.readSettings(), g.readTable('Pending'), g.readTable('Issues'), g.readTable('Subscribers'),
    g.readTable('Do Not Send'), g.readTable('Sends'), g.readTable('Replies'),
    headersOf('Issues'), headersOf('Sends'), headersOf('Pending'),
  ]);

  const mode = lc(settings.newsletter_mode) || 'off';
  if (!MODES.includes(mode)) throw new Error(`Settings newsletter_mode "${mode}" is not one of ${MODES.join('/')}`);
  if (mode === 'off') throw new Error('Settings newsletter_mode is off: nothing sent');
  console.log(`Mode: ${mode}. Issue ${issueDate}. Run ${runId}.`);

  const problems = [];
  const missing = (have, need, tab) => need.filter((h) => !have.includes(h)).forEach((h) => problems.push(`${tab} is missing header "${h}"`));
  missing(iHeaders, ISSUES_HEADERS, 'Issues');
  missing(sHeaders, SENDS_HEADERS, 'Sends');
  missing(pHeaders, PENDING_HEADERS, 'Pending');
  if (problems.length) throw new Error(problems.join('\n'));

  const row = issues.filter((r) => str(r.issue_id) === issueDate).pop();
  if (!row) throw new Error(`No Issues row for ${issueDate}: run the build first`);
  const status = lc(row.status);

  if (status === 'sent') {
    if (mode === 'live' && !str(row.counts_applied_at)) { await applyCounts(issueDate); return; }
    throw new Error(`Issue ${issueDate} has already been sent`);
  }
  if (status === 'aborted') throw new Error(`Issue ${issueDate} is aborted: check Sends and notes before doing anything else`);
  if (status === 'sending' && mode !== 'live') throw new Error(`Issue ${issueDate} is mid-send: only live mode can resume it`);
  if (!['tested', 'shadow', 'sending'].includes(status)) problems.push(`Issue status is "${status || 'blank'}"; needs tested or shadow (run the build first)`);

  // Same content as the tested copy?
  const model = select({
    issueDate, pending, issues, settings, sources, jpegFor,
    whatson: readJson('src/_data/whatson.json'),
    bins: readJson('src/_data/bins.json'),
  });
  const issue = render(model);
  if (issue.hash !== str(row.content_hash)) {
    problems.push(`Content changed since the test (now ${issue.hash.slice(0, 12)}, tested ${str(row.content_hash).slice(0, 12)}): rebuild and re-test`);
  }
  if (model.empty) problems.push('Issue is empty');
  if (mode === 'live' && (today < LIVE_FROM || issueDate < LIVE_FROM)) problems.push(`Live sends are blocked in code before ${LIVE_FROM}`);
  try { await assertSendAs(); } catch (err) { problems.push(errMsg(err)); }

  // Recipients.
  const full = buildRecipients(subscribers, dns, problems);
  console.log(`Recipients: ${full.list.length} (${full.info}).`);
  const base = baseline(issues, issueDate);
  if (base && full.list.length < base.count * (1 - MAX_DROP)) {
    const msg = `Recipients dropped more than 10%: ${full.list.length} vs ${base.count} for ${base.issue}`;
    if (mode === 'canary') console.warn(`Warning: ${msg}`); else problems.push(msg);
  } else if (base) console.log(`Baseline ${base.issue}: ${base.count}.`);
  else console.log('No earlier sent or shadow issue with a recipient count: 10% check skipped.');

  const key = mode === 'canary' ? `${issueDate}:canary` : issueDate;
  const targets = mode === 'canary' ? canaryList(settings.canary_to, problems) : full.list;
  if (mode !== 'shadow') {
    if (confirm !== String(targets.length)) problems.push(`Confirm recipient count: you entered "${confirm}", the computed count is ${targets.length}`);
  }
  const already = new Set(sends.filter((r) => str(r.issue_id) === key && lc(r.status) !== 'queued').map((r) => lc(r.email)));
  const toSend = targets.filter((e) => !already.has(e)).length;
  const used = usedLast24h(sends, replies);
  if (used + toSend > DAY_LIMIT) problems.push(`Daily limit: ${used} sent in the last 24h + ${toSend} would pass ${DAY_LIMIT}`);
  console.log(`Last 24h: ${used} sent; this run: up to ${toSend}.`);

  if (problems.length) {
    console.error(`Refused (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n- ${problems.join('\n- ')}`);
    throw new Error('Pre-checks failed: nothing sent');
  }

  if (mode === 'shadow') {
    await g.updateRow('Issues', row._row, {
      status: status === 'tested' ? 'shadow' : status,
      recipients: full.list.length,
      notes: appendNote(row.notes, `shadow send ${stamp()}: ${full.list.length} would-be recipients (${full.info})`),
    });
    console.log(`Shadow run OK: nothing sent. A live or canary run would need confirm count ${full.list.length} (live) / ${canaryList(settings.canary_to, []).length} (canary).`);
    return;
  }

  // Lock: record this run as the owner and check nothing else has taken it.
  await g.updateRow('Issues', row._row, { send_run: runId, ...(mode === 'live' ? { status: 'sending' } : {}) });
  const check = (await g.readTable('Issues')).find((r) => r._row === row._row);
  if (!check || str(check.send_run) !== runId) throw new Error('Send lock taken by another run: stopping');

  const fromName = g.fromNameFor(settings);
  const res = await sendAll({ key, targets, issue, fromName, runId, startedMs });
  const summary = `${mode} ${stamp()}: ${res.sent} sent, ${res.failed} failed, ${res.stuck} stuck, ${res.queued} queued`;
  console.log(summary + (res.stop ? ` (stopped: ${res.stop})` : ''));

  if (res.fromRewritten) {
    await g.updateRow('Issues', row._row, { status: mode === 'live' ? 'aborted' : status, notes: appendNote(check.notes, `${summary}; ABORTED: ${res.fromRewritten}`) });
    throw new Error(res.fromRewritten);
  }
  if (res.queued) {
    await g.updateRow('Issues', row._row, { notes: appendNote(check.notes, `${summary}; stopped: ${res.stop}; run again to resume`) });
    throw new Error(`Stopped (${res.stop}) with ${res.queued} still queued: run again to resume`);
  }
  if (mode === 'canary') {
    await g.updateRow('Issues', row._row, { notes: appendNote(check.notes, summary) });
  } else {
    await g.updateRow('Issues', row._row, {
      status: 'sent', sent_at: new Date().toISOString(), recipients: res.sent,
      notes: appendNote(check.notes, summary),
    });
    await applyCounts(issueDate);
  }
  if (res.stuck || res.failed) throw new Error(`Finished with ${res.failed} failed and ${res.stuck} stuck: see the Sends tab`);
  console.log('Done.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { buildRecipients, canaryList, baseline, usedLast24h, minuteKey, stamp };
