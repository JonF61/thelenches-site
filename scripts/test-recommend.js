// scripts/test-recommend.js
// Offline tests for the Recommend workflow script (scripts/recommend): send (confirmation,
// "already counted", unlisted entry), confirm (counted, repeat, late, replays), the 30-day
// wipe of unconfirmed addresses, addresses wiped once counted, the counts file, and that
// nothing logged contains an address. Google and Gmail are faked. Run: node scripts/test-recommend.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APPROVAL_SIGNING_KEY = 'test-key';
process.env.WORKER_URL = 'https://approvals.example.workers.dev';

const rec = require('./recommend');
const { signToken } = require('./ingest/links');

const MS = Date.UTC(2026, 10, 3, 10, 0);
const ID = 'rc-20261103-abc123';
const KEY = rec.emailKey('reader@example.org');

function world(rows) {
  const tabs = { Recommendations: rows };
  const sent = [];
  const g = {
    ensureTab: async () => false,
    readTable: async (tab) => tabs[tab].map((r, i) => ({ _row: i + 2, ...r })),
    readSettings: async () => ({ settings: { from_name: 'The Lenches Website and Newsletter Team' } }),
    fromNameFor: (s) => s.from_name,
    sendMail: async (m) => { sent.push(m); return 'msg1'; },
    updateRow: async (tab, row, fields) => { Object.assign(tabs[tab][row - 2], fields); },
  };
  return { tabs, sent, deps: { g, signToken } };
}

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const countsFile = path.join(tmp, 'recommends.json');

  // send: confirmation email with a signed /r link naming the entry
  let w = world([{ id: ID, requested: '2026-11-03 09:55', kind: 'trades', entry: 'b-tomes-son', email: 'reader@example.org', key: KEY, status: 'new' }]);
  assert.equal(await rec.run({ action: 'send', id: ID, ms: MS }, w.deps), 'sent');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].to, 'reader@example.org');
  assert.equal(w.sent[0].from, 'website@thelenches.org.uk');
  assert.equal(w.sent[0].subject, 'Please confirm your recommendation: The Lenches website');
  assert.match(w.sent[0].text, /asked to recommend B Tomes & Son on the Local trades page/);
  const url = w.sent[0].text.match(/https:\/\/approvals\.example\.workers\.dev\/r\?t=\S+/)[0];
  const payload = JSON.parse(Buffer.from(url.split('t=')[1].split('.')[0], 'base64url'));
  assert.deepEqual({ a: payload.a, i: payload.i, k: payload.k, n: payload.n }, { a: 'rec', i: ID, k: 'trades', n: 'b-tomes-son' });
  assert.equal(w.tabs.Recommendations[0].status, 'sent');
  assert.equal(await rec.run({ action: 'send', id: ID, ms: MS }, w.deps), 'skipped', 'a replay sends nothing');
  assert.equal(w.sent.length, 1);

  // confirm: counted, address wiped, key kept
  assert.equal(await rec.run({ action: 'confirm', id: ID, ms: MS + 3600e3 }, w.deps), 'counted');
  assert.equal(w.tabs.Recommendations[0].status, 'counted');
  assert.equal(w.tabs.Recommendations[0].email, '');
  assert.equal(w.tabs.Recommendations[0].key, KEY);
  assert.equal(await rec.run({ action: 'confirm', id: ID, ms: MS + 3600e3 }, w.deps), 'skipped');

  // the same address again for the same entry: "already counted" email, never counted twice
  const ID2 = 'rc-20261104-def456';
  w.tabs.Recommendations.push({ id: ID2, requested: '2026-11-04 09:00', kind: 'trades', entry: 'b-tomes-son', email: 'reader@example.org', key: KEY, status: 'new' });
  assert.equal(await rec.run({ action: 'send', id: ID2, ms: MS + 86400e3 }, w.deps), 'already');
  assert.equal(w.sent[1].subject, 'Already counted: The Lenches website');
  assert.match(w.sent[1].text, /already recommended this one/);
  assert.equal(w.tabs.Recommendations[1].email, '');

  // two links confirmed in either order: only the first counts
  const ID3 = 'rc-20261104-ghi789';
  w.tabs.Recommendations.push({ id: ID3, requested: '2026-11-04 09:00', kind: 'trades', entry: 'b-tomes-son', email: '', key: KEY, status: 'sent', sent_at: '2026-11-04 09:01' });
  assert.equal(await rec.run({ action: 'confirm', id: ID3, ms: MS + 86400e3 }, w.deps), 'already');

  // late confirm and unlisted entry
  w = world([{ id: ID, requested: '2026-10-20 09:00', kind: 'eat', entry: 'the-anchor-inn', email: 'a@example.org', key: 'k1', status: 'sent', sent_at: '2026-10-20 09:01' }]);
  assert.equal(await rec.run({ action: 'confirm', id: ID, ms: MS }, w.deps), 'late');
  w = world([{ id: ID, requested: '2026-11-03 09:00', kind: 'eat', entry: 'gone-place', email: 'a@example.org', key: 'k1', status: 'new' }]);
  assert.equal(await rec.run({ action: 'send', id: ID, ms: MS }, w.deps), 'skipped');
  assert.equal(w.sent.length, 0);
  assert.equal(w.tabs.Recommendations[0].email, '');

  // 30-day wipe of unconfirmed rows only
  w = world([
    { id: 'rc-20260901-aaaaaa', requested: '2026-09-01 10:00', kind: 'eat', entry: 'boot-inn', email: 'old@example.org', key: 'k2', status: 'sent' },
    { id: 'rc-20261101-bbbbbb', requested: '2026-11-01 10:00', kind: 'eat', entry: 'boot-inn', email: 'new@example.org', key: 'k3', status: 'sent' },
    { id: ID, requested: '2026-11-03 09:55', kind: 'eat', entry: 'boot-inn', email: 'x@example.org', key: 'k4', status: 'new' },
  ]);
  await rec.run({ action: 'send', id: ID, ms: MS }, w.deps);
  assert.deepEqual([w.tabs.Recommendations[0].email, w.tabs.Recommendations[0].status], ['', 'expired']);
  assert.equal(w.tabs.Recommendations[1].email, 'new@example.org');

  // counts: one per address per entry, counted rows only
  const counts = rec.countsFrom([
    { kind: 'trades', entry: 'b-tomes-son', key: 'k1', status: 'counted' },
    { kind: 'trades', entry: 'b-tomes-son', key: 'k1', status: 'counted' },
    { kind: 'trades', entry: 'b-tomes-son', key: 'k2', status: 'counted' },
    { kind: 'eat', entry: 'boot-inn', key: 'k1', status: 'counted' },
    { kind: 'eat', entry: 'boot-inn', key: 'k3', status: 'sent' },
    { kind: 'eat', entry: 'boot-inn', key: 'k4', status: 'already' },
    { kind: 'nope', entry: 'x', key: 'k1', status: 'counted' },
  ]);
  assert.deepEqual(counts, { trades: { 'b-tomes-son': 2 }, eat: { 'boot-inn': 1 } });
  w = world([{ kind: 'eat', entry: 'boot-inn', key: 'k1', status: 'counted' }]);
  assert.equal(await rec.run({ action: 'counts', countsFile }, w.deps), 'changed');
  assert.equal(await rec.run({ action: 'counts', countsFile }, w.deps), 'unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(countsFile, 'utf8')), { trades: {}, eat: { 'boot-inn': 1 } });

  // every listed entry has a unique, well-formed id
  for (const [file, list] of [['trades.json', 'trades'], ['eat.json', 'places']]) {
    const ids = require(`../src/_data/${file}`)[list].map((e) => e.id);
    assert.ok(ids.every((id) => /^[a-z0-9-]{1,80}$/.test(id || '')), `${file}: an entry has no id`);
    assert.equal(new Set(ids).size, ids.length, `${file}: duplicate ids`);
  }

  await assert.rejects(rec.run({ action: 'send', id: 'bad', ms: MS }, w.deps), /malformed/);

  // logs never carry an address, entry or key
  const all = logs.join('\n');
  assert.ok(!/@|b-tomes|boot-inn|k1|[0-9a-f]{24}/.test(all), `log leaked something:\n${all}`);

  console.log = realLog;
  console.log('test-recommend: all passed');
})().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
