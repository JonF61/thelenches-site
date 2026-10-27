// worker/src/admin/orgoutreach.mjs (.mjs so scripts/outreach can import it)
// Organisation outreach (27 Oct 2026): once a year Holly asks each organisation the site lists
// to check its entry. The list is src/_data/contacts.json `outreach` (orgEntries resolves each
// one's details from contacts.json, council.json, schools.json, health.json, transport.json);
// what has happened is worked out from the Replies tab on each load, and the Org outreach tab
// (id, next_check, notes; made by the panel on the first Done / Snooze / Never) holds Jon's
// choices. Pure: no Google, GitHub or Claude calls. Used by the panel (Contacts >
// Organisations) and scripts/outreach/orgs.js, so both apply the same rules.
// Each organisation is in one state:
//   noemail  no address to write to (check by phone or their website)
//   held     Org outreach next_check "never", or a date still to come (Done or Snooze)
//   draft    a check or chaser draft is waiting for Jon's Approve
//   due      never checked, or the last check went CYCLE_DAYS or more ago
//   waiting  check sent, no reply yet, under CHASE_DAYS
//   chase    check sent CHASE_DAYS or more ago with no reply: a chaser is due
//   chased   chaser sent, no reply yet, under CHASE_DAYS
//   noreply  chaser sent CHASE_DAYS or more ago with no reply: taken as all fine (the chaser
//            says so) until the next cycle
//   replied  they emailed website@ after the check (a Replies row from their address, or
//            their Contacts row's last_contact): Jon reads it in Gmail and taps Done
// Drafts are Replies rows of type "outreach" (so they only go on Jon's Approve or Edit, never
// by themselves or in holiday mode) with policy_codes org_check_<id> or org_chase_<id>; the
// chaser is sent on the check's Gmail thread (scripts/ingest/replies.js chaseThread).
// At most DAY_CAP organisation drafts a day. Ids are slugs, so logs never show an address.

export const ORG_TAB = 'Org outreach';
export const ORG_HEADERS = ['id', 'next_check', 'notes'];
export const ORG_TYPE = 'outreach';
export const CHASE_DAYS = 21;
export const CYCLE_DAYS = 365;
export const DAY_CAP = 10;
export const SUBJECT = 'Your entry on thelenches.org.uk';
export const SITE = 'https://thelenches.org.uk';
export const PAGE_NAMES = {
  '/groups/': 'Groups & Clubs',
  '/halls/': 'Village Halls',
  '/churches/': 'Churches',
  '/contact/': 'Contact & About',
  '/living-here/council/': 'Council & planning',
  '/living-here/schools/': 'Schools',
  '/living-here/health/': 'Health & emergencies',
  '/living-here/getting-around/': 'Getting around',
};
const SENT = ['queued', 'sending', 'sent'];

const DAY = 864e5;
const str = (v) => String(v ?? '').trim();
const low = (v) => str(v).toLowerCase();
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const ms = (d) => Date.parse(`${d}T12:00:00Z`);
const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY);
export const addDays = (d, n) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
const codes = (r) => str(r.policy_codes).split(/[\s,;|]+/).filter(Boolean);

// The first object anywhere in data whose name is `name`.
function findByName(data, name) {
  if (Array.isArray(data)) {
    for (const v of data) { const r = findByName(v, name); if (r) return r; }
  } else if (data && typeof data === 'object') {
    if (data.name === name) return data;
    for (const v of Object.values(data)) { const r = findByName(v, name); if (r) return r; }
  }
  return null;
}

const firstWord = (name) => (str(name).match(/^[A-Za-z][A-Za-z'’-]{1,19}/) || [''])[0];

// contacts.json `outreach` -> [{ id, name, email, greet, page, pageName, pageUrl, shown }].
// data: { contacts, council, schools, health, transport } (the src/_data files). shown is what
// the site shows for them (address, phone, email, website), one item per line of the email.
export function orgEntries(data) {
  const { contacts = {}, council = {}, schools = {} } = data || {};
  const out = [];
  for (const e of contacts.outreach || []) {
    const o = (contacts.orgs || {})[e.id];
    let d = {};
    let greet = '';
    let clerk = '';
    if (o) {
      d = o;
      if (o.council) {
        d = (council.parishes || []).find((p) => p.key === o.council) || {};
        clerk = str(d.clerk);
        greet = firstWord(clerk);
      }
      if (o.school) d = (schools.local || []).find((s) => s.name === o.school) || {};
      if (o.person) greet = firstWord(o.person);
    } else if (e.from) {
      d = findByName(data[e.from], e.name) || {};
    }
    if (e.person) greet = firstWord(e.person);
    const s = { ...d, ...(e.shown || {}) };
    const url = str(s.url) || str(((s.links || [])[0] || {}).url) || str(o && o.url);
    const shown = [
      clerk ? `Clerk: ${clerk}` : '',
      str(s.address) || str(s.where),
      str(s.email) || (o && o.facebook ? `Facebook: ${o.facebook}` : ''),
      str(s.phone),
      url || (s.contactUrl ? `Contact form: ${s.contactUrl}` : ''),
    ].filter(Boolean);
    out.push({
      id: e.id,
      name: str(e.label) || str(o && o.name) || str(e.name),
      email: low(e.email) || low(s.email),
      greet,
      page: e.page,
      pageName: PAGE_NAMES[e.page] || e.page,
      pageUrl: `${SITE}${e.page}`,
      shown,
    });
  }
  return out;
}

// This organisation's outreach rows in Replies, newest first.
export function rowsFor(id, replies) {
  return (replies || []).filter((r) => r.type === ORG_TYPE
    && (codes(r).includes(`org_check_${id}`) || codes(r).includes(`org_chase_${id}`)))
    .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
}
const isChase = (r) => codes(r).some((c) => c.startsWith('org_chase_'));
const sentDay = (r) => str(r.sent_at || r.created_at).slice(0, 10);

// The first email from them after `since` (YYYY-MM-DD HH:MM): a Replies row for a message they
// sent, or their Contacts row's last_contact. Returns the date, or ''.
export function repliedSince(email, since, replies, contacts) {
  const e = low(email);
  let first = '';
  for (const r of replies || []) {
    if (low(r.to) !== e || !str(r.message_id) || r.type === ORG_TYPE) continue;
    const at = str(r.created_at);
    if (at > since && (!first || at < first)) first = at;
  }
  if (first) return first.slice(0, 10);
  for (const c of contacts || []) {
    const all = [c.email, ...str(c.other_emails).split(',')].map(low);
    if (all.includes(e) && isDay(c.last_contact) && str(c.last_contact) >= since.slice(0, 10)) return str(c.last_contact);
  }
  return '';
}

// One organisation's state today: { state, why, check?, chase? }.
export function orgState(org, { replies = [], contacts = [], orgRow = null, today }) {
  if (!org.email) return { state: 'noemail', why: 'No email: check by phone or their website' };
  const next = low(orgRow && orgRow.next_check);
  if (next === 'never') return { state: 'held', why: 'Set to never' };
  if (isDay(next) && next > today) return { state: 'held', why: `Done or snoozed until ${next}` };
  const rows = rowsFor(org.id, replies);
  if (rows.some((r) => low(r.status) === 'awaiting')) return { state: 'draft', why: 'A draft is waiting for you' };
  const check = rows.find((r) => !isChase(r) && SENT.includes(low(r.status)));
  if (!check || daysBetween(sentDay(check), today) >= CYCLE_DAYS) {
    return { state: 'due', why: check ? `Last checked ${sentDay(check)}` : 'Not checked yet' };
  }
  const since = str(check.sent_at || check.created_at);
  const chase = rows.find((r) => isChase(r) && SENT.includes(low(r.status)) && str(r.created_at) >= str(check.created_at));
  const replied = repliedSince(org.email, since, replies, contacts);
  if (replied) return { state: 'replied', why: `Checked ${sentDay(check)}; they emailed ${replied}`, check, chase };
  if (chase) {
    const gone = daysBetween(sentDay(chase), today);
    return gone >= CHASE_DAYS
      ? { state: 'noreply', why: `Checked ${sentDay(check)}, chased ${sentDay(chase)}, no reply: taken as all fine`, check, chase }
      : { state: 'chased', why: `Checked ${sentDay(check)}, chased ${sentDay(chase)}`, check, chase };
  }
  return daysBetween(sentDay(check), today) >= CHASE_DAYS
    ? { state: 'chase', why: `Checked ${sentDay(check)}, no reply yet: a chaser is due`, check }
    : { state: 'waiting', why: `Checked ${sentDay(check)}`, check };
}

// Organisation drafts made today (any status).
export function dayCount(replies, today) {
  return (replies || []).filter((r) => r.type === ORG_TYPE && codes(r).some((c) => /^org_(check|chase)_/.test(c))
    && str(r.created_at).slice(0, 10) === today).length;
}

// The panel's Organisations view: { today, count, cap, hasTab, lists: { state: [entry] } }.
// entry: { id, name, email, page, pageName, pageUrl, shown, state, why, next_check }.
export function orgLists(orgs, { replies = [], contacts = [], orgRows = [], hasTab = false, today }) {
  const byId = new Map((orgRows || []).map((r) => [str(r.id), r]));
  const lists = { due: [], chase: [], draft: [], waiting: [], chased: [], replied: [], noreply: [], held: [], noemail: [] };
  for (const o of orgs) {
    const orgRow = byId.get(o.id) || null;
    const s = orgState(o, { replies, contacts, orgRow, today });
    lists[s.state].push({ ...o, state: s.state, why: s.why, next_check: str(orgRow && orgRow.next_check), hasRow: !!orgRow });
  }
  return { today, count: dayCount(replies, today), cap: DAY_CAP, hasTab, lists };
}

// Draft check / Draft chaser from the panel: { ok, kind: check|chase } or { error, status }.
export function planOrgCheck(org, ctx) {
  if (!org) return { error: 'No such organisation: reload the page', status: 404 };
  const s = orgState(org, ctx);
  if (s.state !== 'due' && s.state !== 'chase') return { error: `Not drafted: ${s.why.charAt(0).toLowerCase()}${s.why.slice(1)}`, status: 409 };
  if (dayCount(ctx.replies, ctx.today) >= DAY_CAP) return { error: `Not drafted: ${DAY_CAP} organisation drafts already today`, status: 429 };
  return { ok: true, kind: s.state === 'chase' ? 'chase' : 'check' };
}

// Done / Snooze / Never / Clear: the next_check value, or { error }.
export function planNext(value) {
  const v = low(value);
  if (v === '' || v === 'never' || isDay(v)) return { value: v };
  return { error: 'Next check: a date (YYYY-MM-DD), never, or blank' };
}
