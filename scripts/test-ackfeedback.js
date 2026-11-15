// scripts/test-ackfeedback.js
// Acknowledgements are logged in Reply feedback (15 Nov 2026) so Jon's decisions on them count
// on the Autonomy screen: the kind of ack goes in `class`, Approve / Edit / Reject resolve the
// row as for any reply, and only acks with Holly's personal line teach her. Offline.
// Run: node scripts/test-ackfeedback.js
'use strict';

const assert = require('assert');
const g = require('./ingest/google');

let tables = {};
Object.assign(g, {
  readTable: async (tab) => (tables[tab] || []).map((r, i) => ({ ...r, _row: i + 2 })),
  updateRow: async (tab, row, fields) => { Object.assign(tables[tab][row - 2], fields); },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs.map((o) => ({ ...o }))); },
  ensureTab: async (tab) => { tables[tab] = tables[tab] || []; return false; },
});
const feedback = require('./ingest/feedback');
const replies = require('./ingest/replies');

const ack = (id, extra = {}) => ({ reply_id: id, created_at: '2026-11-16 10:00', type: 'ack', class: 'submission', body: 'Hi Sam,\n\nThanks for sending "Quiz".\n\nBest wishes,\nHolly', status: 'awaiting', ...extra });

(async () => {
  tables = {};
  await feedback.record(ack('a1'), { theyWrote: 'Quiz on Friday', mode: 'live', ackKind: 'personal' });
  await feedback.record(ack('a2'), { ackKind: 'listed' });
  await feedback.record(ack('a3'), {});
  await feedback.record(ack('a4'), { ackKind: 'nonsense' });
  await feedback.record(ack('a5', { status: 'shadow' }), { ackKind: 'plain' });
  await feedback.record({ ...ack('h1'), type: 'holding' }, {});
  const fb = tables[feedback.TAB];
  assert.deepStrictEqual(fb.map((r) => [r.reply_id, r.type, r.class, r.outcome]), [
    ['a1', 'ack', 'personal', ''], ['a2', 'ack', 'listed', ''], ['a3', 'ack', 'plain', ''], ['a4', 'ack', 'plain', ''], ['a5', 'ack', 'plain', 'shadow'],
  ], 'acks logged with their kind; holding replies still are not');
  assert.strictEqual(fb[0].they_wrote, 'Quiz on Friday');

  // Jon's decisions resolve them as for any reply.
  await feedback.resolve('a1', { outcome: 'approved', finalText: fb[0].draft, decidedAt: '2026-11-16 11:00' });
  await feedback.resolve('a2', { outcome: 'approved', finalText: 'Hi Sam,\n\nThanks. It is already on the site.\n\nBest wishes,\nHolly', decidedAt: '2026-11-16 11:01' });
  await feedback.resolve('a3', { outcome: 'rejected', reason: 'No need to reply', decidedAt: '2026-11-16 11:02' });
  assert.deepStrictEqual(fb.slice(0, 3).map((r) => r.outcome), ['approved', 'edited', 'rejected']);

  // Learning: a fixed-wording ack teaches nothing; one with a personal line does.
  assert.deepStrictEqual(replies.correctionsFrom(fb), []);
  await feedback.record(ack('a6'), { ackKind: 'personal' });
  await feedback.resolve('a6', { outcome: 'approved', finalText: 'Hi Sam,\n\nThanks for sending "Quiz". Good luck with it.\n\nBest wishes,\nHolly', decidedAt: '2026-11-16 12:00' });
  const learnt = replies.correctionsFrom(tables[feedback.TAB]);
  assert.deepStrictEqual(learnt.map((c) => [c.type, c.outcome]), [['ack', 'edited']]);

  console.log('test-ackfeedback: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
