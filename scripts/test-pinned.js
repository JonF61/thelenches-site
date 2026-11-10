// scripts/test-pinned.js
// A hand-written notice with "pinned": true leads the newsletter's Notices (10 Nov),
// ahead of newer pipeline notices, and the flag never reaches the rendered model.
// Run: node scripts/test-pinned.js
const assert = require('assert');
const { select } = require('./newsletter/select');

const base = { issueDate: '2026-11-12', bins: null, siteupdates: {}, onthisday: [], issues: [], settings: {}, sources: [], jpegFor: (u) => u, cutoff: '2026-11-11 18:00', photos: [] };
const pending = [{ status: 'approved', title: 'Pipeline notice', category: 'notice', id: 'p1', received: '2026-11-10 10:00', decided_at: '2026-11-10 11:00' }];
const notices = [{ title: 'Alpha notice', body: 'a' }, { title: 'Zulu pinned notice', body: 'z', pinned: true }];

let m = select({ ...base, pending, whatson: { events: [], notices } });
assert.deepStrictEqual(m.notices.map((n) => n.title), ['Zulu pinned notice', 'Pipeline notice', 'Alpha notice']);
assert.ok(m.notices.every((n) => !('pinned' in n)), 'pinned is not passed on');

m = select({ ...base, pending, whatson: { events: [], notices: [{ title: 'Alpha notice', body: 'a' }] } });
assert.deepStrictEqual(m.notices.map((n) => n.title), ['Pipeline notice', 'Alpha notice'], 'unchanged without a pin');
console.log('pinned notices: all tests passed');

// Two pinned: in the site's order (whatson's order), not by title (10 Nov).
{
  const two = [{ title: 'Zulu first', body: 'z', pinned: true }, { title: 'Alpha second', body: 'a', pinned: true }, { title: 'Mike', body: 'm' }];
  const m2 = select({ ...base, pending, whatson: { events: [], notices: two } });
  assert.deepStrictEqual(m2.notices.map((n) => n.title), ['Zulu first', 'Alpha second', 'Pipeline notice', 'Mike']);
  console.log('pinned notices: order kept');
}
