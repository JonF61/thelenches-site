// This weekend page (SEO step 4, 26 Nov 2026): lib/weekend.js. Run: node scripts/test-weekend.js
'use strict';
const assert = require('assert');
const W = require('../lib/weekend.js');

// Which weekend: Mon-Thu the coming one, Fri-Sun the current one.
const wk = { fri: '2026-11-27', sat: '2026-11-28', sun: '2026-11-29' };
for (const d of ['2026-11-23', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']) assert.deepStrictEqual(W.weekendFor(d), wk, d);
assert.deepStrictEqual(W.weekendFor('2026-11-30'), { fri: '2026-12-04', sat: '2026-12-05', sun: '2026-12-06' });
assert.deepStrictEqual(W.weekendFor('2026-12-31'), { fri: '2027-01-01', sat: '2027-01-02', sun: '2027-01-03' });

const ev = (date, title, body = '', extra = {}) => ({ date, title, body, ...extra });
const list = [
  ev('2026-11-27', 'Coffee morning', '10am to noon.'),          // Friday daytime: out
  ev('2026-11-27', 'Quiz', 'From 7.30pm.'),                       // Friday evening: in
  ev('2026-11-27', 'Pub night', 'Doors at 5pm.'),                 // 5pm counts as evening
  ev('2026-11-27', 'Market', 'All day.'),                         // Friday, no time: out
  ev('2026-11-28', 'Fayre', '2 to 4pm.'),
  ev('2026-11-28', 'Breakfast', '9am.'),
  ev('2026-11-29', 'Carols', '3pm.'),
  ev('2026-11-30', 'Monday talk', '7pm.'),                        // after: out
  ev('2026-11-26', 'Exhibition', '', { endDate: '2026-11-29' }),  // multi-day touching: in
  ev('2026-11-28', 'Fayre', '2 to 4pm.'),                         // duplicate: once
];
const got = W.weekendEvents(list, '2026-11-26').map((e) => e.title);
assert.deepStrictEqual(got, ['Exhibition', 'Pub night', 'Quiz', 'Breakfast', 'Fayre', 'Carols']);
assert.deepStrictEqual(W.weekendGroups(list, '2026-11-26').map((g) => [g.label, g.items.length]), [['Friday evening', 3], ['Saturday', 2], ['Sunday', 1]]);
// On Saturday, Friday's events have gone.
assert.deepStrictEqual(W.weekendEvents(list, '2026-11-28').map((e) => e.title), ['Exhibition', 'Breakfast', 'Fayre', 'Carols']);
// Nothing on: empty.
assert.deepStrictEqual(W.weekendGroups([ev('2026-12-10', 'Later', '7pm.')], '2026-11-26'), []);
console.log('weekend: all tests passed');
