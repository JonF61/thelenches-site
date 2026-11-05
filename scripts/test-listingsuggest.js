// scripts/test-listingsuggest.js
// Offline tests for the Listing suggestion workflow script (scripts/listingsuggest): send (the
// confirmation email's approved wording and signed /sg link), confirm (and late / replayed),
// approve (the entry as suggested or as Jon edited it, with a fixed listingId, written into a
// copy of trades.json / eat.json in the right place), approved (row marked, address wiped),
// reject (reason from the event file, address wiped), the 30-day wipes, and that nothing logged
// contains an address, name or why. Google and Gmail are faked. Run: node scripts/test-listingsuggest.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APPROVAL_SIGNING_KEY = 'test-key';
process.env.WORKER_URL = 'https://approvals.example.workers.dev';

const sg = require('./listingsuggest');
const { signToken } = require('./ingest/links');

const MS = Date.UTC(2026, 10, 3, 10, 0);
const ID = 'sg-20261103-abc123';
const TAB = 'Listing suggestions';
const DATA = path.join(__dirname, '..', 'src', '_data');

function world(rows) {
  const tabs = { [TAB]: rows, Recommendations: [] };
  const sent = [];
  const g = {
    ensureTab: async () => false,
    readTable: async (tab) => tabs[tab].map((r, i) => ({ _row: i + 2, ...r })),
    readSettings: async () => ({ settings: { from_name: 'The Lenches Website and Newsletter Team' } }),
    fromNameFor: (s) => s.from_name,
    sendMail: async (m) => { sent.push(m); return 'msg1'; },
    appendRows: async (tab, objs) => { tabs[tab].push(...objs); },
    updateRow: async (tab, row, fields) => { Object.assign(tabs[tab][row - 2], fields); },
  };
  return { tabs, sent, deps: { g, signToken } };
}

const base = (extra) => ({
  id: ID, requested: '2026-11-03 09:55', kind: 'trades', name: 'Smith Electrical', trade: 'chimney sweeps', contact: '07700 900123',
  area: 'Rous Lench', why: 'Secret why words', email: 'reader@example.org', key: 'k', status: 'new', ...extra,
});

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  for (const f of ['trades.json', 'eat.json']) fs.copyFileSync(path.join(DATA, f), path.join(tmp, f));
  const stateFile = path.join(tmp, 'state.json');

  // send: the approved wording and a signed /sg link
  let w = world([base()]);
  assert.equal(await sg.run({ action: 'send', id: ID, ms: MS }, w.deps), 'sent');
  assert.equal(w.sent.length, 1);
  const m = w.sent[0];
  assert.equal(m.to, 'reader@example.org');
  assert.equal(m.from, 'website@thelenches.org.uk');
  assert.equal(m.subject, 'Please confirm your suggestion: The Lenches website');
  assert.ok(m.text.startsWith('Hello,\n\nSomeone, hopefully you, suggested Smith Electrical for the Local trades page of thelenches.org.uk.\n\nYes, send my suggestion:\nhttps://approvals.example.workers.dev/sg?t='));
  assert.match(m.text, /This link works for 7 days\. Once you confirm, we'll take a look before adding it\. If you didn't ask, just ignore this email\./);
  assert.match(m.html, /Yes, send my suggestion/);
  const url = m.text.match(/https:\/\/approvals\.example\.workers\.dev\/sg\?t=\S+/)[0];
  const payload = JSON.parse(Buffer.from(url.split('t=')[1].split('.')[0], 'base64url'));
  assert.deepEqual({ a: payload.a, i: payload.i, k: payload.k }, { a: 'sug', i: ID, k: 'trades' });
  assert.ok(payload.e - MS / 1000 === 7 * 86400);
  assert.equal(w.tabs[TAB][0].status, 'sent');
  assert.equal(await sg.run({ action: 'send', id: ID, ms: MS }, w.deps), 'skipped', 'a replay sends nothing');
  assert.equal(w.sent.length, 1);

  // confirm
  w.tabs[TAB][0].sent_at = '2026-11-03 10:00';
  assert.equal(await sg.run({ action: 'confirm', id: ID, ms: MS + 3600e3 }, w.deps), 'confirmed');
  assert.equal(w.tabs[TAB][0].status, 'confirmed');
  assert.equal(w.tabs[TAB][0].email, 'reader@example.org', 'kept until decided or 30 days');
  assert.equal(await sg.run({ action: 'confirm', id: ID, ms: MS }, w.deps), 'skipped');

  // late confirm
  let late = world([base({ status: 'sent', sent_at: '2026-10-20 10:00' })]);
  assert.equal(await sg.run({ action: 'confirm', id: ID, ms: MS }, late.deps), 'late');

  // approve as suggested: existing section reused, placed after the last chimney sweep
  const before = JSON.parse(fs.readFileSync(path.join(tmp, 'trades.json'), 'utf8'));
  assert.equal(await sg.run({ action: 'approve', id: ID, ms: MS, dataDir: tmp, typed: { body: '' }, stateFile }, w.deps), 'added');
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'trades.json'), 'utf8'));
  assert.equal(after.trades.length, before.trades.length + 1);
  const lastSweep = before.trades.map((t, i) => [t, i]).filter(([t]) => t.trade === 'Chimney sweeps').at(-1)[1];
  assert.deepEqual(after.trades[lastSweep + 1], { id: 'smith-electrical', name: 'Smith Electrical', trade: 'Chimney sweeps', base: 'Rous Lench', phone: '07700 900123' });
  assert.ok(fs.readFileSync(path.join(tmp, 'trades.json'), 'utf8').endsWith('}\n'));
  assert.equal(w.tabs[TAB][0].status, 'confirmed', 'not marked until the commit is pushed');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { id: ID, entry: 'smith-electrical', kind: 'trades', name: 'Smith Electrical', section: 'Chimney sweeps', starred: true });
  // the suggestion is the entry's first recommendation: a counted row (hash only) and the counts file
  const recs = w.tabs.Recommendations;
  assert.equal(recs.length, 1);
  assert.match(recs[0].id, /^rc-20261103-[a-z0-9]{6}$/);
  assert.deepEqual([recs[0].kind, recs[0].entry, recs[0].email, recs[0].status, recs[0].key], ['trades', 'smith-electrical', '', 'counted', require('./recommend').emailKey('reader@example.org')]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'recommends.json'), 'utf8')).trades['smith-electrical'], 1);
  assert.equal(w.sent.length, 1, 'nothing sent before the commit is pushed');

  // approved: thank-you email, marked, address wiped
  assert.equal(await sg.run({ action: 'approved', id: ID, ms: MS, stateFile }, w.deps), 'approved');
  assert.deepEqual([w.tabs[TAB][0].status, w.tabs[TAB][0].entry, w.tabs[TAB][0].email, w.tabs[TAB][0].result], ['approved', 'smith-electrical', '', 'added, thanked']);
  const ty = w.sent[1];
  assert.equal(ty.to, 'reader@example.org');
  assert.equal(ty.subject, 'Thanks — Smith Electrical is now on the website');
  assert.equal(ty.text, 'Hi,\n\nThanks for suggesting Smith Electrical. They\'re now listed on our Local trades page under Chimney sweeps: https://thelenches.org.uk/living-here/trades/#trade-smith-electrical\n\n'
    + 'We\'ve counted your suggestion as a recommendation, so you\'ll see "★ Recommended by 1 person" just under their name.\n\nBest wishes,\nHolly\nLenches website assistant\n');
  assert.match(ty.html, /href="https:\/\/thelenches\.org\.uk\/living-here\/trades\/#trade-smith-electrical"/);
  assert.match(ty.html, /Best wishes,<br>Holly<br>Lenches website assistant/);
  assert.ok(w.tabs[TAB][0].decided_at);
  assert.equal(await sg.run({ action: 'approve', id: ID, ms: MS, dataDir: tmp, typed: { body: '' }, stateFile }, w.deps), 'skipped', 'a replay adds nothing');

  // approve as edited (eat): a taken id gets -2, placed in its area in name order
  const eatBefore = JSON.parse(fs.readFileSync(path.join(tmp, 'eat.json'), 'utf8'));
  const taken = eatBefore.places[0];
  w = world([base({ kind: 'eat', status: 'confirmed', name: taken.name, trade: 'pub', area: 'Evesham' })]);
  const body = JSON.stringify({ name: taken.name, area: 'Evesham', type: 'Pub', dogs: true, website: { text: 'x.co.uk', url: 'https://x.co.uk' } });
  assert.equal(await sg.run({ action: 'approve', id: ID, ms: MS, dataDir: tmp, typed: { body }, stateFile }, w.deps), 'added');
  const eatAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'eat.json'), 'utf8'));
  const added = eatAfter.places.find((p) => p.id === `${taken.id}-2`);
  assert.deepEqual(added, { id: `${taken.id}-2`, name: taken.name, area: 'Evesham', type: 'Pub', website: { text: 'x.co.uk', url: 'https://x.co.uk' }, dogs: true });
  assert.deepEqual(eatAfter.areas, eatBefore.areas);
  assert.equal(sg.thanksEmail({ kind: 'eat', name: 'The Bell', section: 'Evesham', page: '/living-here/eat/', anchor: 'eat-the-bell' }).text.split('\n')[2],
    'Thanks for suggesting The Bell. They\'re now listed on our Where to eat page, in Evesham: https://thelenches.org.uk/living-here/eat/#eat-the-bell');

  // a bad edited entry is refused, nothing written
  w = world([base({ status: 'confirmed', kind: 'eat' })]);
  const was = fs.readFileSync(path.join(tmp, 'eat.json'), 'utf8');
  await assert.rejects(sg.run({ action: 'approve', id: ID, ms: MS, dataDir: tmp, typed: { body: JSON.stringify({ name: 'X', area: 'Mars', type: 'Pub' }) }, stateFile }, w.deps), /Area must be one of/);
  assert.equal(fs.readFileSync(path.join(tmp, 'eat.json'), 'utf8'), was);

  // reject: reason saved, address wiped, nothing sent
  w = world([base({ status: 'confirmed' })]);
  assert.equal(await sg.run({ action: 'reject', id: ID, ms: MS, typed: { reason: ' Not  local ' } }, w.deps), 'rejected');
  assert.deepEqual([w.tabs[TAB][0].status, w.tabs[TAB][0].reject_reason, w.tabs[TAB][0].email], ['rejected', 'Not local', '']);
  assert.equal(w.sent.length, 0);
  assert.equal(w.tabs.Recommendations.length, 0, 'a rejection counts nothing');

  // reject reason read from the event file
  const ev = path.join(tmp, 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ client_payload: { action: 'reject', id: ID, reason: 'From the event file' } }));
  process.env.GITHUB_EVENT_PATH = ev;
  w = world([base({ status: 'confirmed' })]);
  await sg.run({ action: 'reject', id: ID, ms: MS }, w.deps);
  assert.equal(w.tabs[TAB][0].reject_reason, 'From the event file');
  delete process.env.GITHUB_EVENT_PATH;

  // 30-day wipes: unconfirmed -> expired; confirmed 30+ days ago -> address wiped, still waiting
  w = world([
    base({ id: 'sg-20261001-aaaaaa', requested: '2026-10-01 09:00', status: 'sent', email: 'old@example.org' }),
    base({ id: 'sg-20261001-bbbbbb', requested: '2026-10-01 09:00', status: 'confirmed', confirmed_at: '2026-10-02 09:00', email: 'conf@example.org' }),
    base({ status: 'new' }),
  ]);
  await sg.run({ action: 'send', id: ID, ms: MS }, w.deps);
  assert.deepEqual([w.tabs[TAB][0].status, w.tabs[TAB][0].email], ['expired', '']);
  assert.deepEqual([w.tabs[TAB][1].status, w.tabs[TAB][1].email], ['confirmed', '']);
  assert.equal(w.tabs[TAB][2].email, 'reader@example.org');

  // bad ids and actions
  await assert.rejects(sg.run({ action: 'send', id: 'rc-20261103-abc123', ms: MS }, w.deps), /SUGGEST_ID/);
  await assert.rejects(sg.run({ action: 'publish', id: ID, ms: MS }, w.deps), /ACTION/);

  // nothing private in the logs
  const all = logs.join('\n');
  for (const secret of ['example.org', 'Secret why', 'Smith', 'Rous', '07700']) assert.ok(!all.includes(secret), `log has ${secret}`);

  console.log = realLog;
  console.log('test-listingsuggest: all passed');
})().catch((e) => {
  console.log = realLog;
  console.error(e);
  process.exit(1);
});
