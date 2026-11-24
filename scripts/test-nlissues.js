// scripts/test-nlissues.js
// Offline test of which newsletter issues an item is in (24 Nov 2026, Jon:
// scripts/ingest/nlissues.js), the Already listed thanks saying so (replies.js buildBody,
// templates.md listed_nl_*), and sender_items carrying it for Holly (sitechanges.js).
// Run: node scripts/test-nlissues.js
'use strict';

const assert = require('assert');
process.env.ANTHROPIC_API_KEY = 'test';
process.env.RIMMER_REPLIES = 'off';

const nl = require('./ingest/nlissues');
const replies = require('./ingest/replies');
const sitechanges = require('./ingest/sitechanges');

// Tuesday 24 Nov 2026, 3pm UK: the next issue is Thursday 26 Nov.
const TUE = Date.parse('2026-11-24T15:00:00Z');
assert.strictEqual(nl.nextIssue(TUE), '2026-11-26');
assert.strictEqual(nl.nextIssue(Date.parse('2026-11-26T09:00:00Z')), '2026-11-26', 'Thursday morning: that day');
assert.strictEqual(nl.nextIssue(Date.parse('2026-11-26T13:00:00Z')), '2026-12-03', 'Thursday afternoon: next week');

const ev = (date) => nl.plan({ kind: 'event', date }, TUE);
assert.deepStrictEqual(ev('2026-11-27').issues, ['2026-11-26']);
assert.deepStrictEqual(ev('2026-12-11').issues, ['2026-12-03', '2026-12-10']);
assert.deepStrictEqual(ev('2026-12-23').issues, ['2026-12-10', '2026-12-17']);
assert.deepStrictEqual(ev('2026-12-03').issues, ['2026-11-26', '2026-12-03']);
assert.strictEqual(ev('2026-11-25'), null, 'before the next issue');
assert.strictEqual(nl.plan({ kind: 'notice', roads: true }, TUE), null, 'roads: nothing said');
assert.deepStrictEqual(nl.plan({ kind: 'notice', newsletterCount: '1' }, TUE), { issues: [], already: true });
assert.deepStrictEqual(nl.plan({ kind: 'notice', newsletterCount: '0' }, TUE).issues, ['2026-11-26']);
// Hand-written notice added 10 Nov: issues 12, 19, 26 Nov, so this Thursday is its last.
assert.deepStrictEqual(nl.plan({ kind: 'notice', handWritten: true, added: '2026-11-10' }, TUE), { issues: ['2026-11-26'], already: true });
assert.deepStrictEqual(nl.plan({ kind: 'notice', handWritten: true, added: '2026-11-01' }, TUE), { issues: [], already: true });

// Sentences, from templates.md.
const s = (p) => nl.sentence(p, replies.fill, () => true, TUE);
assert.strictEqual(s(ev('2026-11-27')), "It's in this Thursday's newsletter (26 November) too.");
assert.strictEqual(s(ev('2026-12-03')), "It's in this Thursday's newsletter (26 November) too, and again on 3 December.");
assert.strictEqual(s(ev('2026-12-11')), "It'll be in the newsletters on 3 and 10 December.");
assert.strictEqual(s({ issues: ['2026-12-03'], already: false }), "It'll be in the newsletter on 3 December.");
assert.strictEqual(s({ issues: [], already: true }), "It's already been in the newsletter.");
assert.strictEqual(s(null), '');
assert.strictEqual(nl.sentence(ev('2026-11-27'), replies.fill, () => false, TUE), '', 'no template: nothing added');

// Words for Holly.
assert.strictEqual(nl.words(ev('2026-12-03'), TUE), "in this Thursday's issue (26 November) and the 3 December issue");
assert.strictEqual(nl.words({ issues: [], already: true }, TUE), 'already been in the newsletter');

// The Already listed thanks (buildBody uses the real clock: use dates relative to the next issue).
const next = nl.nextIssue();
const add = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const url = 'https://thelenches.org.uk/events/#ev-x';
const one = replies.buildBody({ items: [{ title: 'Cash Bingo', event_date: add(next, 1), policy: [], listed: url, nl: nl.plan({ kind: 'event', date: add(next, 1) }) }], name: 'Rhona' });
assert.ok(one.includes(`so it's all set: ${url}\nIt's in this Thursday's newsletter (${nl.shortDate(next)}) too.`), one);
const later = add(next, 15);
const two = replies.buildBody({ items: [
  { title: 'Cash Bingo', event_date: add(next, 1), policy: [], listed: url, nl: null },
  { title: 'Carols', event_date: later, policy: [], listed: url, nl: nl.plan({ kind: 'event', date: later }) },
], name: 'Rhona' });
assert.ok(two.includes(`We already have "Carols" on the website: ${url}\nIt'll be in the newsletters on`), two);
assert.ok(!two.includes(`all set: ${url}\nIt`), 'no plan, no sentence');

// sender_items carry it.
const items = sitechanges.senderItems([
  { title: 'Wreath Workshop', category: 'event', event_date: '2026-12-11', status: 'approved', from: 'a@b.c', received: '2026-11-20 10:00', id: '1' },
  { title: 'Hamper card', category: 'notice', status: 'approved', newsletter_count: '1', from: 'a@b.c', received: '2026-11-10 10:00', id: '2' },
  { title: 'Not used', category: 'event', event_date: '2026-12-11', status: 'rejected', from: 'a@b.c', received: '2026-11-20 10:00', id: '3' },
], () => true, { today: '2026-11-24', now: TUE });
const by = Object.fromEntries(items.map((i) => [i.title, i.newsletter]));
assert.strictEqual(by['Wreath Workshop'], 'in the 3 December issue and the 10 December issue');
assert.strictEqual(by['Hamper card'], 'already been in the newsletter');
assert.strictEqual(by['Not used'], '');

console.log('test-nlissues: all passed');
