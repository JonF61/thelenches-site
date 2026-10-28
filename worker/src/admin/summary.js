// worker/src/admin/summary.js
// The panel's Summary page (first in the menu): written summaries made by code, never
// Claude. The page builds Submissions, Replies, Owed, Feedback, Health and the holiday
// banner from /admin/api/state, which it already has; this module adds the rest for
// /admin/api/summary. Read-only: nothing here writes, sends or decides anything.
//   nextIssue           the next newsletter: date, deadline, its Issues row, On this day,
//                       events in its 14-day window and new items approved since the last one
//   failingRuns         workflows whose latest finished run failed
//   subscriberChanges   sign-ups and Do Not Send additions since the last sent newsletter
//                       (counts only: no address ever reaches the page)
//   comingWeek          events and road works in the next 7 days (the site's coming-up.json)
//   devTasks            the repo's dev-tasks list (devtasks.json, kept by Kryten)

import onThisDayData from '../../../src/_data/onthisday.json' with { type: 'json' };
import devTasksData from './devtasks.json' with { type: 'json' };

const DAY = 86400000;
const TZ = 'Europe/London';
const DEADLINE_HM = '18:00'; // as scripts/newsletter/select.js: the Wednesday before the issue
const WINDOW_DAYS = 14;
const LIVE = new Set(['approved', 'auto']);
const COUNTED = new Set(['sent', 'shadow']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const COMING_FILE = 'coming-up.json';

const str = (v) => String(v ?? '').trim();
const low = (v) => str(v).toLowerCase();
const pad2 = (n) => String(n).padStart(2, '0');
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

// 2026-10-15, 2026-10-15 09:30, an ISO stamp or 15/10/2026 -> YYYY-MM-DD, else ''.
export function ymd(value) {
  const v = str(value);
  let m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : '';
}

// A Sheet timestamp as UK "YYYY-MM-DD HH:MM" (as select.js minuteKey), or ''.
export function minuteKey(value) {
  const v = str(value);
  if (/T/.test(v) && /(Z|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))) return ukStamp(Date.parse(v));
  let m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return `${m[1]} ${pad2(m[2])}:${m[3]}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])} ${pad2(m[4])}:${m[5]}`;
  const d = ymd(v);
  return d ? `${d} 00:00` : '';
}

export function ukStamp(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// UK wall-clock "YYYY-MM-DD HH:MM" -> an ISO instant (GMT or BST, whichever matches).
export function ukInstant(stamp) {
  const base = Date.parse(`${stamp.replace(' ', 'T')}:00Z`);
  for (const off of [0, -3600000]) if (ukStamp(base + off) === stamp) return new Date(base + off).toISOString();
  return new Date(base).toISOString();
}

// Thursday on or after today; next week's once today's issue has gone out.
export function issueDateFor(today, issues) {
  let d = today;
  while (weekday(d) !== 4) d = addDays(d, 1);
  const gone = (issues || []).some((r) => ymd(r.issue_date) === d && ['sent', 'sending'].includes(low(r.status)));
  return gone ? addDays(d, 7) : d;
}

// The last sent issue's date (for "since the last newsletter"), else the Thursday before today.
export function lastSentDate(today, issues) {
  const sent = (issues || []).filter((r) => low(r.status) === 'sent' && ymd(r.issue_date) && ymd(r.issue_date) <= today)
    .map((r) => ymd(r.issue_date)).sort();
  if (sent.length) return sent[sent.length - 1];
  let d = addDays(today, -1);
  while (weekday(d) !== 4) d = addDays(d, -1);
  return d;
}

// coming: the site's coming-up.json ({ events }) or null. The item count is a guide, not
// the issue: the build applies more rules (each item at most 3 issues, the deadline cut).
export function nextIssue({ today, issues = [], pending = [], coming = null }) {
  const date = issueDateFor(today, issues);
  const deadline = `${addDays(date, -1)} ${DEADLINE_HM}`;
  const rows = issues.filter((r) => ymd(r.issue_date) === date);
  const row = rows[rows.length - 1] || null;
  const past = issues.filter((r) => COUNTED.has(low(r.status)) && ymd(r.issue_date) && ymd(r.issue_date) < date)
    .map((r) => ymd(r.issue_date)).sort();
  const newFrom = addDays(past.length ? past[past.length - 1] : addDays(date, -7), -1);
  const end = addDays(date, WINDOW_DAYS - 1);
  const events = coming && Array.isArray(coming.events)
    ? coming.events.filter((e) => e.date >= date && e.date <= end).length : null;
  const fresh = pending.filter((r) => LIVE.has(low(r.status)) && str(r.title) && low(r.category) !== 'event')
    .filter((r) => {
      const d = ymd(r.decided_at) || ymd(r.received);
      const rec = minuteKey(r.received);
      return d >= newFrom && d <= date && !(rec && rec > deadline);
    }).length;
  const entry = onThisDayData.entries && onThisDayData.entries[date.slice(5)];
  return {
    date, deadline, deadlineAt: ukInstant(deadline),
    status: row ? low(row.status) : '', sentAt: row ? str(row.sent_at) : '', row: row ? row._row : 0,
    onThisDay: str(entry && entry.text), events, fresh,
  };
}

// runs: admin/runs.js rows, newest first. [{ name, started, url }] for each workflow whose
// latest finished run failed (a later success clears it).
export function failingRuns(runs) {
  const seen = new Set();
  const out = [];
  for (const r of runs || []) {
    if (r.status !== 'completed' || seen.has(r.name)) continue;
    if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
    seen.add(r.name);
    if (FAILED.has(r.conclusion)) out.push({ name: r.name, started: r.started, url: r.url });
  }
  return out;
}

const firstDate = (r, keys) => {
  for (const k of keys) { const d = ymd(r[k]); if (d) return d; }
  return '';
};

// Counts since `since` (YYYY-MM-DD, that day included). Subscribers rows: active or blank
// status; Do Not Send: unsubscribes, bounces and blocks alike.
export function subscriberChanges(subs, dns, since) {
  const active = (r) => !str(r.status) || low(r.status) === 'active';
  const joined = (subs || []).filter((r) => active(r) && firstDate(r, ['added_at', 'subscribed_date', 'date']) >= since).length;
  const left = (dns || []).filter((r) => firstDate(r, ['added_at', 'date']) >= since).length;
  const total = (subs || []).filter((r) => active(r) && str(r.email)).length;
  return { since, joined, left, total };
}

// Events and road works on any of the 7 days from today.
export function comingWeek(coming, today) {
  if (!coming || coming.error) return coming || { error: 'no list' };
  const last = addDays(today, 6);
  const on = (start, end) => start && start <= last && (end || start) >= today;
  return {
    generated: str(coming.generated),
    events: (coming.events || []).filter((e) => on(e.date, e.end)),
    roads: (coming.roads || []).filter((r) => r.start <= last && (!r.end || r.end >= today)),
  };
}

export function devTasks() {
  return (devTasksData.tasks || []).filter((t) => str(t.task))
    .map((t) => ({ task: str(t.task), waiting: str(t.waiting), added: ymd(t.added) }));
}

// The site's coming-up.json, or { error }. Cached at the edge for 5 minutes.
export async function comingUpFile(env) {
  const site = String(env.SITE_URL || 'https://thelenches.org.uk/');
  try {
    const r = await fetch(`${site.endsWith('/') ? site : `${site}/`}${COMING_FILE}`, { cf: { cacheTtl: 300 } });
    if (!r.ok) return { error: `${COMING_FILE}: HTTP ${r.status}` };
    const j = await r.json();
    if (!j || !Array.isArray(j.events) || !Array.isArray(j.roads)) return { error: `${COMING_FILE}: unreadable` };
    return j;
  } catch (e) {
    return { error: `${COMING_FILE}: ${e.message}` };
  }
}
