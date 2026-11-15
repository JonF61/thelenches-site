// scripts/test-replace.js
// Replace with the organiser's version (15 Nov 2026; scripts/approve replaceItem): the new item
// is approved and the listed entry goes in the same decision. Offline: the Sheet is faked.
// Run: node scripts/test-replace.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const g = require('./ingest/google');
let tables = {};
Object.assign(g, {
  readTable: async (tab) => (tables[tab] || []).map((r, i) => ({ ...r, _row: i + 2 })),
  updateRow: async (tab, row, fields) => { Object.assign(tables[tab][row - 2], fields); },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs); },
  ensureTab: async () => false,
});
const approve = require('./approve/index');
const fb = require('./ingest/itemfeedback');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replace-'));
fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
const FILE = '2026-12-05-carols-church-lench.json';
const write = (item) => fs.writeFileSync(path.join(dir, 'events', FILE), JSON.stringify(item));
const exists = () => fs.existsSync(path.join(dir, 'events', FILE));
const dup = (key, extra = {}) => JSON.stringify({ key, title: 'Carols', source: 'hand-written', confidence: 0.95, sure: true, changes: {}, ...extra });
const feedback = (id) => ({ item_id: id, type: 'duplicate', draft: '{}', outcome: '', changed: '', final: '', decided_at: '' });

(async () => {
  // 1. A hand-written entry: file deleted, its picture kept because the new item has none.
  write({ date: '2026-12-05', title: 'Carols', body: 'Old.', image: { url: '/images/items/carols.jpg', alt: 'Poster', credit: 'A. Maker' } });
  tables = {
    Pending: [{ id: 'n1', status: 'pending', notes: 'x', duplicate: dup(`h:events/${FILE}`), image_url: '', image_part_id: '', image_choice: '', alt_text: '', image_credit: '', image_credit_url: '', newsletter_count: 0, flyer_count: 0 }],
    'Item feedback': [feedback('n1')],
  };
  await approve.replaceItem('n1', dir);
  let n = tables.Pending[0];
  assert.ok(!exists(), 'hand-written file deleted');
  assert.strictEqual(n.status, 'approved');
  assert.strictEqual(n.image_url, '/images/items/carols.jpg');
  assert.strictEqual(n.alt_text, 'Poster');
  assert.strictEqual(n.image_credit, 'A. Maker');
  assert.ok(/Replaced "Carols"/.test(n.notes) && /picture kept/.test(n.notes));
  assert.strictEqual(tables['Item feedback'][0].outcome, 'replaced', 'not counted for or against Holly');

  // 2. The new item has its own picture: the old one is not carried. A file already gone is fine.
  tables.Pending = [{ id: 'n2', status: 'pending', notes: '', duplicate: dup(`h:events/${FILE}`), image_part_id: '1', image_url: '', alt_text: 'Mine' }];
  await approve.replaceItem('n2', dir);
  assert.strictEqual(tables.Pending[0].status, 'approved');
  assert.strictEqual(tables.Pending[0].image_url, '');
  assert.strictEqual(tables.Pending[0].alt_text, 'Mine');

  // 3. An official hand-written entry is never replaced: nothing changes.
  write({ date: '2026-12-05', title: 'Carols', body: 'Official.', official: true });
  tables.Pending = [{ id: 'n3', status: 'pending', notes: '', duplicate: dup(`h:events/${FILE}`) }];
  await assert.rejects(() => approve.replaceItem('n3', dir), /official/);
  assert.ok(exists() && tables.Pending[0].status === 'pending');
  tables.Pending = [{ id: 'n3', status: 'pending', notes: '', duplicate: dup(`h:events/${FILE}`, { official: true }) }];
  await assert.rejects(() => approve.replaceItem('n3', dir), /official/);

  // 4. A published submission (from a feed): its row becomes done, counts and picture carry over.
  tables = {
    Pending: [
      { id: 'old', status: 'approved', notes: 'feed', official: '', image_url: 'https://thelenches.org.uk/images/pipeline/old.jpg', alt_text: 'Old alt', image_credit: '', image_credit_url: '', newsletter_count: 2, flyer_count: 1, decided_at: '2026-11-01 10:00' },
      { id: 'n4', status: 'pending', notes: '', duplicate: dup('p:old', { source: 'pipeline' }), image_url: '', image_part_id: '', image_choice: '', alt_text: '', newsletter_count: 0, flyer_count: 0 },
    ],
    'Item feedback': [feedback('n4')],
  };
  await approve.replaceItem('n4', dir);
  const [old, fresh] = tables.Pending;
  assert.strictEqual(old.status, 'done');
  assert.strictEqual(old.decided_at, '2026-11-01 10:00', 'a decided row keeps its decision time');
  assert.ok(/Replaced by the organiser's version \(n4\)/.test(old.notes));
  assert.strictEqual(fresh.status, 'approved');
  assert.strictEqual(fresh.newsletter_count, 2);
  assert.strictEqual(fresh.flyer_count, 1);
  assert.strictEqual(fresh.image_url, 'https://thelenches.org.uk/images/pipeline/old.jpg');

  // 5. A waiting submission: done, and its own feedback row closed as done.
  tables = {
    Pending: [
      { id: 'w', status: 'pending', notes: '', official: '' },
      { id: 'n5', status: 'pending', notes: '', duplicate: dup('p:w', { source: 'waiting' }), image_part_id: '2' },
    ],
    'Item feedback': [{ ...feedback('w'), type: 'event' }, feedback('n5')],
  };
  await approve.replaceItem('n5', dir);
  assert.strictEqual(tables.Pending[0].status, 'done');
  assert.ok(tables.Pending[0].decided_at);
  assert.strictEqual(tables['Item feedback'][0].outcome, 'done');
  assert.strictEqual(tables['Item feedback'][1].outcome, 'replaced');

  // 6. Refusals change nothing: official submission, missing row, not listed, already decided.
  tables.Pending = [{ id: 'o', status: 'approved', official: 'TRUE' }, { id: 'n6', status: 'pending', duplicate: dup('p:o') }];
  await assert.rejects(() => approve.replaceItem('n6', dir), /official/);
  assert.strictEqual(tables.Pending[0].status, 'approved');
  tables.Pending = [{ id: 'n7', status: 'pending', duplicate: dup('p:gone') }];
  await assert.rejects(() => approve.replaceItem('n7', dir), /no longer in Pending/);
  tables.Pending = [{ id: 'n8', status: 'pending', duplicate: '' }];
  await assert.rejects(() => approve.replaceItem('n8', dir), /already listed/);
  tables.Pending = [{ id: 'n9', status: 'approved', duplicate: dup('p:o') }];
  await approve.replaceItem('n9', dir); // replayed tap: nothing to do
  assert.strictEqual(tables.Pending[0].status, 'approved');

  // The outcome is its own, and never Holly's mistake.
  assert.strictEqual(fb.outcomeFor({ type: 'duplicate' }, { duplicate: dup('p:o') }, 'replace').outcome, 'replaced');
  console.log('test-replace: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
