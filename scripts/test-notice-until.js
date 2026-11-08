// Notice end dates (8 Nov): a notice with an end_date comes down the day after it; others keep 21 days.
process.env.ANTHROPIC_API_KEY = 'x';
const assert = require('assert');
const { windowFor } = require('./publish/index.js');
const today = '2026-11-08';
const base = { category: 'notice', decided_at: '2026-11-03 10:00', link_url: '' };
let w = windowFor({ ...base }, today);
assert.strictEqual(w.list, 'notices'); assert.strictEqual(w.expires, '2026-11-24');
w = windowFor({ ...base, end_date: '2026-11-07' }, today);
assert.strictEqual(w.expires, '2026-11-07');                         // fireworks reminder: gone on the 8th
w = windowFor({ ...base, event_date: '2026-11-05', end_date: '2026-11-07' }, today);
assert.strictEqual(w.expires, '2026-11-07');                         // works 5 to 7 Nov
w = windowFor({ ...base, end_date: '2026-12-31' }, today);
assert.strictEqual(w.expires, '2026-12-31');                         // longer than 21 days is fine too
w = windowFor({ ...base, link_url: 'https://one.network/?tm=1', event_date: '2026-11-05', end_date: '2026-11-07' }, today);
assert.strictEqual(w.road, true); assert.strictEqual(w.expires, '2026-11-24'); // roadworks unchanged
w = windowFor({ ...base, category: 'event', event_date: '2026-11-12', end_date: '2026-11-10' }, today);
assert.strictEqual(w.list, 'events'); assert.strictEqual(w.expires, '2026-11-12'); // events unchanged
console.log('ok');
