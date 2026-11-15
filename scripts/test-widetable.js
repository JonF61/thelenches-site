// scripts/test-widetable.js
// Pending is wider than 52 columns: its columns from BA on (duplicate, live_notified_at) must be
// read by readTable and written by appendRows / updateRow (15 Nov 2026: readTable stopped at AZ,
// so Already listed never reached the panel and "Now on the website" never sent). Offline: a
// fake Sheets client. Run: node scripts/test-widetable.js
'use strict';

const assert = require('assert');

process.env.SHEET_ID = 'test';
const g = require('./ingest/google');

const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
// 52 ordinary columns, then the two that sit past AZ.
const headers = [...Array.from({ length: 52 }, (_, i) => (i === 0 ? 'status' : i === 1 ? 'id' : `c${i}`)), 'duplicate', 'live_notified_at'];
const grid = [headers, [...Array.from({ length: 52 }, (_, i) => (i === 0 ? 'pending' : i === 1 ? 'x1' : '')), '{"key":"p:abc"}', '']];
const calls = { append: [], update: [] };

g.setSheetsClient({
  spreadsheets: {
    values: {
      // Honours the range's last column, as the real API does.
      get: async ({ range }) => {
        const a1 = range.split('!')[1];
        if (a1 === '1:1') return { data: { values: [grid[0]] } };
        const end = /:([A-Z]+)\d*$/.exec(a1);
        const width = end ? colIndex(end[1]) : Infinity;
        return { data: { values: grid.map((r) => r.slice(0, width)) } };
      },
      append: async ({ requestBody }) => { calls.append.push(...requestBody.values); return {}; },
      batchUpdate: async ({ requestBody }) => { calls.update.push(...requestBody.data); return {}; },
    },
  },
});

(async () => {
  const rows = await g.readTable('Pending');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].duplicate, '{"key":"p:abc"}', 'readTable returns a column past AZ');
  assert.ok('live_notified_at' in rows[0], 'readTable returns the last column, even when blank');

  // After a readTable (which caches the headers), a new row keeps its wide columns.
  await g.appendRows('Pending', [{ status: 'pending', id: 'x2', duplicate: '{"key":"h:events/a.json"}' }]);
  assert.strictEqual(calls.append[0].length, 54);
  assert.strictEqual(calls.append[0][52], '{"key":"h:events/a.json"}', 'appendRows writes column BA');

  await g.updateRow('Pending', 2, { live_notified_at: '2026-11-15 21:40', nonsense: 'x' });
  assert.deepStrictEqual(calls.update.map((d) => d.range), ["'Pending'!BB2"], 'updateRow writes column BB only');

  console.log('test-widetable: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
