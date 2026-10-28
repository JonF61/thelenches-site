// scripts/test-newsletter-draft.js
// Offline test of scripts/newsletter/draft.js: the live draft (the Wednesday cutoff applies),
// the frozen copy once the issue is built, next week's once it has been sent, and the
// tab rows (deflated html in chunks that join back exactly). No Google calls.
// Run: node scripts/test-newsletter-draft.js
'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { buildDraft, draftRows, issueDateFor, CHUNK } = require('./newsletter/draft');

const base = {
  today: '2026-10-28',
  settings: {}, sources: [], jpegFor: () => '',
  whatson: { events: [], notices: [] }, bins: {}, siteupdates: {}, onthisday: { entries: {} },
  pending: [
    { id: 'a', title: 'Hall quiz night results', body: 'Well done all.', category: 'notice', status: 'approved', received: '2026-10-26 10:00', decided_at: '2026-10-26 11:00' },
    { id: 'b', title: 'Too late notice', body: 'Sent after the deadline.', category: 'notice', status: 'approved', received: '2026-10-28 19:00', decided_at: '2026-10-28 19:30' },
    { id: 'c', title: 'Still waiting', body: 'Not approved.', category: 'notice', status: 'pending', received: '2026-10-26 10:00' },
  ],
  issues: [{ issue_id: '2026-10-22', issue_date: '2026-10-22', status: 'sent', item_keys: '', image_keys: '' }],
};

// Live: this Thursday, approved in-time items only.
const live = buildDraft(base);
assert.strictEqual(live.meta.issue_date, '2026-10-29');
assert.strictEqual(live.meta.mode, 'live');
assert.strictEqual(live.meta.cutoff, '2026-10-28 18:00');
assert.strictEqual(live.meta.held, 1);
assert.ok(live.html.includes('Hall quiz night results'));
assert.ok(!live.html.includes('Too late notice'));
assert.ok(!live.html.includes('Still waiting'));
assert.ok(!live.html.includes('%%UNSUBSCRIBE_URL%%'), 'no raw unsubscribe placeholder');
assert.ok(live.html.includes('https://thelenches.org.uk/privacy/'));

// Frozen: once built, the snapshot is shown even if Pending has changed since.
const { select } = require('./newsletter/select');
const model = select({ ...base, issueDate: '2026-10-29', cutoff: '2026-10-28 18:00' });
const snapshot = zlib.deflateSync(Buffer.from(JSON.stringify(model), 'utf8')).toString('base64');
const built = { ...base,
  pending: [...base.pending, { id: 'd', title: 'Approved after the build', body: 'x', category: 'notice', status: 'approved', received: '2026-10-28 09:00', decided_at: '2026-10-29 07:00' }],
  issues: [...base.issues, { issue_id: '2026-10-29', issue_date: '2026-10-29', status: 'tested', snapshot }] };
const frozen = buildDraft(built);
assert.strictEqual(frozen.meta.mode, 'frozen');
assert.strictEqual(frozen.meta.status, 'tested');
assert.strictEqual(frozen.html, live.html);

// Sent: the draft moves on to next week.
assert.strictEqual(issueDateFor('2026-10-29', [{ issue_id: '2026-10-29', status: 'sent' }]), '2026-11-05');
assert.strictEqual(issueDateFor('2026-10-29', [{ issue_id: '2026-10-29', status: 'tested' }]), '2026-10-29');
assert.strictEqual(issueDateFor('2026-10-30', []), '2026-11-05');

// Tab rows: meta then html chunks that join back to the same html.
const big = live.html + 'x'.repeat(200000).replace(/x/g, () => String.fromCharCode(65 + Math.floor(Math.random() * 26)));
const rows = draftRows(live.meta, big, '2026-10-28T12:00:00Z');
assert.deepStrictEqual(rows[0], ['key', 'value']);
assert.deepStrictEqual(rows[1], ['as_of', '2026-10-28T12:00:00Z']);
const parts = rows.filter((r) => /^html_\d+$/.test(r[0]));
assert.ok(parts.length > 1, 'split into several cells');
assert.ok(parts.every((r) => r[1].length <= CHUNK));
assert.strictEqual(zlib.inflateSync(Buffer.from(parts.map((r) => r[1]).join(''), 'base64')).toString('utf8'), big);

console.log('newsletter draft: all tests passed');
