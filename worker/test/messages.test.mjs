// worker/test/messages.test.mjs
// Offline tests for a contact's message history (admin/messages.js).
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { history, historyQuery, addressIn } from '../src/admin/messages.js';

const ctx = { addresses: ['sue@example.org', 'sue@work.example'], hollyIds: new Set(['h1']) };
const m = (id, at, from, text, extra = {}) => ({ id, internalDate: String(Date.parse(at)), from, subject: 'Coffee morning', text, ...extra });

test('historyQuery: every address, from or to, newsletter left out', () => {
  assert.equal(historyQuery(['a@x.org', 'b@y.org']), '{from:a@x.org to:a@x.org from:b@y.org to:b@y.org} -subject:"The Lenches Newsletter"');
  assert.equal(addressIn('Sue Smith <Sue@Example.org>'), 'sue@example.org');
});

test('history: newest first, who wrote it, padding cut', () => {
  const out = history([
    m('t1', '2026-10-30T09:00:00Z', 'Sue Smith <sue@example.org>', 'When is it?\n\nSue\n--\nSue Smith, Hall committee\n\nOn Mon, 1 Oct, someone wrote:\n> old stuff'),
    m('h1', '2026-10-30T10:00:00Z', 'The Lenches Website and Newsletter Team <website@thelenches.org.uk>',
      "Hi Sue,\n\nIt's on Saturday at 10am.\n\nBest wishes,\nHolly\nLenches website assistant"),
    m('h2', '2026-10-31T10:00:00Z', 'Lenches <website@thelenches.org.uk>',
      "Hi Sue,\n\nYour class is listed.\n\nIf you'd rather we didn't get in touch like this, just say and we won't.\n\nBest wishes,\nHolly\nLenches website assistant"),
    m('y1', '2026-11-01T08:00:00Z', 'Jon <jon@thelenches.org.uk>', 'Thanks Sue, see you there.\n\nOn Sat, Sue wrote:\n> When is it?'),
    m('w1', '2026-11-01T09:00:00Z', 'Sue <sue@work.example>', 'Great, thanks!'),
    m('n1', '2026-10-29T07:00:00Z', 'website@thelenches.org.uk', 'Newsletter', { subject: 'The Lenches Newsletter – Thursday 29 October' }),
    m('s1', '2026-10-28T07:00:00Z', 'website@thelenches.org.uk', 'Confirm', { auto: 'auto-generated' }),
  ], ctx);
  assert.deepEqual(out.map((e) => [e.id, e.who]), [['w1', 'them'], ['y1', 'you'], ['h2', 'holly'], ['h1', 'holly'], ['t1', 'them']]);
  assert.equal(out.find((e) => e.id === 't1').text, 'When is it?\n\nSue');
  assert.equal(out.find((e) => e.id === 'h1').text, "Hi Sue,\n\nIt's on Saturday at 10am.");
  assert.equal(out.find((e) => e.id === 'h2').text, 'Hi Sue,\n\nYour class is listed.');
  assert.equal(out.find((e) => e.id === 'y1').text, 'Thanks Sue, see you there.');
  assert.equal(out[0].at, '2026-11-01T09:00:00.000Z');
});

test('history: duplicates dropped', () => {
  const a = m('t1', '2026-10-30T09:00:00Z', 'sue@example.org', 'Hello there');
  assert.equal(history([a, a], ctx).length, 1);
});
