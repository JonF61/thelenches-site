// Inbound links (SEO step 5, 26 Nov 2026, Jon): the SEO screen's third sub-page lists the shown
// site's "Link partners" tab (made and checked each Monday by scripts/linkcheck, link-check.yml).
// Jon changes a partner's status, notes or email here, each a stale-checked write of one cell;
// the check fills link_found_at, last_checked and check. Read and written on the shown site's Sheet.
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
export function linkPartners({ headers, rows }, replies = [], today = '') {
  const order = { 'To ask': 0, '': 0, 'Link gone': 1, Asked: 2, Linking: 3, 'Not now': 4, Declined: 5 };
  const list = (rows || []).filter((r) => str(r.id) || str(r.name)).map((r) => ({
    id: str(r.id), name: str(r.name), type: str(r.type), url: str(r.url), status: str(r.status) || 'To ask',
    link_found_at: str(r.link_found_at), last_checked: str(r.last_checked), check: str(r.check),
    notes: str(r.notes), email: str(r.email), asked_at: str(r.asked_at), _status: str(r.status), _notes: str(r.notes), _email: str(r.email),
    listed_page: str(r.listed_page), listed_url: str(r.listed_url),
    request: requestsFor(str(r.id), replies),
    // What Draft request would do now ('request' | 'chase'), or why not (the button's title).
    ask: (() => { const p = planLinkAsk(r, replies, today); return p.error ? { why: p.error } : { kind: p.kind }; })(),
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

// The request / chaser Replies rows for one partner -> { waiting, requestSent, chaseSent }.
export function requestsFor(id, replies) {
  const mine = (replies || []).filter((r) => codesOf(r).some((c) => c === `link_request_${id}` || c === `link_chase_${id}`));
  const sent = (code) => mine.filter((r) => codesOf(r).includes(code) && (str(r.status) === 'sent' || str(r.sent_at)))
    .map((r) => dayOf(r.sent_at) || dayOf(r.created_at)).sort().pop() || '';
  return {
    waiting: mine.some((r) => str(r.status) === 'awaiting'),
    requestSent: sent(`link_request_${id}`),
    chaseSent: sent(`link_chase_${id}`),
  };
}

// Draft request / Draft chaser for one partner row -> { kind: 'request' | 'chase' } or { error, status }.
export function planLinkAsk(row, replies, today) {
  if (!row) return { error: 'No such partner: reload the page', status: 404 };
  const id = str(row.id);
  const status = str(row.status) || 'To ask';
  if (!EMAIL.test(str(row.email))) return { error: 'Add their email address first', status: 400 };
  if (status === 'Linking') return { error: 'Not drafted: they already link to us', status: 409 };
  if (status === 'Declined' || status === 'Not now') return { error: `Not drafted: marked ${status}`, status: 409 };
  const r = requestsFor(id, replies);
  if (r.waiting) return { error: 'Not drafted: a draft to them is already waiting for you (Replies)', status: 409 };
  if (!r.requestSent) return { kind: 'request' };
  if (r.chaseSent) return { error: `Not drafted: asked ${r.requestSent} and chased ${r.chaseSent}`, status: 409 };
  const due = addDays(r.requestSent, LINK_CHASE_DAYS);
  if (today < due) return { error: `Not drafted: asked ${r.requestSent}; a chaser is due from ${due}`, status: 409 };
  return { kind: 'chase' };
}
