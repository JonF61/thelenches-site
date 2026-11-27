// Inbound links (SEO step 5, 26 Nov 2026, Jon): the SEO screen's third sub-page lists the shown
// site's "Link partners" tab (made and checked each Monday by scripts/linkcheck, link-check.yml).
// Jon changes a partner's status, notes or email here, each a stale-checked write of one cell;
// the check fills link_found_at, last_checked and check. Read and written on the shown site's Sheet.
import { FREE_MAIL } from './orgoutreach.mjs';

export const LINK_TAB = 'Link partners';
export const LINK_STATUSES = ['To ask', 'Asked', 'Linking', 'Link gone', 'Declined', 'Not now'];
const FIELDS = ['status', 'notes', 'email'];
const str = (v) => String(v ?? '').trim();
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

// One edit -> { field, expected, value, also } or { error, status }.
export function planLinkEdit(row, body, today) {
  if (!row) return { error: 'No such partner: reload the page', status: 404 };
  const field = String(body.field || '');
  if (!FIELDS.includes(field)) return { error: `Only ${FIELDS.join(', ')} can be changed here`, status: 400 };
  let value = str(body.value).replace(/\s+/g, ' ');
  if (field === 'status' && !LINK_STATUSES.includes(value)) return { error: 'Pick one of the statuses', status: 400 };
  if (field === 'email' && value && !EMAIL.test(value)) return { error: 'That does not look like an email address', status: 400 };
  if (field === 'notes' && value.length > 500) return { error: 'Keep notes under 500 characters', status: 400 };
  // Asked: remember the day (the card shows "Asked <day>").
  const also = field === 'status' && value === 'Asked' && str(row.status) !== 'Asked' ? { asked_at: today } : null;
  return { field, expected: String(body.expected ?? ''), value, also };
}

// The tab for the panel: partners in a useful order (to ask first, then asked, link gone,
// linking, declined / not now), with counts per status.
export function linkPartners({ headers, rows }, replies = [], today = '', site = '') {
  const order = { 'To ask': 0, '': 0, 'Link gone': 1, Asked: 2, Linking: 3, 'Not now': 4, Declined: 5 };
  const list = (rows || []).filter((r) => str(r.id) || str(r.name)).map((r) => ({
    id: str(r.id), name: str(r.name), type: str(r.type), url: str(r.url), status: str(r.status) || 'To ask',
    link_found_at: str(r.link_found_at), last_checked: str(r.last_checked), check: str(r.check),
    notes: str(r.notes), email: str(r.email), asked_at: str(r.asked_at), _status: str(r.status), _notes: str(r.notes), _email: str(r.email),
    listed_page: str(r.listed_page), listed_url: str(r.listed_url),
    request: requestsFor(str(r.id), replies, site),
    // What Draft request would do now ('request' | 'chase'), or why not (the button's title).
    ask: (() => { const p = planLinkAsk(r, replies, today, site); return p.error ? { why: p.error } : { kind: p.kind }; })(),
  }));
  list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));
  const counts = {};
  list.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
  return { made: (headers || []).length > 0, partners: list, counts, statuses: LINK_STATUSES };
}

// ---- Draft request (26 Nov, Jon; wording approved 26 Nov, templates.md link_request / link_chase)
// Holly's fixed-wording request for a link, then one chaser on the same thread 21 days after the
// request was sent while no link has been found. Replies rows: type outreach, policy_codes
// link_request_<id> / link_chase_<id>, awaiting Jon's Approve. Shared with scripts/outreach/linkask.js.
export const LINK_CHASE_DAYS = 21;
const codesOf = (r) => String(r.policy_codes || '').split(/[\s,;|]+/).filter(Boolean);
const dayOf = (s) => str(s).slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The request / chaser Replies rows for one partner -> { waiting, requestSent, requestSentAt
// (UK "YYYY-MM-DD HH:MM"), chaseSent, viaOther }.
// Both sites (27 Nov, Jon): one email can ask a partner the two sites share (same address, e.g.
// ARCH) for links to both. It is a Replies row on the site that drafted it, whose policy_codes
// also carry the other site's partner as link_request_<id>@<site> (link_chase_<id>@<site>). So
// pass `site` and this Sheet's Replies plus the other Sheets' (bothReplies): a request sent
// from the other site counts here too (viaOther: its chaser goes from that site).
export function requestsFor(id, replies, site = '') {
  const own = (c) => c === `link_request_${id}` || c === `link_chase_${id}`;
  const other = (c) => Boolean(site) && (c === `link_request_${id}@${site}` || c === `link_chase_${id}@${site}`);
  const mine = (replies || []).filter((r) => codesOf(r).some((c) => own(c) || other(c)));
  const sentRows = (kind) => mine.filter((r) => codesOf(r).some((c) => c === `link_${kind}_${id}` || c === `link_${kind}_${id}@${site}`)
    && (str(r.status) === 'sent' || str(r.sent_at)));
  const lastAt = (rows) => rows.map((r) => str(r.sent_at) || str(r.created_at)).sort().pop() || '';
  const last = (rows) => dayOf(lastAt(rows));
  const requests = sentRows('request');
  return {
    waiting: mine.some((r) => str(r.status) === 'awaiting'),
    requestSent: last(requests),
    requestSentAt: lastAt(requests).slice(0, 16),
    chaseSent: last(sentRows('chase')),
    viaOther: requests.length > 0 && requests.every((r) => !codesOf(r).includes(`link_request_${id}`)),
  };
}

// This Sheet's Replies plus another site's, for requestsFor / planLinkAsk.
export const bothReplies = (own, others = []) => [...(own || []), ...others.flat()];

// No chaser while emails are going back and forth (27 Nov 2026, Jon: never chase by accident
// after they've replied or asked something). Their own address, plus their domain unless it is
// free mail, as Gmail search terms and as a matcher for Replies rows.
const addrOf = (v) => (str(v).match(/[^\s<>,;"]+@[^\s<>,;"]+/) || [''])[0].toLowerCase();
export function theirMail(email) {
  const a = addrOf(email);
  const d = a.split('@')[1] || '';
  const dom = d && !FREE_MAIL.has(d) ? d : '';
  return {
    matches: (v) => { const x = addrOf(v); return !!x && (x === a || (!!dom && x.endsWith(`@${dom}`))); },
    query: [a, dom && `@${dom}`].filter(Boolean).map((t) => `from:${t} to:${t}`).join(' '),
  };
}

// The latest day of a Replies row with them since the request (Holly answering their email,
// or any other draft to them; the link rows themselves left out), or ''.
export function talkSince(id, email, replies, sinceAt) {
  if (!sinceAt || !EMAIL.test(str(email))) return '';
  const { matches } = theirMail(email);
  return (replies || [])
    .filter((r) => matches(r.to) && !codesOf(r).some((c) => c.startsWith(`link_request_${id}`) || c.startsWith(`link_chase_${id}`)))
    .map((r) => str(r.created_at).slice(0, 16))
    .filter((t) => t > sinceAt).sort().pop()?.slice(0, 10) || '';
}

// A UK "YYYY-MM-DD HH:MM" as Unix seconds (for a Gmail after: search), or 0.
export function ukEpoch(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(str(stamp));
  if (!m) return 0;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(asUtc).map((x) => [x.type, x.value]));
  const offset = ((+p.hour * 60 + +p.minute) - (+m[4] * 60 + +m[5]) + 1440) % 1440; // UK minus UTC, minutes
  return Math.floor((asUtc - (offset > 720 ? offset - 1440 : offset) * 60000) / 1000);
}

// Draft request / Draft chaser for one partner row -> { kind: 'request' | 'chase' } or { error, status }.
// heard: the latest day Gmail shows mail with them since the request (the panel's live check), or ''.
export function planLinkAsk(row, replies, today, site = '', { heard = '' } = {}) {
  if (!row) return { error: 'No such partner: reload the page', status: 404 };
  const id = str(row.id);
  const status = str(row.status) || 'To ask';
  if (!EMAIL.test(str(row.email))) return { error: 'Add their email address first', status: 400 };
  if (status === 'Linking') return { error: 'Not drafted: they already link to us', status: 409 };
  if (status === 'Declined' || status === 'Not now') return { error: `Not drafted: marked ${status}`, status: 409 };
  const r = requestsFor(id, replies, site);
  if (r.waiting) return { error: 'Not drafted: a draft to them is already waiting for you (Replies)', status: 409 };
  if (!r.requestSent) return { kind: 'request' };
  if (r.viaOther) return { error: 'Not drafted: asked from the other site with one email for both; any chaser goes from there', status: 409 };
  if (r.chaseSent) return { error: `Not drafted: asked ${r.requestSent} and chased ${r.chaseSent}`, status: 409 };
  const talk = [talkSince(id, row.email, replies, r.requestSentAt), dayOf(heard)].filter(Boolean).sort().pop();
  if (talk) {
    return { error: `Not drafted: you've been emailing them since the request (latest ${talk}). Carry on in that thread, or mark them Declined or Not now`, status: 409 };
  }
  const due = addDays(r.requestSent, LINK_CHASE_DAYS);
  if (today < due) return { error: `Not drafted: asked ${r.requestSent}; a chaser is due from ${due}`, status: 409 };
  return { kind: 'chase' };
}
