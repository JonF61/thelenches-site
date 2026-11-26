// "This weekend" page (SEO step 4, 26 Nov 2026; plan agreed with Jon): /events/this-weekend/ lists
// the one-off events from Friday evening to Sunday. Monday to Thursday it shows the coming weekend;
// Friday to Sunday the current one. The site rebuilds every night (Worker NIGHTLY_CRON 00:10 UK),
// so the page moves on by itself. On while site.json has "thisWeekend": true.
//   weekendFor(today)        { fri, sat, sun } as YYYY-MM-DD
//   weekendEvents(list, today)  events in that weekend still to come, by date then time
// Friday counts from 5pm: a Friday event with no clear time, or starting earlier, is left out.
// A multi-day event counts when its days touch the weekend.
'use strict';

const { startTime } = require('./ics.js');

const day = (v) => String(v || '').slice(0, 10);
const FRIDAY_EVENING = 17 * 60;

function addDays(iso, n) {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
// 0 = Sunday .. 6 = Saturday, for a calendar date.
const dow = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

function weekendFor(today) {
  const d = dow(today);
  // Fri 5, Sat 6, Sun 0 → this weekend's Friday; Mon–Thu → the coming Friday.
  const back = d === 5 ? 0 : d === 6 ? 1 : d === 0 ? 2 : null;
  const fri = back !== null ? addDays(today, -back) : addDays(today, 5 - d);
  return { fri, sat: addDays(fri, 1), sun: addDays(fri, 2) };
}

const startOf = (e) => {
  if (e.endDate && day(e.endDate) !== day(e.date)) return null;
  const t = startTime(e.body);
  return t ? t.start : null;
};

function inWeekend(e, w) {
  const start = day(e.date);
  const end = day(e.endDate) || start;
  if (end < w.fri || start > w.sun) return false;
  if (start === end && start === w.fri) {
    const t = startOf(e);
    return t !== null && t >= FRIDAY_EVENING;
  }
  return true;
}

// The weekend's events still to come (ended ones dropped), one per date+title, soonest first,
// then by start time (all-day first), then title.
function weekendEvents(events, today) {
  const w = weekendFor(today);
  const seen = new Set();
  return (events || [])
    .filter((e) => e && e.title && /^\d{4}-\d{2}-\d{2}$/.test(day(e.date)))
    .filter((e) => (day(e.endDate) || day(e.date)) >= today && inWeekend(e, w))
    .filter((e) => { const k = `${day(e.date)}|${String(e.title).trim().toLowerCase()}`; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => {
      const da = day(a.date) < w.fri ? w.fri : day(a.date);
      const db = day(b.date) < w.fri ? w.fri : day(b.date);
      return da.localeCompare(db) || (startOf(a) ?? -1) - (startOf(b) ?? -1) || String(a.title).localeCompare(String(b.title));
    });
}

// Group for the page: [{ label: "Friday evening" | "Saturday" | "Sunday", items }].
// A multi-day event that started before the weekend goes under the weekend's first day it touches.
function weekendGroups(events, today) {
  const w = weekendFor(today);
  const label = (e) => {
    const s = day(e.date) < w.fri ? w.fri : day(e.date);
    return s === w.fri ? 'Friday evening' : s === w.sat ? 'Saturday' : 'Sunday';
  };
  const groups = [];
  for (const e of weekendEvents(events, today)) {
    const l = label(e);
    const g = groups.find((x) => x.label === l);
    if (g) g.items.push(e); else groups.push({ label: l, items: [e] });
  }
  return groups;
}

module.exports = { weekendFor, weekendEvents, weekendGroups, FRIDAY_EVENING };
