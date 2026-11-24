// scripts/test-redraft-parse.js
// Offline test (24 Nov 2026): Claude's JSON answers with raw line breaks still read
// (replies.js parseJsonLoose, after a Redraft failed with "no usable answer"), and a
// full stop after a written-out date is kept (normaliseDates, MON_RE / WD_RE).
// Run: node scripts/test-redraft-parse.js
'use strict';

const assert = require('assert');
process.env.ANTHROPIC_API_KEY = 'test';
const r = require('./ingest/replies');

assert.deepStrictEqual(r.parseJsonLoose('{"draft": "a\\nb"}'), { draft: 'a\nb' });
assert.deepStrictEqual(r.parseJsonLoose('Here you go:\n{"draft": "Line one.\n\nLine two 🎄 \\"quoted\\"\tend"}\nThanks'),
  { draft: 'Line one.\n\nLine two 🎄 "quoted"\tend' });
assert.strictEqual(r.parseJsonLoose('no json here'), null);
assert.strictEqual(r.parseJsonLoose('{"draft": "cut off'), null);

assert.strictEqual(r.normaliseDates('out on 26 November. The Wreath on 3 and 10 December. Then'),
  'out on 26 November. The Wreath on 3 and 10 December. Then');
assert.strictEqual(r.normaliseDates('on Sat. 12th Nov. 2026', '2026-11-24'), 'on Saturday 12 November');
assert.strictEqual(r.normaliseDates('Monday, 9th of November, at noon', '2026-11-01'), 'Monday 9 November, at noon');
assert.strictEqual(r.normaliseDates('until Sunday 13 December.'), 'until Sunday 13 December.');

// A bulleted list keeps one item per line; ordinary wrapped lines still join (24 Nov).
const urls = new Set(['https://thelenches.org.uk/events/']);
assert.strictEqual(r.sanitiseAnswer('Where they stand:\n- Cash Bingo is in this issue.\n- Carols on 10\nDecember.\n\nSee https://thelenches.org.uk/events/ for more.', urls),
  'Where they stand:\n- Cash Bingo is in this issue.\n- Carols on 10 December.\n\nSee\nhttps://thelenches.org.uk/events/\nfor more.');
assert.strictEqual(r.sanitiseAnswer('One line\nwrapped here, nothing else to see.', urls), 'One line wrapped here, nothing else to see.');

// The opt-out line after the sign-off: in italics in the email; a redraft leaves it out (24 Nov).
const opt = r.fill('outreach_optout');
const body = ['Hi Rhona,', 'Some news.', r.fill('signature'), opt].join('\n\n');
assert.strictEqual(r.innerBody(body), 'Some news.');
assert.ok(r.textToHtml(body).includes(`<em>${opt.replace(/'/g, '&#39;')}</em>`), 'opt-out in italics');

// Only a first email to someone carries the opt-out line (24 Nov).
const sentRows = [{ to: 'Rhona@Example.org', status: 'sent', sent_at: '2026-11-24 13:42' }, { to: 'new@example.org', status: 'awaiting' }];
assert.strictEqual(r.optoutFor(sentRows, 'rhona@example.org'), '');
assert.strictEqual(r.optoutFor(sentRows, 'new@example.org'), opt);
assert.strictEqual(r.emailedBefore(sentRows, 'nobody@example.org'), false);

console.log('test-redraft-parse: all passed');
