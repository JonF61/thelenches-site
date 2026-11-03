// scripts/livenotice/index.js
// "Now on the website" (Jon, 3 Nov 2026): once an emailed submission is actually live on the
// site, Holly tells the sender, with a link to its place on the page and a reminder that they may
// need to refresh. Fixed wording (templates.md live_one / live_many; no Claude), sent
// automatically like the acknowledgement, on the same Gmail thread, never in shadow mode.
// Run by live-notice.yml after every site build (and on a schedule as a fallback).
//   Which items: Pending rows approved or auto, from email (not feeds), decided or received on or
//   after LIVE_FROM, not yet in any newsletter (newsletter_count 0), live_notified_at blank, and
//   whose acknowledgement (Replies type ack or clarify) was sent. Several items from one email
//   go in one message.
//   Live: the item is in src/_data/pipeline.json (this checkout is the latest main) AND a fresh
//   copy of its page (/events/ or /notices/, cache-busted) has its anchor. The Pages cache can lag
//   the build, so the page is checked up to CHECKS times, WAIT_MS apart; items still not shown
//   wait for the next run, and after GIVE_UP_DAYS are marked "not shown" and dropped.
// Writes: a Replies row (type live, queued; reply_id <message id>-live-<n>) sent by
// replies.sendDueReplies (caps, threading and anonymity checks as for every reply), and Pending
// live_notified_at (needs the column; without it nothing is sent). Logs print counts only.
'use strict';

const fs = require('fs');
const path = require('path');
const g = require('../ingest/google');
const replies = require('../ingest/replies');
const { anchorUrl } = require('../../lib/anchors');

const TZ = 'Europe/London';
const PIPELINE = path.join(__dirname, '..', '..', 'src', '_data', 'pipeline.json');
// Only items decided from when this was switched on: older ones never get a late email.
const LIVE_FROM = process.env.LIVE_FROM_TEST || '2026-11-03 21:00';
const COLUMN = 'live_notified_at';
const CHECKS = Number(process.env.LIVE_CHECKS || 6);
const WAIT_MS = Number(process.env.LIVE_WAIT_MS || 60000);
const GIVE_UP_DAYS = 3;
const ACK_TYPES = ['ack', 'clarify'];

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function londonDateTime(ms) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return `${date} ${time}`;
}

// Published pipeline items by Pending id -> { kind, url, anchor, page } (pure).
function publishedById(pipeline) {
  const out = new Map();
  for (const [list, kind] of [['events', 'event'], ['notices', 'notice']]) {
    for (const it of (pipeline && pipeline[list]) || []) {
      const url = anchorUrl(kind, it);
      if (!url || !it.id) continue;
      const [page, anchor] = url.split('#');
      out.set(String(it.id), { kind, title: str(it.title), url, page, anchor });
    }
  }
  return out;
}

// Messages owed a "now live" email (pure): [{ messageId, ack, items: [{ row, pub }] }].
function due(pending, repliesRows, published) {
  const acks = new Map();
  for (const r of repliesRows) {
    if (ACK_TYPES.includes(str(r.type)) && str(r.status) === 'sent' && str(r.message_id)) acks.set(str(r.message_id), r);
  }
  const groups = new Map();
  for (const row of pending) {
    if (!['approved', 'auto'].includes(str(row.status)) || str(row[COLUMN])) continue;
    const m = str(row.message_id);
    if (!m || m.startsWith('rss:') || (str(row.decided_at) || str(row.received)) < LIVE_FROM) continue;
    if (Number(row.newsletter_count) > 0) continue;
    const ack = acks.get(m);
    const pub = published.get(str(row.id));
    if (!ack || !pub) continue;
    if (!groups.has(m)) groups.set(m, { messageId: m, ack, items: [] });
    groups.get(m).items.push({ row, pub });
  }
  return [...groups.values()];
}

// "Hi Nadine," from the acknowledgement's first line, else the plain greeting (pure).
function greetingFrom(ack) {
  const first = str(ack.body).split('\n')[0];
  const m = /^Hi (.{1,40}),$/.exec(first);
  return m && m[1] !== 'there' ? replies.greeting(m[1]) : replies.greeting('');
}

// The email body (pure apart from templates.md).
function bodyFor(ack, items) {
  const parts = [greetingFrom(ack)];
  if (items.length === 1) parts.push(replies.fill('live_one', { title: items[0].pub.title, link: items[0].pub.url }));
  else parts.push(replies.fill('live_many', { titles: items.map((i) => `- ${i.pub.title}: ${i.pub.url}`).join('\n') }));
  parts.push(replies.fill('signature'));
  return parts.join('\n\n');
}

// Which anchors a fresh copy of each page has. fetchPage(url) -> html (tests pass their own).
async function shownAnchors(pages, fetchPage) {
  const shown = new Set();
  for (const page of pages) {
    try {
      const html = await fetchPage(`${page}?v=${Date.now()}`);
      for (const m of String(html).matchAll(/\sid="([^"]+)"/g)) shown.add(`${page}#${m[1]}`);
    } catch (err) {
      console.warn(`Page check failed: ${(err && err.message) || err}`);
    }
  }
  return shown;
}

async function defaultFetch(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache', 'user-agent': 'lenches-live-notice' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function run({ fetchPage = defaultFetch, now = Date.now() } = {}) {
  const { settings } = await g.readSettings();
  if (replies.repliesMode(settings) !== 'live') { console.log('Replies are not live: nothing sent.'); return 0; }
  const [pending, repliesRows] = await Promise.all([g.readTable('Pending'), g.readTable('Replies')]);
  if (pending.length && !(COLUMN in pending[0])) {
    console.warn(`Pending has no "${COLUMN}" column: add it at the end to switch on "now on the website" emails.`);
    return 0;
  }
  const pipeline = JSON.parse(fs.readFileSync(PIPELINE, 'utf8'));
  let groups = due(pending, repliesRows, publishedById(pipeline));
  if (!groups.length) { console.log('No items waiting for a "now live" email.'); return 0; }

  // Wait until every waiting item shows on a fresh copy of its page, or the checks run out.
  let ready = [];
  for (let n = 1; n <= CHECKS; n += 1) {
    const pages = [...new Set(groups.flatMap((gr) => gr.items.map((i) => i.pub.page)))];
    const shown = await shownAnchors(pages, fetchPage);
    ready = groups.map((gr) => ({ ...gr, items: gr.items.filter((i) => shown.has(i.pub.url)) })).filter((gr) => gr.items.length);
    const waiting = groups.reduce((a, gr) => a + gr.items.length, 0) - ready.reduce((a, gr) => a + gr.items.length, 0);
    if (!waiting || n === CHECKS) break;
    console.log(`${waiting} item(s) not on the live page yet; checking again in ${Math.round(WAIT_MS / 1000)}s.`);
    await sleep(WAIT_MS);
  }

  const at = londonDateTime(now);
  const stale = londonDateTime(now - GIVE_UP_DAYS * 86400000);
  const readyIds = new Set(ready.flatMap((gr) => gr.items.map((i) => i.row.id)));
  for (const gr of groups) {
    for (const i of gr.items) {
      if (!readyIds.has(i.row.id) && (str(i.row.decided_at) || str(i.row.received)) < stale) {
        await g.updateRow('Pending', i.row._row, { [COLUMN]: `not shown after ${GIVE_UP_DAYS} days` });
      }
    }
  }

  let queued = 0;
  for (const gr of ready) {
    const n = repliesRows.filter((r) => str(r.reply_id).startsWith(`${gr.messageId}-live-`)).length + 1;
    const row = {
      reply_id: `${gr.messageId}-live-${n}`,
      message_id: gr.messageId,
      thread_id: gr.ack.thread_id,
      to: gr.ack.to,
      class: 'submission',
      type: 'live',
      policy_codes: 'live',
      subject: gr.ack.subject,
      body: bodyFor(gr.ack, gr.items),
      status: 'queued',
      created_at: at,
      notes: `Now on the website: ${gr.items.length} item(s), checked on the live page`,
    };
    await g.appendRows('Replies', [row]);
    // Marked before sending: a failed send shows in Replies (status failed), never a second email.
    for (const i of gr.items) await g.updateRow('Pending', i.row._row, { [COLUMN]: at });
    queued += 1;
  }
  console.log(`"Now live" emails queued: ${queued} (${readyIds.size} item(s)).`);
  if (queued) {
    const holiday = String(settings.holiday_mode || '').toUpperCase() === 'TRUE';
    await replies.sendDueReplies(settings, holiday);
  }
  return queued;
}

module.exports = { run, due, publishedById, bodyFor, greetingFrom, shownAnchors, LIVE_FROM, COLUMN };

if (require.main === module) {
  run().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
