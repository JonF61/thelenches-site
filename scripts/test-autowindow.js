// scripts/test-autowindow.js
// Veto window, script side (autonomy stage 3; rules in worker/src/admin/autowindow.mjs, tested in
// worker/test/autowindow.test.mjs): the approve that the Worker sends at the end of a window is
// recorded as "published itself" (Item feedback outcome `window`), an ordinary approve is not,
// and google.js ensureColumn adds Pending's auto_at column at the end. Offline.
// Run: node scripts/test-autowindow.js
'use strict';

const assert = require('assert');

process.env.SHEET_ID = 'test';
const g = require('./ingest/google');
const real = { ensureColumn: g.ensureColumn };
let tables = {};
Object.assign(g, {
  readTable: async (tab) => (tables[tab] || []).map((r, i) => ({ ...r, _row: i + 2 })),
  updateRow: async (tab, row, fields) => { Object.assign(tables[tab][row - 2], fields); },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs); },
  ensureTab: async () => false,
});
const approve = require('./approve/index');
const fb = require('./ingest/itemfeedback');

const feedback = (id) => ({ item_id: id, type: 'event', draft: JSON.stringify({ title: 'Quiz' }), outcome: '', changed: '', final: '', decided_at: '' });
const pending = (id, auto) => ({ id, status: 'pending', title: 'Quiz', notes: 'n', auto_at: auto, wording: '' });

(async () => {
  // 1. The Worker's end-of-window approve: published itself, not Jon's decision.
  tables = { Pending: [pending('a', 'publishing 2026-11-16 14:30')], 'Item feedback': [feedback('a')] };
  await approve.decideItem('a', 'approve');
  assert.strictEqual(tables.Pending[0].status, 'approved');
  assert.match(tables.Pending[0].auto_at, /^published \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(tables.Pending[0].notes, /Published itself after its veto window/);
  assert.strictEqual(tables['Item feedback'][0].outcome, 'window', 'not counted until audited');

  // 2. Jon's own Approve during the window (auto_at still a time), or after a hold: his decision.
  for (const auto of ['2026-11-16 14:17', 'held: by you', '']) {
    tables = { Pending: [pending('b', auto)], 'Item feedback': [feedback('b')] };
    await approve.decideItem('b', 'approve');
    assert.strictEqual(tables.Pending[0].auto_at, auto);
    assert.strictEqual(tables['Item feedback'][0].outcome, 'approved');
    assert.ok(!/veto window/.test(tables.Pending[0].notes));
  }

  // 3. A reject while "publishing" is still Jon's reject; a replayed approve changes nothing.
  tables = { Pending: [{ ...pending('c', 'published 2026-11-16 14:31'), status: 'approved' }], 'Item feedback': [{ ...feedback('c'), outcome: 'window' }] };
  await approve.decideItem('c', 'approve');
  assert.strictEqual(tables['Item feedback'][0].outcome, 'window');
  assert.strictEqual(fb.outcomeFor({ type: 'event', draft: '{}' }, {}, 'window').outcome, 'window');

  // 4. ensureColumn: adds the header at the end, widening the sheet first when it is full.
  const calls = [];
  const sheet = (width, headers) => ({
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: 'Pending', gridProperties: { columnCount: width } } }] } }),
      batchUpdate: async ({ requestBody }) => { calls.push(['grid', requestBody.requests[0].appendDimension]); return {}; },
      values: {
        get: async () => ({ data: { values: [headers] } }),
        update: async ({ range, requestBody }) => { calls.push(['header', range, requestBody.values[0][0]]); return {}; },
      },
    },
  });
  g.setSheetsClient(sheet(3, ['id', 'status', 'notes']));
  assert.strictEqual(await real.ensureColumn('Pending', 'auto_at'), true);
  assert.deepStrictEqual(calls, [['grid', { sheetId: 7, dimension: 'COLUMNS', length: 1 }], ['header', "'Pending'!D1", 'auto_at']]);
  calls.length = 0;
  g.setSheetsClient(sheet(10, ['id', 'status', 'notes']));
  assert.strictEqual(await real.ensureColumn('Pending', 'auto_at'), true);
  assert.deepStrictEqual(calls, [['header', "'Pending'!D1", 'auto_at']], 'room already: no widening');
  calls.length = 0;
  g.setSheetsClient(sheet(10, ['id', 'auto_at']));
  assert.strictEqual(await real.ensureColumn('Pending', 'auto_at'), false);
  assert.deepStrictEqual(calls, []);

  console.log('test-autowindow: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
