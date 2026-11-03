// Offline test: road end dates read from the text, and the same works shown once (3 Nov, Rimmer).
// Run: node scripts/test-roads-split.js
'use strict';
const assert = require('assert');
const r = require('../lib/roads');

assert.equal(r.endOf({ date: '2026-10-21', body: 'Works at Brookdale from Wednesday 21 to Friday 23 October; delays unlikely.' }), '2026-10-23');
assert.equal(r.endOf({ date: '2026-10-26', body: 'Ab Lench Road will be closed on Monday 26 October.' }), '2026-10-26');
assert.equal(r.endOf({ start: '2026-10-27', end: '2026-11-29', body: 'until 3 November' }), '2026-11-29', 'given end wins');
assert.equal(r.endOf({ date: '2026-12-28', body: 'from 28 December to 4 January' }), '2027-01-04', 'into next year');
assert.equal(r.endOf({ date: '2026-10-21', body: 'No dates here.' }), '');
assert.equal(r.endOf({ body: 'to 23 October' }), '', 'no start, no guess');

const a = { title: 'Abbots Morton Road closed — Abbots Morton', road: 'Abbots Morton Road', village: 'Abbots Morton', start: '2026-11-04', end: '2026-11-06' };
const b = { title: 'Road Closure — Abbots Morton Road, Abbots Morton', road: 'Abbots Morton Road', village: 'Abbots Morton', start: '2026-11-04', end: '2026-11-06' };
const c = { title: 'Road Closure — Badgers Hill to Handgate Lane, Sheriffs Lench', road: 'Badgers Hill', village: 'Sheriffs Lench', date: '2026-10-27' };
const d = { title: 'Road Closure — Badgers Hill, Sheriffs Lench', road: 'Badgers Hill', village: 'Sheriffs Lench', start: '2026-10-27', end: '2026-11-29' };
const e = { title: 'Ab Lench Road closed — Church Lench', road: 'Ab Lench Road', village: 'Church Lench', start: '2026-11-09', end: '2026-11-09' };
const f = { title: 'Road Closure — Ab Lench Road, Church Lench', road: 'Ab Lench Road', village: 'Church Lench', date: '2026-10-26' };
const out = r.dedupeRoads([a, b, c, d, e, f]);
assert.deepEqual(out, [a, d, e, f], 'one per road, village and start; the one with an end date kept; different days kept');
console.log('roads split: all tests passed');
