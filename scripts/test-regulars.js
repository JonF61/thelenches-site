// scripts/test-regulars.js
// Offline test of the Weekly regulars (src/items/regulars.json via lib/whatson.js and the
// newsletter): Monday first, then by time; bad entries left out; own newsletter section,
// one line each; snapshots from before 28 Oct (a footnote string) still render.
// Since 11 Nov: a button with the page's count plus entries listed in the last 14 days, marked
// New activity or Newly listed; snapshots holding the whole list still render it.
// Run: node scripts/test-regulars.js
'use strict';

const assert = require('assert');
const { sortRegulars, startMinutes } = require('../lib/whatson');
const { render } = require('./newsletter/render');
const { select } = require('./newsletter/select');

assert.deepStrictEqual(['9.45am', '5.30-6.30pm', '7-8pm', '10am', '12pm', ''].map(startMinutes), [585, 1050, 1140, 600, 720, -1]);
const sorted = sortRegulars([
  { day: 'Sunday', what: 'Church services', link: { text: 'Churches', url: '/churches/' } },
  { day: 'Wednesday', time: '7-8pm', what: 'Tai chi', where: 'Rous Lench Village Hall' },
  { day: 'Wednesday', time: '10am', what: 'Tai chi', where: 'Abbots Morton' },
  { day: 'Monday', time: '9.45am', what: 'Yoga', added: '2026-10-01' },
  { day: 'Someday', what: 'Bad day' },
  { day: 'Friday', what: '' },
]);
assert.deepStrictEqual(sorted.map((r) => `${r.day} ${r.time}`), ['Monday 9.45am', 'Wednesday 10am', 'Wednesday 7-8pm', 'Sunday ']);

const model = select({
  issueDate: '2026-10-29', pending: [], issues: [], settings: {}, sources: [], jpegFor: () => '', cutoff: '',
  whatson: { events: [], notices: [], regulars: sorted }, bins: {}, siteupdates: { entries: [] }, onthisday: { entries: {} },
});
// 11 Nov: intro, button with the count, nothing recent (Yoga was listed too long ago).
assert.strictEqual(model.regularsCount, 4);
assert.deepStrictEqual(model.regulars, []);
const band = render(model);
assert.ok(band.html.includes('>See all 4 regular activities &rarr;</a>'), 'button');
assert.ok(band.html.includes('href="https://thelenches.org.uk/regulars/"'));
assert.ok(!band.html.includes('>Wednesday<'), 'no day list');
assert.ok(/REGULAR ACTIVITIES\n-+\n\nClasses, clubs and groups[^\n]+\nSee all 4 regular activities: https:\/\/thelenches\.org\.uk\/regulars\/\n\n/.test(band.text), band.text);

// Listed in the last 14 days: new activities first, then newly listed.
const recent = sortRegulars([
  { day: 'Tuesday', time: '7.30pm', what: 'Ukulele group', where: 'Harvington', added: '2026-11-08' },
  { day: 'Wednesday', time: '9.45am', what: 'Pilates', where: 'Church Lench Village Hall', added: '2026-11-08', newActivity: true, cost: '£6' },
  { day: 'Friday', what: 'Too old', added: '2026-10-28' },
  { day: 'Friday', what: 'Future', added: '2026-11-13' },
  { day: 'Monday', what: 'Never dated' },
]);
const m2 = select({ issueDate: '2026-11-12', pending: [], issues: [], settings: {}, sources: [], jpegFor: () => '', cutoff: '',
  whatson: { events: [], notices: [], regulars: recent, regularsPage: [...recent, { day: '', what: 'Lenches Ladies' }] },
  bins: {}, siteupdates: { entries: [] }, onthisday: { entries: {} } });
assert.strictEqual(m2.regularsCount, 6, 'count from the page list');
assert.deepStrictEqual(m2.regulars.map((x) => `${x.fresh} ${x.what}`), ['listed Ukulele group', 'new Pilates']);
const r2 = render(m2);
assert.ok(r2.text.includes('See all 6 regular activities: https://thelenches.org.uk/regulars/\n\nNew activity: Pilates · Wednesday 9.45am · Church Lench Village Hall · More: https://thelenches.org.uk/regulars/#'), r2.text);
assert.ok(r2.text.includes('\nNewly listed: Ukulele group · Tuesday 7.30pm · Harvington\n'), r2.text);
assert.ok(r2.html.indexOf('New activity:') < r2.html.indexOf('Newly listed:'));
// The day the 14 days run out (added 2026-11-08 → last shown in an issue dated 2026-11-21).
const later = (d) => select({ issueDate: d, pending: [], issues: [], settings: {}, sources: [], jpegFor: () => '', cutoff: '',
  whatson: { events: [], notices: [], regulars: recent }, bins: {}, siteupdates: { entries: [] }, onthisday: { entries: {} } }).regulars.map((x) => x.what).join(',');
assert.strictEqual(later('2026-11-21'), 'Ukulele group,Pilates,Future');
assert.strictEqual(later('2026-11-22'), 'Future');

// A snapshot from before 11 Nov (no regularsCount, the whole list): one line each, by day.
const { regularsCount, ...oldModel } = model;
const r = render({ ...oldModel, regulars: sorted.map(({ day, time, what, where, note, link }) => ({ day, time, what, where, note, link })) });
assert.ok(r.html.includes('>Regular activities<'));
assert.equal((r.html.match(/>Wednesday</g) || []).length, 1, 'each day named once');
assert.ok(r.html.includes('href="https://thelenches.org.uk/regulars/"'), 'link to the full page');
assert.ok(r.html.includes('href="https://thelenches.org.uk/churches/"'), 'site path made absolute');
const t = r.text;
assert.ok(/REGULAR ACTIVITIES\n-+\n\nWho runs them, costs, contacts and flyers are on our Regular activities page: https:\/\/thelenches\.org\.uk\/regulars\/\n\nMonday\nYoga · 9\.45am\n\nWednesday\nTai chi · 10am · Abbots Morton\nTai chi · 7-8pm · Rous Lench Village Hall\n\nSunday\nChurch services · Churches: https:\/\/thelenches\.org\.uk\/churches\/\n/.test(t), t);

// An older snapshot: the footnote paragraph under Coming up, no Weekly regulars section.
const old = render({ ...oldModel, regulars: 'Weekly regulars: yoga on Mondays.' });
assert.ok(old.text.includes('Weekly regulars: yoga on Mondays.'));
assert.ok(!old.text.includes('REGULAR ACTIVITIES'));

// until: the last day shown (a block's final session)
const { loadWhatson } = require('../lib/whatson');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regs-'));
fs.writeFileSync(path.join(tmp, 'regulars.json'), JSON.stringify({ regulars: [
  { day: 'Wednesday', time: '7-8pm', what: 'Tai chi', until: '2026-12-09' },
  { day: 'Monday', time: '9.45am', what: 'Yoga' }] }));
const shown = (today) => loadWhatson({ dir: tmp, today }).regulars.map((x) => x.what);
assert.deepStrictEqual(shown('2026-12-09'), ['Yoga', 'Tai chi'], 'shown on its last day');
assert.deepStrictEqual(shown('2026-12-10'), ['Yoga'], 'gone the day after');
assert.strictEqual(loadWhatson({ dir: tmp, today: '2026-12-10', all: true }).regulars.length, 2);

// Regular activities page: day unknown kept (last), taking a break left out of the short list only
fs.writeFileSync(path.join(tmp, 'regulars.json'), JSON.stringify({ regulars: [
  { day: '', what: 'Lenches Ladies', frequency: 'Meets regularly, not every week' },
  { day: 'Friday', time: '10am', what: 'Keep fit', pausedUntil: '2027-01-08', runBy: ' A teacher ' },
  { day: 'Monday', time: '9.45am', what: 'Yoga', image: { url: '/images/items/yoga.jpg' } }] }));
const w = loadWhatson({ dir: tmp, today: '2026-12-01' });
assert.deepStrictEqual(w.regulars.map((x) => x.what), ['Yoga'], 'short list: known day, not on a break');
assert.deepStrictEqual(w.regularsPage.map((x) => x.what), ['Yoga', 'Keep fit', 'Lenches Ladies'], 'page: all, unknown day last');
assert.strictEqual(w.regularsPage[1].runBy, 'A teacher');
assert.deepStrictEqual(w.regularsPage[0].image, { url: '/images/items/yoga.jpg', alt: '' });
assert.deepStrictEqual(loadWhatson({ dir: tmp, today: '2027-01-08' }).regulars.map((x) => x.what), ['Yoga', 'Keep fit'], 'back on its day');
// Newsletter snapshot keeps the one-line fields only; frequency shows after the time
const snap = select({ ...{ issueDate: '2026-10-29', pending: [], issues: [], settings: {}, sources: [], jpegFor: () => '', cutoff: '' },
  whatson: { events: [], notices: [], regulars: sortRegulars([{ day: 'Tuesday', time: '7pm', what: 'Lenches Ladies', frequency: '1st Tuesday of the month', phone: '01386 000000' }]) },
  bins: {}, siteupdates: { entries: [] }, onthisday: { entries: {} } });
assert.strictEqual(snap.regulars.length, 0);
const snap2 = select({ ...{ issueDate: '2026-10-29', pending: [], issues: [], settings: {}, sources: [], jpegFor: () => '', cutoff: '' },
  whatson: { events: [], notices: [], regulars: sortRegulars([{ day: 'Tuesday', time: '7pm', what: 'Lenches Ladies', frequency: '1st Tuesday of the month', phone: '01386 000000', added: '2026-10-25' }]) },
  bins: {}, siteupdates: { entries: [] }, onthisday: { entries: {} } });
assert.ok(!('phone' in snap2.regulars[0]), 'no page-only fields in the snapshot');
assert.ok(render(snap2).text.includes('Newly listed: Lenches Ladies · Tuesday 7pm (1st Tuesday of the month)'));

console.log('regular activities: all tests passed');
