// Hand-written site items, one small JSON file each (replaced src/_data/whatson.json, 21 Oct 2026):
//   src/items/events/YYYY-MM-DD-slug.json   one event
//   src/items/notices/slug.json             one notice
//   src/items/bin-and-footnote.json         { bin, eventsFootnote (retired 28 Oct: now regulars) }
//   src/items/regulars.json                 { regulars: [{ day, time, what, where, note?, link?, until?, ... }] }
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

const ITEMS = path.join(__dirname, '..', 'src', 'items');

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

const eventShown = (e, today) => (day(e.endDate) || day(e.date)) >= today;
const noticeShown = (n, today) => !day(n.expires) || day(n.expires) > today;

// { all: true } keeps hidden items (e.g. publish.js making JPEG copies)
function loadWhatson({ dir = ITEMS, today = ukToday(), all = false } = {}) {
  const general = fs.existsSync(path.join(dir, 'bin-and-footnote.json'))
    ? readItem(path.join(dir, 'bin-and-footnote.json')) : {};

  const events = readFolder(path.join(dir, 'events'))
    .map((x) => x.item)
    .filter((e) => all || eventShown(e, today))
    .sort((a, b) => day(a.date).localeCompare(day(b.date)) || String(a.title || '').localeCompare(String(b.title || '')));

  const rank = (n) => (Number.isFinite(n.item.order) ? n.item.order : Infinity);
  const notices = readFolder(path.join(dir, 'notices'))
    .filter((x) => all || noticeShown(x.item, today))
    .sort((a, b) => (rank(a) - rank(b)) || a.file.localeCompare(b.file))
    .map((x) => x.item);

  const regFile = fs.existsSync(path.join(dir, 'regulars.json')) ? readItem(path.join(dir, 'regulars.json')) : {};
  const current = (r) => all || !r.until || r.until >= today;
  // regulars: the short list (Events page, newsletter): a known day and not taking a break.
  // regularsPage: every current entry for /regulars/, day unknown ones last.
  const regulars = sortRegulars(regFile.regulars)
    .filter((r) => current(r) && (all || !r.pausedUntil || r.pausedUntil <= today));
  const regularsPage = sortRegulars(regFile.regulars, { anyDay: true }).filter(current);

  return { bin: general.bin || {}, events, notices, regulars, regularsPage, eventsFootnote: general.eventsFootnote || '' };
}

// Weekly regulars (src/items/regulars.json): day order from Monday, then start time
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
// the newsletter line and the sort).
const PAGE_FIELDS = ['frequency', 'about', 'runBy', 'phone', 'email', 'forWho', 'cost', 'booking', 'bring', 'checked'];
function normaliseRegular(r) {
  const out = { day: s(r.day), time: s(r.time), what: s(r.what), where: s(r.where), note: s(r.note), until: day(r.until),
    link: linkOf(r.link) };
  for (const k of PAGE_FIELDS) out[k] = s(r[k]);
  out.pausedUntil = day(r.pausedUntil);
  out.website = linkOf(r.website);
  out.image = r.image && s(r.image.url) ? { url: s(r.image.url), alt: s(r.image.alt) } : null;
  out.tile = s(r.tile);
  out.detailsElsewhere = r.detailsElsewhere === true;
  out.sessions = (Array.isArray(r.sessions) ? r.sessions : []).map((x) => ({ time: s(x && x.time), where: s(x && x.where) })).filter((x) => x.time || x.where);
  return out;
}
const dayRank = (d) => (WEEK.includes(d) ? WEEK.indexOf(d) : WEEK.length);
function sortRegulars(list, { anyDay = false } = {}) {
  return (Array.isArray(list) ? list : [])
    .map(normaliseRegular)
    .filter((r) => (anyDay || WEEK.includes(r.day)) && r.what)
    .sort((a, b) => dayRank(a.day) - dayRank(b.day) || startMinutes(a.time) - startMinutes(b.time) || a.what.localeCompare(b.what));
}

module.exports = { loadWhatson, ukToday, ITEMS, sortRegulars, startMinutes, WEEK };
