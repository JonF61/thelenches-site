// worker/test/history.test.mjs
// Offline tests for Previous submissions (admin/history.js) and the Reject reason path.
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionHistory, siteWindow } from '../src/admin/history.js';
import { planPending } from '../src/admin/actions.js';
import { dispatchFor } from '../src/core.js';

const row = (n, extra = {}) => ({ _row: n + 1, id: `m${n}-1`, title: `Item ${n}`, category: 'notice', received: `2026-10-${10 + n} 09:00`,
  from: 'Ann Smith <ann@example.org>', message_id: `m${n}`, gmail_link: `https://mail.google.com/mail/#all/m${n}`, ...extra });

test('decided rows only, newest decision first, with site window, issues, edits and reason', () => {
  const pending = { headers: ['id', 'status', 'reject_reason'], rows: [
    row(1, { status: 'pending' }),
    row(2, { status: 'approved', category: 'event', event_date: '2026-11-20', decided_at: '2026-10-12 10:00' }),
    row(3, { status: 'rejected', decided_at: '2026-10-20 10:00', reject_reason: 'Out of area' }),
    row(4, { status: 'auto', decided_at: '', received: '2026-10-14 08:00', message_id: 'rss:abc', source: 'Evesham Journal', gmail_link: 'https://example.org/story' }),
    row(5, { status: 'done', decided_at: '2026-10-18 10:00' }),
    row(6, { status: '' }),
  ] };
  const issues = { rows: [
    { issue_date: '2026-10-16', status: 'sent', item_keys: 'p:m2-1 p:m4-1 w:abc' },
    { issue_date: '2026-10-23', status: 'sent', item_keys: 'p:m2-1' },
    { issue_date: '2026-10-30', status: 'shadow', item_keys: 'p:m2-1' },
  ] };
  const feedback = { rows: [{ item_id: 'm2-1', outcome: 'edited', draft: '{"title":"Quiz"}', final: '{"title":"Charity quiz"}' }] };
  const h = submissionHistory({ pending, issues, feedback, today: '2026-11-03' });
  assert.deepEqual(h.rows.map((r) => r.id), ['m3-1', 'm5-1', 'm4-1', 'm2-1']);
  assert.equal(h.hasReasonColumn, true);
  const ev = h.rows.find((r) => r.id === 'm2-1');
  assert.deepEqual(ev.site, { page: 'Events', from: '2026-10-12', until: '2026-11-20', now: true });
  assert.deepEqual(ev.newsletter, ['2026-10-16', '2026-10-23']);
  assert.equal(ev.edited, true);
  assert.match(ev.changed, /title: Quiz → Charity quiz/);
  assert.equal(ev.from, 'Ann Smith');
  const feed = h.rows.find((r) => r.id === 'm4-1');
  assert.deepEqual([feed.origin, feed.from, feed.gmail, feed.link], ['feed', 'Evesham Journal', '', 'https://example.org/story']);
  assert.deepEqual(feed.site, { page: 'Notices', from: '2026-10-14', until: '2026-11-04', now: true });
  assert.equal(h.rows.find((r) => r.id === 'm3-1').reason, 'Out of area');
  assert.equal(h.rows.find((r) => r.id === 'm3-1').site, null);
});

test('site window: roadworks run to their end date; rejected never shown', () => {
  assert.deepEqual(siteWindow({ status: 'approved', decided_at: '2026-10-01 09:00', link_url: 'https://one.network/?x', end_date: '2026-12-01' }),
    { page: 'Roads', from: '2026-10-01', until: '2026-12-01' });
  assert.equal(siteWindow({ status: 'rejected', decided_at: '2026-10-01 09:00' }), null);
});

test('Reject reason: cleaned, only on reject, dispatched to approval', () => {
  const r = { id: 'm1-1', status: 'pending' };
  const plan = planPending({ action: 'reject', id: 'm1-1', reason: '  Not local\n ' }, r);
  assert.equal(plan.reason, 'Not local');
  assert.deepEqual(dispatchFor(plan.p, plan.reason), ['approval', { id: 'm1-1', action: 'reject', reason: 'Not local' }]);
  assert.equal(planPending({ action: 'approve', id: 'm1-1', reason: 'x' }, r).reason, '');
  assert.deepEqual(dispatchFor({ a: 'reject', i: 'm1-1' }, ''), ['approval', { id: 'm1-1', action: 'reject' }]);
});

test('no reject_reason column: flagged for the panel', () => {
  assert.equal(submissionHistory({ pending: { headers: ['id'], rows: [] }, issues: null, feedback: null, today: '2026-11-03' }).hasReasonColumn, false);
});
