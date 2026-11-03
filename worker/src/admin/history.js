// worker/src/admin/history.js
// Previous submissions (Submissions screen, 3 Nov): every decided Pending row, newest first,
// with what happened to it. Read-only; built from three tabs:
//   Pending        status (approved / auto / rejected / done / …), decided_at, reject_reason
//                  (Jon's optional Reject reason, panel only; never sent to anyone)
//   Issues         item_keys of each newsletter sent live ("p:<Pending id>")
//   Item feedback  outcome (approved as written / edited) and what Jon changed
// "On the website" repeats scripts/publish's window: from the decision (else received), events
// until their date, notices until their date or 21 days on, roadworks until their end date.

import { itemChanges } from './autonomy.js';

export const NOTICE_DAYS = 21;    // as scripts/publish NOTICE_DAYS
const LIVE = new Set(['approved', 'auto']);
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const ymd = (v) => (str(v).match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
const later = (a, b) => (a > b ? a : b);
function addDays(d, n) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A display name from a From header ("Ann Smith <a@b>" -> "Ann Smith"), else the address.
function nameOf(from) {
  const v = str(from);
  const m = v.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  return m ? m[1].trim() : v;
}

// As scripts/publish: which page and for how long, or null if it never goes on the site.
export function siteWindow(r) {
  const status = str(r.status).toLowerCase();
  if (!LIVE.has(status)) return null;
  const date = ymd(r.event_date);
  const from = ymd(r.decided_at) || ymd(r.received);
  if (!from) return null;
  const cat = str(r.category).toLowerCase();
  let page = 'Notices';
  let until;
  if (cat === 'event' && date) {
    page = 'Events';
    until = date;
  } else {
    until = later(date, addDays(from, NOTICE_DAYS));
  }
  const roads = /one\.network/i.test(str(r.link_url));   // as lib/roads.js isRoad
  const end = roads ? ymd(r.end_date) : '';
  if (end) until = later(until, end);
  if (roads) page = 'Roads';
  return { page, from, until };
}

// { rows: [...] } newest decided first. today: YYYY-MM-DD (UK).
export function submissionHistory({ pending, issues, feedback, today, limit = 500 }) {
  const sentIn = new Map();
  for (const r of (issues && issues.rows) || []) {
    if (str(r.status).toLowerCase() !== 'sent' || !ymd(r.issue_date)) continue;
    for (const k of new Set(str(r.item_keys).split(/\s+/))) {
      if (!k.startsWith('p:')) continue;
      const id = k.slice(2);
      if (!sentIn.has(id)) sentIn.set(id, []);
      sentIn.get(id).push(ymd(r.issue_date));
    }
  }
  const fb = new Map();
  for (const r of (feedback && feedback.rows) || []) if (str(r.item_id)) fb.set(str(r.item_id), r);

  const rows = [];
  for (const r of (pending && pending.rows) || []) {
    const status = str(r.status).toLowerCase();
    if (!status || status === 'pending' || !str(r.id)) continue;
    const f = fb.get(str(r.id));
    const outcome = f ? str(f.outcome).toLowerCase().replace(/^ignored:/, '') : '';
    const site = siteWindow(r);
    const issuesFor = (sentIn.get(str(r.id)) || []).sort();
    const feed = /^rss:/i.test(str(r.message_id));
    rows.push({
      id: str(r.id),
      row: r._row,
      title: str(r.title) || '(no title)',
      category: str(r.category).toLowerCase() || 'notice',
      village: str(r.village),
      eventDate: ymd(r.event_date),
      received: str(r.received),
      decidedAt: str(r.decided_at),
      status,
      edited: outcome === 'edited',
      changed: outcome === 'edited' && f ? itemChanges(f) : '',
      wording: str(r.wording),
      from: feed ? str(r.source) : nameOf(r.from) || str(r.source),
      origin: feed ? 'feed' : 'email',
      gmail: /^https:\/\/mail\.google\.com\//i.test(str(r.gmail_link)) ? str(r.gmail_link) : '',
      link: feed && /^https?:\/\//i.test(str(r.gmail_link)) ? str(r.gmail_link) : '',
      notes: clip(str(r.notes), 400),
      reason: str(r.reject_reason),
      site: site ? { ...site, now: today >= site.from && today <= site.until } : null,
      newsletter: issuesFor,
    });
  }
  const at = (x) => ymd(x.decidedAt) ? x.decidedAt : x.received;
  rows.sort((a, b) => (at(b) > at(a) ? 1 : at(b) < at(a) ? -1 : b.row - a.row));
  return { today, rows: rows.slice(0, limit), total: rows.length, hasReasonColumn: Boolean(pending && (pending.headers || []).includes('reject_reason')) };
}
