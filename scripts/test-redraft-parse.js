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

console.log('test-redraft-parse: all passed');
