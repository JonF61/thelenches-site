// worker/test/autonomy.test.mjs
// Offline tests for the panel's Autonomy helpers (admin/autonomy.js, stage 2, 2 Nov 2026).
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyStats, planIgnore, NEEDED } from '../src/admin/autonomy.js';

const item = (n, outcome, extra = {}) => ({ item_id: `m${n}-1`, created_at: `2026-11-02 09:${String(n).padStart(2, '0')}`,
  decided_at: `2026-11-02 10:${String(n % 60).padStart(2, '0')}`, type: 'event', source_kind: 'email', flags: '', outcome, changed: '', ...extra });
const reply = (n, outcome, extra = {}) => ({ reply_id: `r${n}`, created_at: `2026-10-${String(10 + (n % 20)).padStart(2, '0')} 09:00`,
  decided_at: `2026-10-${String(10 + (n % 20)).padStart(2, '0')} 10:${String(n % 60).padStart(2, '0')}`, type: 'answer', class: 'question', outcome, ...extra });

test('counts per type: as written, changed, rejected; ignored and undecided left out', () => {
  const s = autonomyStats({ items: { rows: [
    item(1, 'approved'), item(2, 'edited', { changed: 'title' }), item(3, 'rejected'), item(4, ''), item(5, 'done'), item(6, 'auto'),
    item(7, 'ignored:edited'),
  ] }, replies: { rows: [reply(1, 'approved'), reply(2, 'redrafted'), reply(3, 'shadow'), reply(4, 'timed_out'), reply(5, 'approved', { type: 'clarify', class: '' })] } },
  Date.parse('2026-11-02T12:00:00Z'));
  const ev = s.items.find((t) => t.label === 'Event · email');
  assert.deepEqual([ev.decided, ev.unchanged, ev.changed, ev.rejected, ev.rate, ev.qualifies], [3, 1, 1, 1, 33, false]);
  assert.ok(ev.recent.some((d) => d.verdict === 'ignored' && d.outcome === 'ignored:edited'), 'ignored still listed, so it can be counted again');
  const ans = s.replies.find((t) => t.label === 'Answer · question');
  assert.deepEqual([ans.decided, ans.unchanged, ans.changed], [2, 1, 1]);
  assert.ok(s.replies.find((t) => t.label === 'Clarify'));
  assert.equal(s.automatic.length, 0);
  assert.equal(s.shadow.qualifying.length, 0);
});

test('never automatic: official notices, flagged items, held / follow-up / outreach replies', () => {
  const s = autonomyStats({ items: { rows: [
    item(1, 'approved', { type: 'notice-official' }), item(2, 'approved', { flags: 'people_in_image' }), item(3, 'approved', { flags: 'political_commercial' }),
  ] }, replies: { rows: [reply(1, 'approved', { type: 'held' }), reply(2, 'approved', { type: 'followup' }), reply(3, 'approved', { type: 'outreach' })] } });
  assert.equal(s.items.length, 0);
  assert.equal(s.replies.length, 0);
  assert.equal(s.never.decided, 6);
});

test('qualifies at 30 decisions, 95% as written, no rejection in the last 20; shadow counts', () => {
  const rows = Array.from({ length: NEEDED }, (_, i) => item(i + 1, i === 0 ? 'edited' : 'approved'));
  const s = autonomyStats({ items: { rows }, replies: { rows: [] } }, Date.parse('2026-11-03T12:00:00Z'));
  const ev = s.items[0];
  assert.equal(ev.qualifies, true);
  assert.deepEqual(s.shadow, { qualifying: [ev.key], wouldHave: NEEDED, wrong: 1 });
  const withReject = autonomyStats({ items: { rows: [...rows.slice(1), item(99, 'rejected', { decided_at: '2026-11-02 23:59' })] }, replies: { rows: [] } });
  assert.equal(withReject.items[0].qualifies, false);
  assert.equal(withReject.items[0].rejectedRecently, true);
  const short = autonomyStats({ items: { rows: rows.slice(0, NEEDED - 1) }, replies: { rows: [] } });
  assert.equal(short.items[0].qualifies, false);
  assert.equal(short.items[0].toGo, 1);
});

test('planIgnore: stale-checked, ignore keeps the old outcome, count again restores it', () => {
  assert.deepEqual(planIgnore({ outcome: 'edited' }, { op: 'ignore', expected: 'edited' }), { field: 'outcome', expected: 'edited', value: 'ignored:edited' });
  assert.deepEqual(planIgnore({ outcome: 'ignored:edited' }, { op: 'restore', expected: 'ignored:edited' }), { field: 'outcome', expected: 'ignored:edited', value: 'edited' });
  assert.equal(planIgnore({ outcome: 'approved' }, { op: 'ignore', expected: 'edited' }).status, 409);
  assert.equal(planIgnore({ outcome: '' }, { op: 'ignore', expected: '' }).status, 400);
  assert.equal(planIgnore(undefined, { op: 'ignore', expected: '' }).status, 404);
  assert.equal(planIgnore({ outcome: 'ignored:edited' }, { op: 'ignore', expected: 'ignored:edited' }).status, 409);
});
