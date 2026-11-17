// Hand-written site items, one small JSON file each (replaced sites/<site>/_data/whatson.json, 21 Oct 2026):
// Shared across sites (17 Nov 2026, Jon: the villages are within walking distance, so one audience):
// every site shows every site's hand-written events, notices and regular activities, unless an
// item's optional "sites" field names only some ("lenches", "harvington", "both"; comma separated).
// Single-site exceptions (Jon, 17 Nov): parish council news and other official notices for one
// parish, roadworks on lanes only one village uses, and residents-only or members-only items.
// Another site's items carry no _entry key (edit them on their own site) and a non-enumerable
// _site; bin-and-footnote.json stays per site. An item in both folders (same list, date and
// title; regulars: same day, time and what) is shown once, this site's copy winning.
//   sites/<site>/items/events/YYYY-MM-DD-slug.json   one event
//   sites/<site>/items/notices/slug.json             one notice
//   sites/<site>/items/bin-and-footnote.json         { bin, eventsFootnote (retired 28 Oct: now regulars) }
//   sites/<site>/items/regulars.json                 { regulars: [{ day, time, what, where, note?, link?, until?, ... }] }
//                                           (the Regular activities page fields: see normaliseRegular)
// loadWhatson() assembles them into the old whatson.json shape { bin, events, notices,
// eventsFootnote }, so items keep their identity (anchors, newsletter keys).
// Used by src/_data/whatson.js (Eleventy), scripts/newsletter, scripts/publish and
// scripts/eventimages.
//
// Expiry (UK date, so the nightly rebuild drops items at midnight):
//   events   hidden once "endDate" (multi-day events), else "date", is before today
//   notices  hidden from their "expires" date on; no "expires" means shown until deleted
// Hidden items' files stay in place; delete a file to remove the item for good.
// Order: events by date then title; notices by "order" (lowest first; none = last),
// then file name.
'use strict';

const fs = require('fs');
const path = require('path');

const { siteDir, SITE, SITES, ROOT } = require('./site.js');

const ITEMS = siteDir('items');
const itemsDirFor = (site) => path.join(ROOT, 'sites', site, 'items');

// Today in Europe/London as YYYY-MM-DD (same as .eleventy.js)
const ukToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const day = (v) => String(v || '').slice(0, 10);

function readItem(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Can't read ${path.relative(path.join(ITEMS, '..', '..'), file)}: ${err.message}`);
  }
}

// [{ file, item }] for every .json file in a folder, in file-name order
function readFolder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, item: readItem(path.join(dir, f)) }));
}

// Edit page / Newsletter draft "edit everything" (4 Nov): each item carries its source key as in
// scripts/rimmer/fix.js sources() (h:events/<file>, h:notices/<file>, r:<index in regulars.json>),
// as a non-enumerable _entry, so it never reaches JSON (snapshots, hashes, coming-up.json).
const tagEntry = (o, key) => (o && typeof o === 'object' ? Object.defineProperty(o, '_entry', { value: key, enumerable: false, configurable: true }) : o);
const entryKeyOf = (o) => (o && typeof o._entry === 'string' ? o._entry : '');

// Which sites an item is for: its "sites" field (blank = every site). A value naming no known
// site stops the build rather than sharing (or hiding) the item by mistake.
function sitesFor(item, where) {
  const v = String((item && item.sites) || '').trim().toLowerCase();
  if (!v || v === 'both' || v === 'all') return [...SITES];
  const names = v.split(/[\s,]+/).filter(Boolean);
  const bad = names.filter((n) => !SITES.includes(n));
  if (bad.length) throw new Error(`${where}: "sites" must be ${SITES.join(', ')} or both (got "${item.sites}")`);
  return names;
}
const markSite = (o, site) => (o && typeof o === 'object' ? Object.defineProperty(o, '_site', { value: site, enumerable: false, configurable: true }) : o);
const siteOf = (o) => (o && typeof o._site === 'string' ? o._site : '');

const eventShown = (e, today) => (day(e.endDate) || day(e.date)) >= today;
const noticeShown = (n, today) => !day(n.expires) || day(n.expires) > today;

// { all: true } keeps hidden items (e.g. publish.js making JPEG copies)
// { shared: false } reads only `dir` (tests); by default the real items folder also takes in every
// other site's items (see the top of this file). `site` is the site the list is for.
function loadWhatson({ site = SITE, dir = itemsDirFor(site), today = ukToday(), all = false, shared = path.resolve(dir) === path.resolve(itemsDirFor(site)) } = {}) {
  const general = fs.existsSync(path.join(dir, 'bin-and-footnote.json'))
    ? readItem(path.join(dir, 'bin-and-footnote.json')) : {};

  // [{ dir, site, own }]: this site's folder first, so its copy of a shared item wins.
  const sources = [{ dir, site, own: true }];
  if (shared) for (const other of SITES) if (other !== site) sources.push({ dir: itemsDirFor(other), site: other, own: false });
  const forHere = (x, src, label) => sitesFor(x.item, `${src.site}/items/${label}`).includes(site);

  const eventList = [];
  const seenEvents = new Set();
  for (const src of sources) {
    for (const x of readFolder(path.join(src.dir, 'events'))) {
      if (!forHere(x, src, `events/${x.file}`)) continue;
      const k = `${day(x.item.date)}|${String(x.item.title || '').trim().toLowerCase()}`;
      if (seenEvents.has(k)) continue;
      seenEvents.add(k);
      eventList.push(src.own ? tagEntry(x.item, `h:events/${x.file}`) : markSite(x.item, src.site));
    }
  }
  const events = eventList
    .filter((e) => all || eventShown(e, today))
    .sort((a, b) => day(a.date).localeCompare(day(b.date)) || String(a.title || '').localeCompare(String(b.title || '')));

  const rank = (n) => (Number.isFinite(n.item.order) ? n.item.order : Infinity);
  const noticeList = [];
  const seenNotices = new Set();
  for (const src of sources) {
    for (const x of readFolder(path.join(src.dir, 'notices'))) {
      if (!forHere(x, src, `notices/${x.file}`)) continue;
      const k = String(x.item.title || '').trim().toLowerCase();
      if (seenNotices.has(k)) continue;
      seenNotices.add(k);
      noticeList.push({ ...x, src });
    }
  }
  const notices = noticeList
    .filter((x) => all || noticeShown(x.item, today))
    .sort((a, b) => (rank(a) - rank(b)) || a.file.localeCompare(b.file))
    .map((x) => (x.src.own ? tagEntry(x.item, `h:notices/${x.file}`) : markSite(x.item, x.src.site)));

  // Regular activities: this site's entries keep their r:<index> key; another site's are marked.
  const regList = [];
  const seenRegs = new Set();
  for (const src of sources) {
    const file = path.join(src.dir, 'regulars.json');
    const list = fs.existsSync(file) ? (readItem(file).regulars || []) : [];
    (Array.isArray(list) ? list : []).forEach((r, i) => {
      if (!r || !sitesFor(r, `${src.site}/items/regulars.json #${i + 1}`).includes(site)) return;
      const n = normaliseRegular(r, src.own ? i : undefined);
      const k = `${n.day}|${n.time}|${n.what}`.toLowerCase();
      if (seenRegs.has(k)) return;
      seenRegs.add(k);
      regList.push(src.own ? n : markSite(n, src.site));
    });
  }
  const current = (r) => all || !r.until || r.until >= today;
  // regulars: the short list (Events page, newsletter): a known day and not taking a break.
  // regularsPage: every current entry for /regulars/, day unknown ones last.
  const regulars = sortRegulars(regList, { normalised: true })
    .filter((r) => current(r) && (all || !r.pausedUntil || r.pausedUntil <= today));
  const regularsPage = sortRegulars(regList, { anyDay: true, normalised: true }).filter(current);

  return { bin: general.bin || {}, events, notices, regulars, regularsPage, eventsFootnote: general.eventsFootnote || '' };
}

// An /images/... file for this site's pages and newsletter: this site's own copy, else another
// site's (a shared item's picture; .eleventy.js copies it into this site's build). Repo path or ''.
function imageFile(rel, site = SITE) {
  const clean = String(rel || '');
  if (!/^\/images\/[\w./-]+$/.test(clean) || clean.includes('..')) return '';
  for (const s of [site, ...SITES.filter((x) => x !== site)]) {
    const f = path.join(ROOT, 'sites', s, clean);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

// Weekly regulars (sites/<site>/items/regulars.json): day order from Monday, then start time
// ("9.45am", "5.30-6.30pm", "7pm"; none = first), then what. Bad entries are left out.
// until (YYYY-MM-DD, optional): the last day shown, e.g. the final session of a block.
// { anyDay: true } keeps entries whose day is blank or not a weekday (sorted last), for /regulars/.
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function startMinutes(time) {
  const t = String(time || '').trim().toLowerCase();
  const m = t.match(/^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)?/);
  if (!m) return -1;
  let h = Number(m[1]) % 12;
  const ampm = m[3] || (t.match(/(am|pm)/) || [])[1] || 'am';
  if (ampm === 'pm') h += 12;
  return h * 60 + Number(m[2] || 0);
}
const s = (v) => String(v ?? '').trim();
const linkOf = (l) => (l && s(l.url) ? { text: s(l.text) || s(l.url), url: s(l.url) } : null);
// Page-only fields (blank = "awaiting info" on /regulars/): frequency (blank = every week),
// about, runBy, phone, email, website {text, url}, forWho, cost, booking, bring,
// image {url, alt}, checked (YYYY-MM: details last confirmed), pausedUntil (YYYY-MM-DD: back
// on this day; left out of the short list until then), detailsElsewhere (true: no detail
// rows, e.g. church services, whose times are on the Churches page), tile (a lib/tiles.js drawing
// for an entry with no image; else picked from what/about), sessions ([{time, where}]: one
// entry held in more than one place; the page shows each on its own line, time/where still feed
// the newsletter line and the sort), added (YYYY-MM-DD: the day we first listed it; the newsletter
// flags it for 14 days) and newActivity (true: the activity itself has just started, not just new
// to our list; Jon 11 Nov).
const PAGE_FIELDS = ['frequency', 'about', 'runBy', 'phone', 'email', 'forWho', 'cost', 'booking', 'bring', 'checked'];
function normaliseRegular(r, i) {
  const out = { day: s(r.day), time: s(r.time), what: s(r.what), where: s(r.where), note: s(r.note), until: day(r.until),
    link: linkOf(r.link) };
  for (const k of PAGE_FIELDS) out[k] = s(r[k]);
  out.pausedUntil = day(r.pausedUntil);
  out.website = linkOf(r.website);
  out.image = r.image && s(r.image.url) ? { url: s(r.image.url), alt: s(r.image.alt) } : null;
  out.tile = s(r.tile);
  out.added = day(r.added);
  out.newActivity = r.newActivity === true;
  out.detailsElsewhere = r.detailsElsewhere === true;
  out.sessions = (Array.isArray(r.sessions) ? r.sessions : []).map((x) => ({ time: s(x && x.time), where: s(x && x.where) })).filter((x) => x.time || x.where);
  return Number.isInteger(i) ? tagEntry(out, `r:${i}`) : out;
}
const dayRank = (d) => (WEEK.includes(d) ? WEEK.indexOf(d) : WEEK.length);
function sortRegulars(list, { anyDay = false, normalised = false } = {}) {
  return (Array.isArray(list) ? list : [])
    .map((r, i) => (normalised ? r : normaliseRegular(r, i)))
    .filter((r) => (anyDay || WEEK.includes(r.day)) && r.what)
    .sort((a, b) => dayRank(a.day) - dayRank(b.day) || startMinutes(a.time) - startMinutes(b.time) || a.what.localeCompare(b.what));
}

module.exports = { loadWhatson, ukToday, ITEMS, sortRegulars, startMinutes, WEEK, entryKeyOf, siteOf, sitesFor, imageFile };
