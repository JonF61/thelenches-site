// Hand-written site items, one small JSON file each (replaced src/_data/whatson.json, 21 Oct 2026):
//   src/items/events/YYYY-MM-DD-slug.json   one event
//   src/items/notices/slug.json             one notice
//   src/items/bin-and-footnote.json         { bin, eventsFootnote }
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

  return { bin: general.bin || {}, events, notices, eventsFootnote: general.eventsFootnote || '' };
}

module.exports = { loadWhatson, ukToday, ITEMS };
