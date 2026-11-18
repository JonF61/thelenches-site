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
assert.strictEqual(w.expires, '2026-11-30');                         // longer than 21 days is fine, up to 4 weeks (18 Nov)
w = windowFor({ ...base, link_url: 'https://one.network/?tm=1', event_date: '2026-11-05', end_date: '2026-11-07' }, today);
assert.strictEqual(w.road, true); assert.strictEqual(w.expires, '2026-11-24'); // roadworks unchanged
w = windowFor({ ...base, category: 'event', event_date: '2026-11-12', end_date: '2026-11-10' }, today);
assert.strictEqual(w.list, 'events'); assert.strictEqual(w.expires, '2026-11-12'); // events unchanged
console.log('ok');

// 4-week shelf life (18 Nov, Jon): notices (roadworks aside) at most 28 days from when received.
w = windowFor({ ...base, received: '2026-11-01 09:00', end_date: '2026-12-31' }, today);
assert.strictEqual(w.expires, '2026-11-28');                         // a later end_date is capped
w = windowFor({ ...base, received: '2026-10-20', decided_at: '2026-11-03' }, today);
assert.strictEqual(w.expires, '2026-11-16');                         // counted from received, not the decision
w = windowFor({ ...base, received: '2026-11-01', event_date: '2027-01-10' }, today);
assert.strictEqual(w.expires, '2026-11-28');                         // a far-off date no longer holds it up
w = windowFor({ ...base, received: '2026-10-01', link_url: 'https://one.network/?tm=1', end_date: '2026-12-31' }, today);
assert.strictEqual(w.expires, '2026-12-31');                         // roadworks until the works end
w = windowFor({ ...base, received: '2026-10-01', category: 'event', event_date: '2026-12-12' }, today);
assert.strictEqual(w.expires, '2026-12-12');                         // events unchanged

// Hand-written notices: hidden from added + 28 days at the latest; every one needs added.
const { noticeHides } = require('../lib/whatson.js');
assert.strictEqual(noticeHides({ added: '2026-10-21' }), '2026-11-18');
assert.strictEqual(noticeHides({ added: '2026-10-21', expires: '2026-11-05' }), '2026-11-05');
assert.strictEqual(noticeHides({ added: '2026-10-21', expires: '2027-01-01' }), '2026-11-18');
assert.strictEqual(noticeHides({ added: '2026-10-21', roads: true, expires: '2027-01-01' }), '2027-01-01');
const fs = require('fs'), path = require('path');
for (const site of fs.readdirSync('sites')) {
  const dir = path.join('sites', site, 'items', 'notices');
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const n = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!n.roads) assert.match(String(n.added || ''), /^\d{4}-\d{2}-\d{2}$/, `${dir}/${f}: give every notice "added" (YYYY-MM-DD)`);
  }
}
console.log('shelf life ok');
