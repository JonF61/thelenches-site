// lib/comingup.js
// Events and road works coming up, for the admin panel's Summary page ("Coming up this
// week" and the next newsletter's event count). Run at the end of every build (.eleventy.js,
// eleventy.after) and written to _site/coming-up.json:
//   { generated: "YYYY-MM-DD", events: [{ date, end, title, village, url }],
//     roads: [{ start, end, title, village, url }] }  (url: the item on /events/, or the Roads page)
// Only what the Events, Notices and Roads pages already show: hand-written items
// (lib/whatson.js) and approved pipeline items (src/_data/pipeline.json). Kept are items
// that are on or after the day before the build and start within DAYS of it; the Worker
// picks out its own week (the nightly rebuild keeps the file current).
'use strict';

const { anchorUrl } = require('./anchors.js');
const { isRoad } = require('./roads.js');

const DAYS = 31;
const ROADS_URL = 'https://thelenches.org.uk/living-here/roads/';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => String(v ?? '').trim();
const day = (v) => (DAY.test(str(v).slice(0, 10)) ? str(v).slice(0, 10) : '');
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Hand-written expires is the first day hidden; pipeline expires is the last day shown.
const lastShown = (item, handWritten) => {
  const e = day(item.expires);
  return e && handWritten ? addDays(e, -1) : e;
};

function comingUp({ whatson, pipeline }, today) {
  const from = addDays(today, -1);
  const to = addDays(today, DAYS);
  const keep = (start, end) => start && start <= to && (end || start) >= from;
  const events = [];
  const roads = [];
  const seen = new Set();
  for (const list of [(whatson && whatson.events) || [], (pipeline && pipeline.events) || []]) {
    for (const e of list) {
      const date = day(e.date);
      const end = day(e.endDate) > date ? day(e.endDate) : '';
      if (!str(e.title) || !keep(date, end)) continue;
      // The same event hand-written and from the pipeline: once.
      const k = `${date}|${str(e.title).toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      events.push({ date, end, title: str(e.title), village: str(e.village), url: anchorUrl('event', { title: e.title, date }) });
    }
  }
  const notices = [
    [(whatson && whatson.notices) || [], true],
    [(pipeline && pipeline.notices) || [], false],
  ];
  for (const [list, hand] of notices) {
    for (const n of list) {
      if (!isRoad(n) || !str(n.title)) continue;
      const start = day(n.start) || day(n.date) || from;
      const end = day(n.end) || lastShown(n, hand);
      if (!keep(start, end)) continue;
      roads.push({ start, end, title: str(n.title), village: str(n.village), url: ROADS_URL });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  roads.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return { generated: today, events, roads };
}

module.exports = { comingUp, DAYS };
