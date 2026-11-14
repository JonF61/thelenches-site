// worker/src/admin/orgoutreach.mjs (.mjs so scripts/outreach can import it)
// Organisation outreach (27 Oct 2026): once a year Holly asks each organisation the site lists
// to check its entry. The list is src/_data/contacts.json `outreach` (orgEntries resolves each
// one's details from contacts.json, council.json, schools.json, health.json, transport.json);
// what has happened is worked out from the Replies tab on each load, and the Org outreach tab
// (id, next_check, notes, other_emails; made by the panel on its first write) holds Jon's
// choices. Pure: no Google, GitHub or Claude calls. Used by the panel (Contacts >
// Organisations) and scripts/outreach/orgs.js, so both apply the same rules.
// Each organisation is in one state:
//   noemail  no address to write to (check by phone or their website)
//   held     Org outreach next_check "never", or a date still to come (Done or Snooze)
//   draft    a check or chaser draft is waiting for Jon's Approve
//   due      never checked, or the last check went CYCLE_DAYS or more ago
// An organisation's addresses (addressesFor): its outreach email, the Org outreach tab's
// other_emails (typed by Jon, private), and those on Contacts rows whose organisation is its name.
//   regular  would be due, or held by a Done / Snooze date, but they emailed us in the last
//            REGULAR_DAYS (Gmail from: search, or their Contacts row's last_contact): no check
//            needed; it lapses 3 months after their last email (Jon, 27 Oct)
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
export const ORG_HEADERS = ['id', 'next_check', 'notes', 'other_emails', 'email', 'email_source', 'confirmed'];
export const ORG_TYPE = 'outreach';
export const CHASE_DAYS = 21;
export const CYCLE_DAYS = 365;
export const DAY_CAP = 25; // Jon, 5 Nov (was 10)
export const REGULAR_DAYS = 91;
export const SUBJECT = 'Your entry on thelenches.org.uk';
export const LISTING_SUBJECT = 'Your listing on thelenches.org.uk';
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
  '/living-here/trades/': 'Local trades',
  '/living-here/eat/': 'Where to eat',
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

// Listings (5 Nov, Jon): every Local trades and Where to eat entry gets the same yearly check,
// with its own wording (templates.md listing_check / listing_chase). Ids are "trade-<id>" /
// "eat-<id>" (lib/listings.js anchorFor, so the link goes to the card itself). The address is
// the entry's own public email, else the Org outreach tab's `email` cell (found on their
// website by scripts/listingcontacts, or typed by Jon in the panel; private).
// data: { trades, eat } (src/_data trades.json, eat.json).
export function listingEntries(data) {
  const { trades = {}, eat = {} } = data || {};
  const out = [];
  const web = (w) => str(w && w.url);
  for (const t of trades.trades || []) {
    if (!t || !t.id) continue;
    out.push({
      id: `trade-${t.id}`, listing: 'trades', name: str(t.name), email: low(t.email), greet: firstWord(t.contact),
      page: '/living-here/trades/', pageName: PAGE_NAMES['/living-here/trades/'], pageUrl: `${SITE}/living-here/trades/#trade-${t.id}`,
      website: web(t.website),
      shown: [
        str(t.trade), str(t.what), t.covers ? `Covers: ${str(t.covers)}` : '', t.base ? `Based: ${str(t.base)}` : '',
        t.contact ? `Contact: ${str(t.contact)}` : '', [str(t.phone), str(t.phone2)].filter(Boolean).join(' or '),
        str(t.email), str(t.other), web(t.website),
      ].filter(Boolean),
    });
  }
  for (const p of eat.places || []) {
    if (!p || !p.id) continue;
    const tags = [p.garden ? 'Garden' : '', p.children ? 'Children welcome' : '', p.dogs ? 'Dogs welcome' : ''].filter(Boolean).join(', ');
    out.push({
      id: `eat-${p.id}`, listing: 'eat', name: str(p.name), email: low(p.email), greet: '',
      page: '/living-here/eat/', pageName: PAGE_NAMES['/living-here/eat/'], pageUrl: `${SITE}/living-here/eat/#eat-${p.id}`,
      website: web(p.website),
      shown: [str(p.where), str(p.type), str(p.food), str(p.note), tags, str(p.phone), web(p.website)].filter(Boolean),
    });
  }
  return out;
}

// The address Holly writes to: the entry's own, else the Org outreach tab's email cell
// (listings only: an organisation's address always comes from the repo).
export function emailOf(org, orgRow) {
  if (org.email) return org.email;
  if (!org.listing) return '';
  const e = low(orgRow && orgRow.email);
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : '';
}

// Email for a listing from the panel: { value } (lower case) or { error }. Blank clears it.
export function planListingEmail(value) {
  const v = low(value);
  if (v && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)) return { error: `Not an email address: ${str(value)}` };
  return { value: v };
}

// This organisation's outreach rows in Replies, newest first.
export function rowsFor(id, replies) {
  return (replies || []).filter((r) => r.type === ORG_TYPE
    && (codes(r).includes(`org_check_${id}`) || codes(r).includes(`org_chase_${id}`)))
    .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
}
const isChase = (r) => codes(r).some((c) => c.startsWith('org_chase_'));
const sentDay = (r) => str(r.sent_at || r.created_at).slice(0, 10);

// Contacts organisation names compared loosely: lower case, no "(...)", "the", punctuation.
const normName = (v) => low(v).replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/\bthe\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const splitEmails = (v) => str(v).split(/[\s,;]+/).map(low).filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e));

// Every address that counts as this organisation (lower case): its outreach email, the Org
// outreach tab's other_emails, and the addresses on any Contacts row (not ignore) whose
// organisation is its name (the same, or the name plus more words, e.g. "Lenches Club
// committee"; never the other way round, so "Church Lench" is not the village hall).
// Own domains (5 Nov, Jon: a school's head replied from head@ when the check went to office@):
// when `domains` (from domainCounts) is given, the domain of the organisation's own addresses
// also counts, as "@domain", if it is not free mail and no other listed organisation uses it
// (so nhs.net or a shared council domain never does). Contacts-derived addresses never add one.
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'live.co.uk',
  'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.co.uk', 'btinternet.com',
  'btopenworld.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'blueyonder.co.uk', 'ntlworld.com', 'tiscali.co.uk', 'plus.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.co.uk', 'mail.com', 'zoho.com', 'fastmail.com', 'nhs.net', 'nhs.uk']);
const domainOf = (e) => low(e).split('@')[1] || '';
const ownAddresses = (org, orgRow) => [emailOf(org, orgRow), ...splitEmails(orgRow && orgRow.other_emails)].filter(Boolean).map(low);

// domain -> how many listed organisations use it (each counted once).
export function domainCounts(orgs, orgRows) {
  const byId = new Map((orgRows || []).map((r) => [str(r.id), r]));
  const counts = new Map();
  for (const o of orgs || []) {
    for (const d of new Set(ownAddresses(o, byId.get(o.id) || null).map(domainOf).filter(Boolean))) counts.set(d, (counts.get(d) || 0) + 1);
  }
  return counts;
}

// True if `address` is one of `mine` or at one of its "@domain" entries.
export function isTheirs(mine, address) {
  const a = low(address);
  return !!a && (mine.has(a) || mine.has(`@${domainOf(a)}`));
}

export function addressesFor(org, orgRow, contacts, domains = null) {
  const out = new Set(ownAddresses(org, orgRow));
  if (domains) {
    for (const d of new Set([...out].map(domainOf))) {
      if (d && !FREE_MAIL.has(d) && (domains.get(d) || 0) <= 1) out.add(`@${d}`);
    }
  }
  const names = [normName(org.name)].filter((n) => n.length >= 4);
  for (const c of contacts || []) {
    if (low(c.status) === 'ignore') continue;
    const cn = normName(c.organisation);
    if (!cn || !names.some((n) => cn === n || ` ${cn} `.includes(` ${n} `))) continue;
    for (const e of [low(c.email), ...splitEmails(c.other_emails)]) if (e) out.add(e);
  }
  return [...out];
}

const contactAddresses = (c) => [low(c.email), ...splitEmails(c.other_emails)];

// The first email from them (any of their addresses) after `since` (YYYY-MM-DD HH:MM): a
// Replies row for a message they sent, or a Contacts row's last_contact. The date, or ''.
export function repliedSince(addresses, since, replies, contacts) {
  const mine = new Set([].concat(addresses).map(low));
  let first = '';
  for (const r of replies || []) {
    if (!isTheirs(mine, r.to) || !str(r.message_id) || r.type === ORG_TYPE) continue;
    const at = str(r.created_at);
    if (at > since && (!first || at < first)) first = at;
  }
  if (first) return first.slice(0, 10);
  for (const c of contacts || []) {
    if (contactAddresses(c).some((e) => isTheirs(mine, e)) && isDay(c.last_contact) && str(c.last_contact) >= since.slice(0, 10)) return str(c.last_contact);
  }
  return '';
}

// True if a Contacts row for any of their addresses shows mail in the last REGULAR_DAYS.
export function contactRecent(addresses, contacts, today) {
  const mine = new Set([].concat(addresses).map(low));
  return (contacts || []).some((c) => contactAddresses(c).some((e) => isTheirs(mine, e))
    && isDay(c.last_contact) && daysBetween(str(c.last_contact), today) <= REGULAR_DAYS);
}

// The Gmail search that finds their recent mail from any address (at most 20).
export function recentQuery(addresses) {
  const list = [...new Set([].concat(addresses).map(low).filter(Boolean))].slice(0, 20);
  const term = (e) => `from:${e.startsWith('@') ? e.slice(1) : e}`; // "@domain" -> from:domain
  const from = list.length === 1 ? term(list[0]) : `{${list.map(term).join(' ')}}`;
  return `${from} newer_than:${REGULAR_DAYS}d`;
}

// A year on from a day (as the panel's Done sets next_check).
export const yearOn = (d) => {
  const t = new Date(ms(d));
  t.setUTCMonth(t.getUTCMonth() + 12);
  return t.toISOString().slice(0, 10);
};

// Held by a date: "Confirmed <day> · next check <day>" when Done set it (the Org outreach
// `confirmed` cell, 5 Nov, and next_check a year on from it), else "Done or snoozed until".
function heldWhy(next, orgRow) {
  const c = str(orgRow && orgRow.confirmed);
  return isDay(c) && yearOn(c) === next ? `Confirmed ${c} · next check ${next}` : `Done or snoozed until ${next}`;
}

// One organisation's state today: { state, why, check?, chase? }. recent: ids of organisations
// that emailed us in the last REGULAR_DAYS (Gmail, any of their addresses), or null.
export function orgState(org, { replies = [], contacts = [], orgRow = null, today, recent = null, domains = null }) {
  if (!emailOf(org, orgRow)) {
    return { state: 'noemail', why: org.listing
      ? (org.website && !/facebook\.com/i.test(org.website) ? 'No email found yet: type one below, or check by phone' : 'No email: type one below, or check by phone or Facebook')
      : 'No email: check by phone or their website' };
  }
  const next = low(orgRow && orgRow.next_check);
  if (next === 'never') return { state: 'held', why: 'Set to never' };
  const addresses = addressesFor(org, orgRow, contacts, domains);
  const regular = (recent && recent.has(org.id)) || contactRecent(addresses, contacts, today);
  const REGULAR = { state: 'regular', why: 'Emailed us in the last 3 months: no check needed' };
  if (isDay(next) && next > today) {
    // A date set by Done or by hand still shows (5 Nov, Jon: the hall's 15 January was invisible).
    return regular ? { ...REGULAR, why: `${REGULAR.why} · next check ${next}` } : { state: 'held', why: heldWhy(next, orgRow) };
  }
  const rows = rowsFor(org.id, replies);
  if (rows.some((r) => low(r.status) === 'awaiting')) return { state: 'draft', why: 'A draft is waiting for you' };
  const check = rows.find((r) => !isChase(r) && SENT.includes(low(r.status)));
  if (!check || daysBetween(sentDay(check), today) >= CYCLE_DAYS) {
    if (regular) return REGULAR;
    return { state: 'due', why: check ? `Last checked ${sentDay(check)}` : 'Not checked yet' };
  }
  const since = str(check.sent_at || check.created_at);
  const chase = rows.find((r) => isChase(r) && SENT.includes(low(r.status)) && str(r.created_at) >= str(check.created_at));
  const replied = repliedSince(addresses, since, replies, contacts);
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
export function orgLists(orgs, { replies = [], contacts = [], orgRows = [], hasTab = false, today, recent = null }) {
  const byId = new Map((orgRows || []).map((r) => [str(r.id), r]));
  const lists = { due: [], chase: [], draft: [], waiting: [], chased: [], replied: [], noreply: [], held: [], regular: [], noemail: [] };
  const domains = domainCounts(orgs, orgRows);
  for (const o of orgs) {
    const orgRow = byId.get(o.id) || null;
    const s = orgState(o, { replies, contacts, orgRow, today, recent, domains });
    lists[s.state].push({ ...o, email: emailOf(o, orgRow), email_cell: str(orgRow && orgRow.email), email_source: str(orgRow && orgRow.email_source), state: s.state, why: s.why, next_check: str(orgRow && orgRow.next_check), confirmed: str(orgRow && orgRow.confirmed), hasRow: !!orgRow,
      other_emails: str(orgRow && orgRow.other_emails), addresses: addressesFor(o, orgRow, contacts).length,
      domains: addressesFor(o, orgRow, contacts, domains).filter((a) => a.startsWith('@')).map((a) => a.slice(1)) });
  }
  return { today, count: dayCount(replies, today), cap: DAY_CAP, hasTab, lists };
}

// Those to look up in Gmail (would otherwise be due, or held by a date, today):
// [{ id, addresses }].
// Listings are left out (5 Nov): one Gmail search each took the panel past the Worker's
// subrequest limit; their regular contact comes from their Contacts row only.
export function dueOrgs(orgs, { replies = [], contacts = [], orgRows = [], today }) {
  const byId = new Map((orgRows || []).map((r) => [str(r.id), r]));
  const domains = domainCounts(orgs, orgRows);
  return orgs.filter((o) => {
    if (o.listing) return false;
    const orgRow = byId.get(o.id) || null;
    const { state } = orgState(o, { replies, contacts, orgRow, today, domains });
    return state === 'due' || (state === 'held' && low(orgRow && orgRow.next_check) !== 'never');
  }).map((o) => ({ id: o.id, addresses: addressesFor(o, byId.get(o.id) || null, contacts, domains) }));
}

// Draft check / Draft chaser from the panel: { ok, kind: check|chase } or { error, status }.
export function planOrgCheck(org, ctx) {
  if (!org) return { error: 'No such organisation: reload the page', status: 404 };
  const s = orgState(org, ctx);
  if (s.state !== 'due' && s.state !== 'chase') return { error: `Not drafted: ${s.why.charAt(0).toLowerCase()}${s.why.slice(1)}`, status: 409 };
  if (dayCount(ctx.replies, ctx.today) >= DAY_CAP) return { error: `Not drafted: ${DAY_CAP} organisation drafts already today`, status: 429 };
  return { ok: true, kind: s.state === 'chase' ? 'chase' : 'check' };
}

// Other addresses from the panel: { value } (lower case, comma separated) or { error }.
export function planOtherEmails(value) {
  const parts = str(value).split(/[\s,;]+/).filter(Boolean);
  const bad = parts.find((e) => !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e));
  if (bad) return { error: `Not an email address: ${bad}` };
  if (parts.length > 20) return { error: 'At most 20 other addresses' };
  return { value: [...new Set(parts.map(low))].join(', ') };
}

// Done / Snooze / Never / Clear: the next_check value, or { error }.
export function planNext(value) {
  const v = low(value);
  if (v === '' || v === 'never' || isDay(v)) return { value: v };
  return { error: 'Next check: a date (YYYY-MM-DD), never, or blank' };
}
