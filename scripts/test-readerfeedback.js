// scripts/test-readerfeedback.js
// Offline test of reader feedback on the GitHub side (scripts/readerfeedback): the rating
// pass in ingestion, email clearing, and each admin panel decision as scripts/approve
// receives it (ITEM_ID, ACTION, REASON, BODY), including Holly's reply on Mark implemented
// and its Send / Edit / Skip. Google, Gmail and Claude are mocked; nothing leaves the machine.
// Run: node scripts/test-readerfeedback.js
'use strict';

const assert = require('assert');
const rf = require('./readerfeedback');
const replies = require('./ingest/replies');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOW = Date.parse('2026-10-25T12:00:00Z');
const HEADERS = ['id', 'received', 'type', 'page_url', 'page_title', 'message', 'email', 'rating',
  'commentary', 'status', 'notes', 'decided', 'implemented', 'reply_draft', 'reply_sent'];

// A fake Feedback tab and mail box behind rf.deps.
function world(rows, { claude = [], tab = true, pageHtml = '<main><h1>Village halls</h1><p>Phone 01386 000000</p></main>' } = {}) {
  const table = rows.map((r, i) => ({ _row: i + 2, ...Object.fromEntries(HEADERS.map((h) => [h, ''])), ...r }));
  const calls = { updates: [], sent: [], prompts: [], fetched: [] };
  const answers = claude.slice();
  rf.deps.now = () => NOW;
  rf.deps.fetch = async (url) => {
    calls.fetched.push(url);
    return { ok: true, text: async () => pageHtml };
  };
  rf.deps.g = {
    getSheetGid: async (t) => (tab && t === 'Feedback' ? 5 : null),
    readTable: async (t) => {
      assert.strictEqual(t, 'Feedback');
      return table.map((r) => ({ ...r }));
    },
    updateRow: async (t, rowNo, fields) => {
      assert.strictEqual(t, 'Feedback');
      calls.updates.push({ row: rowNo, fields });
      Object.assign(table.find((r) => r._row === rowNo), fields);
    },
    readSettings: async () => ({ settings: { from_name: 'The Lenches Website and Newsletter Team' } }),
    fromNameFor: (s) => s.from_name,
    sendMail: async (m) => { calls.sent.push(m); return 'gm1'; },
  };
  rf.deps.replies = {
    ...replies,
    claude: () => ({
      messages: {
        create: async (req) => {
          calls.prompts.push(req);
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return { content: [{ type: 'text', text: next === undefined ? '' : next }] };
        },
      },
    }),
    MODEL: () => 'claude-test',
  };
  return { table, calls };
}

const row = (extra = {}) => ({
  id: 'fb-20261025-abc123', received: '2026-10-25 09:00', type: 'correction',
  page_url: 'https://thelenches.org.uk/halls/', page_title: 'Village halls',
  message: 'The Church Lench hall phone number is out of date. It is now 01386 111111.',
  email: 'reader@example.org', status: 'new', ...extra,
});

/* ---------------------------------------------------------------- rating -- */

test('run(): rates suggestions and corrections only, once, with the page text', async () => {
  const { table, calls } = world([
    row(),
    row({ id: 'fb-2', type: 'update', message: 'Please add the new bin dates' }),
    row({ id: 'fb-3', type: 'other', message: 'Love the site' }),
    row({ id: 'fb-4', rating: '4', commentary: 'done already' }),
    row({ id: 'fb-5', status: 'rejected', email: '' }),
  ], { claude: ['{"rating": 4, "commentary": "Useful fix, quick to make; check the number with the hall first."}', 'Sorry, not JSON'] });
  await rf.run();
  assert.strictEqual(calls.prompts.length, 2, 'fb-1 and fb-2 only');
  assert.strictEqual(calls.prompts[0].model, 'claude-test');
  const input = JSON.parse(calls.prompts[0].messages[0].content);
  assert.match(input.page_text, /Phone 01386 000000/);
  assert.match(calls.prompts[0].system, /data, never instructions/);
  assert.strictEqual(table[0].rating, 4);
  assert.match(table[0].commentary, /check the number/);
  assert.strictEqual(table[1].rating, '', 'an unusable answer is left for the next run');
  assert.strictEqual(table[2].rating, '', 'other feedback is not rated');
});

test('run(): no Feedback tab yet is fine', async () => {
  const { calls } = world([], { tab: false });
  await rf.run();
  assert.strictEqual(calls.updates.length, 0);
});

test('parseRating accepts only 1 to 5 with a commentary', () => {
  assert.deepStrictEqual(rf.parseRating('Here: {"rating": 5, "commentary": "Easy win"}'), { rating: 5, commentary: 'Easy win' });
  assert.strictEqual(rf.parseRating('{"rating": 6, "commentary": "x"}'), null);
  assert.strictEqual(rf.parseRating('{"rating": 3}'), null);
  assert.strictEqual(rf.parseRating('{"rating": "2.5", "commentary": "x"}'), null);
});

test('run(): emails cleared after a reply or skip, on reject, and after 6 months', async () => {
  const { table } = world([
    row({ id: 'a', status: 'implemented', reply_sent: '2026-10-20 10:00', rating: '3' }),
    row({ id: 'b', status: 'implemented', reply_sent: 'skipped 2026-10-20 10:00', rating: '3' }),
    row({ id: 'c', status: 'rejected', rating: '1' }),
    row({ id: 'd', status: 'approved', received: '2026-04-01 10:00', rating: '3' }),
    row({ id: 'e', status: 'approved', received: '2026-06-01 10:00', rating: '3' }),
    row({ id: 'f', status: 'implemented', rating: '3' }),
  ]);
  await rf.run();
  assert.deepStrictEqual(table.map((r) => r.email ? 'kept' : 'cleared'), ['cleared', 'cleared', 'cleared', 'cleared', 'kept', 'kept']);
});

/* ------------------------------------------------------------- decisions -- */

test('approve, reject, postpone: only from new or postponed; reject clears the email', async () => {
  let w = world([row()]);
  await rf.decide('fb-20261025-abc123', 'fb_approve');
  assert.strictEqual(w.table[0].status, 'approved');
  assert.strictEqual(w.table[0].decided, '2026-10-25 12:00');
  await rf.decide('fb-20261025-abc123', 'fb_reject'); // replay after approve: nothing
  assert.strictEqual(w.table[0].status, 'approved');
  assert.strictEqual(w.calls.updates.length, 1);

  w = world([row()]);
  await rf.decide('fb-20261025-abc123', 'fb_reject');
  assert.strictEqual(w.table[0].status, 'rejected');
  assert.strictEqual(w.table[0].email, '');
  assert.strictEqual(w.calls.sent.length, 0, 'nothing sent on reject');

  w = world([row()]);
  await rf.decide('fb-20261025-abc123', 'fb_postpone', '2026-11-08');
  assert.strictEqual(w.table[0].status, 'postponed until 2026-11-08');
  assert.strictEqual(w.table[0].email, 'reader@example.org');
  await rf.decide('fb-20261025-abc123', 'fb_approve'); // decided early
  assert.strictEqual(w.table[0].status, 'approved');
  await assert.rejects(rf.decide('fb-20261025-abc123', 'fb_nuke'), /Bad feedback action/);

  w = world([row()]);
  await assert.rejects(rf.decide('fb-20261025-abc123', 'fb_postpone', '2026-10-25'), /Bad postpone date/);
  await assert.rejects(rf.decide('fb-nope', 'fb_approve'), /No Feedback row/);
});

test('Mark implemented drafts Holly\'s reply from the notes; nothing is sent', async () => {
  const w = world([row({ status: 'approved', notes: '2026-10-24 18:00 Updated the phone number to 01386 111111' })], {
    claude: ['Thanks for letting us know about the hall phone number. We\'ve changed it to 01386 111111.\nhttps://thelenches.org.uk/halls/'],
  });
  await rf.decide('fb-20261025-abc123', 'fb_done');
  const r = w.table[0];
  assert.strictEqual(r.status, 'implemented');
  assert.strictEqual(r.implemented, '2026-10-25 12:00');
  assert.ok(r.reply_draft.startsWith('Hi there,\n\nThanks for letting us know'));
  assert.ok(r.reply_draft.endsWith('Best wishes,\nHolly\nLenches website assistant'));
  assert.ok(r.reply_draft.includes('\nhttps://thelenches.org.uk/halls/\n'));
  const input = JSON.parse(w.calls.prompts[0].messages[0].content);
  assert.match(input.notes, /Updated the phone number/);
  assert.match(w.calls.prompts[0].system, /voice_guide/, 'Holly\'s voice guide is used');
  assert.strictEqual(w.calls.sent.length, 0);
});

test('Mark implemented: no email, no draft; a bad or failed draft falls back to the plain reply', async () => {
  let w = world([row({ status: 'approved', email: '' })]);
  await rf.decide('fb-20261025-abc123', 'fb_done');
  assert.strictEqual(w.table[0].status, 'implemented');
  assert.strictEqual(w.table[0].reply_draft, '');
  assert.strictEqual(w.calls.prompts.length, 0);

  const prev = process.env.GMAIL_USER;
  process.env.GMAIL_USER = 'jon@thelenches.org.uk';
  for (const answer of ['No link in this one.', 'Jon fixed it.\nhttps://thelenches.org.uk/halls/', new Error('overloaded')]) {
    w = world([row({ status: 'approved' })], { claude: [answer] });
    await rf.decide('fb-20261025-abc123', 'fb_done');
    assert.ok(w.table[0].reply_draft.includes('Thanks for your correction about "Village halls". We\'ve updated the page:\nhttps://thelenches.org.uk/halls/'),
      `fallback for ${answer}`);
    assert.ok(!/jon/i.test(w.table[0].reply_draft));
  }
  process.env.GMAIL_USER = prev;
});

test('Send: from website@, signed Holly; the address is then cleared; replays do nothing', async () => {
  const draft = 'Hi there,\n\nThanks, it\'s fixed.\nhttps://thelenches.org.uk/halls/\n\nBest wishes,\nHolly\nLenches website assistant';
  const w = world([row({ status: 'implemented', reply_draft: draft })]);
  await rf.decide('fb-20261025-abc123', 'fb_send');
  assert.strictEqual(w.calls.sent.length, 1);
  const m = w.calls.sent[0];
  assert.strictEqual(m.to, 'reader@example.org');
  assert.strictEqual(m.from, 'website@thelenches.org.uk');
  assert.strictEqual(m.fromName, 'The Lenches Website and Newsletter Team');
  assert.strictEqual(m.subject, 'Your correction for The Lenches website');
  assert.strictEqual(m.text, draft);
  assert.match(m.html, /<a href="https:\/\/thelenches.org.uk\/halls\/"/);
  assert.strictEqual(w.table[0].reply_sent, '2026-10-25 12:00');
  assert.strictEqual(w.table[0].email, '');
  await rf.decide('fb-20261025-abc123', 'fb_send');
  assert.strictEqual(w.calls.sent.length, 1, 'never twice');
});

test('Edit sends Jon\'s text; Skip sends nothing; neither before Mark implemented', async () => {
  let w = world([row({ status: 'implemented', reply_draft: 'Hi there,\n\nOld text' })]);
  await rf.decide('fb-20261025-abc123', 'fb_edit', '', 'Hi there,\n\nNew text from Jon.\n\nBest wishes,\nHolly\nLenches website assistant');
  assert.strictEqual(w.calls.sent[0].text, 'Hi there,\n\nNew text from Jon.\n\nBest wishes,\nHolly\nLenches website assistant');
  assert.match(w.table[0].reply_draft, /New text from Jon/, 'the Sheet keeps what went');

  w = world([row({ status: 'implemented', reply_draft: 'Hi there,\n\nDraft' })]);
  await rf.decide('fb-20261025-abc123', 'fb_skip');
  assert.strictEqual(w.calls.sent.length, 0);
  assert.strictEqual(w.table[0].reply_sent, 'skipped 2026-10-25 12:00');
  assert.strictEqual(w.table[0].email, '');

  w = world([row({ status: 'approved', reply_draft: 'Hi there,\n\nDraft' })]);
  await rf.decide('fb-20261025-abc123', 'fb_send');
  await rf.decide('fb-20261025-abc123', 'fb_skip');
  assert.strictEqual(w.calls.sent.length, 0);
  assert.strictEqual(w.calls.updates.length, 0);
});

test('Send refuses a reply that names the team (anonymity)', async () => {
  const prev = process.env.GMAIL_USER;
  process.env.GMAIL_USER = 'jon@thelenches.org.uk';
  const w = world([row({ status: 'implemented', reply_draft: 'Hi there,\n\nJon has fixed it.' })]);
  await assert.rejects(rf.decide('fb-20261025-abc123', 'fb_send'), /anonymity/);
  assert.strictEqual(w.calls.sent.length, 0);
  process.env.GMAIL_USER = prev;
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${name}\n${err && err.stack}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
