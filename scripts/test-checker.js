// scripts/test-checker.js: offline test of the Checker (scripts/checker): text from HTML, the
// request it sends Claude, cleaning findings, dismissed ones passed back, and a whole run with
// the Sheet and Claude mocked (old open findings replaced, new ones appended).
// Run: node scripts/test-checker.js (the listings/site parts need an Eleventy build in _site).
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const c = require('./checker');

// htmlToText
const t = c.htmlToText('<h2>Events</h2><p>Quiz &amp; chips <a href="https://ex.org/q">Book here</a>, '
  + '<a href="https://thebootinn.com/">thebootinn.com</a> <a href="mailto:a@b.org">a@b.org</a></p><script>x()</script><ul><li>One</li><li>Two</li></ul>');
assert.equal(t, '## Events\nQuiz & chips Book here (https://ex.org/q) , thebootinn.com a@b.org\n\n- One\n- Two');
assert.equal(c.pageContent('<nav>menu</nav><div data-src="./src/x.njk"><p>Hello</p></div><footer>foot</footer>'), 'Hello');

// calendar: weekdays worked out by code
assert.match(c.calendar('2026-11-03', 3, 1), /2026-11-02 Mon, 2 Nov 2026\n2026-11-03 Tue, 3 Nov 2026 \(today\)\n2026-11-04 Wed, 4 Nov 2026\n2026-11-05 Thu, 5 Nov 2026/);

// request
const req = c.buildRequest({ scope: 'newsletter', docs: [{ page: 'newsletter', text: 'Body' }], today: '2026-11-04', dismissed: ['x · y: z'], issueDate: '2026-11-05' });
assert.equal(req.model, 'claude-opus-5-5');
assert.equal(req.tools[0].name, 'report_findings');
assert.match(req.messages[0].content, /next newsletter issue \(2026-11-05\)[\s\S]*Calendar:[\s\S]*dismissed:\n- x · y: z[\s\S]*=== newsletter ===\nBody/);

// cleanFindings
const docs = [{ page: '/events/', text: '' }];
const cf = c.cleanFindings({ findings: [
  { severity: 'problem', page: '/events/', where: 'Quiz', quote: 'Fri 7', problem: 'Wrong day', suggestion: 'Say Saturday' },
  { severity: 'odd', page: '/nope/', where: 'X', problem: 'Maybe' },
  { severity: 'problem', page: '/events/', where: 'Y', problem: '' },
] }, 'listings', docs);
assert.deepEqual(cf.map((f) => [f.severity, f.page, f.problem]), [['problem', '/events/', 'Wrong day'], ['check', '/nope/', 'Maybe']]);
assert.equal(c.cleanFindings({ findings: [{ page: 'whatever', problem: 'p' }] }, 'newsletter', [])[0].page, 'newsletter');
assert.deepEqual(c.cleanFindings({}, 'site', []), []);

// dismissedFor: scope (site also takes listings), last 120 days
const now = Date.parse('2026-11-04T19:00:00Z');
const rows = [
  { scope: 'listings', status: 'dismissed', created_at: '2026-11-01 19:17', page: '/events/', where: 'Quiz', problem: 'Wrong day', quote: 'Fri' },
  { scope: 'listings', status: 'dismissed', created_at: '2026-05-01 19:17', page: '/events/', where: 'Old', problem: 'Old' },
  { scope: 'newsletter', status: 'dismissed', created_at: '2026-11-01 19:17', page: 'newsletter', where: 'N', problem: 'N' },
  { scope: 'site', status: 'open', created_at: '2026-11-01 19:17', page: '/', where: 'S', problem: 'S' },
];
assert.deepEqual(c.dismissedFor(rows, 'site', now), ['/events/ · Quiz: Wrong day ("Fri")']);
assert.deepEqual(c.dismissedFor(rows, 'newsletter', now), ['newsletter · N: N']);

// ids
const nr = c.newRows([{ severity: 'check', page: 'newsletter', where: 'w', quote: '', problem: 'p', suggestion: '' }], { scope: 'newsletter', target: '2026-11-05', nowMs: now });
assert.equal(nr[0].id, 'K202611041900-n1');
assert.equal(nr[0].status, 'open');
assert.deepEqual(Object.keys(nr[0]).sort(), [...c.HEADERS].sort());

// A whole listings run, Sheet and Claude mocked.
(async () => {
  if (!fs.existsSync(path.join(__dirname, '..', '_site', 'events', 'index.html'))) {
    console.log('checker: run Eleventy first for the run test; other tests passed');
    return;
  }
  const sheet = [
    { _row: 2, id: 'K1-l1', scope: 'listings', status: 'open', created_at: '2026-11-01 19:17' },
    { _row: 3, id: 'K1-n1', scope: 'newsletter', status: 'open', created_at: '2026-11-01 18:37' },
  ];
  const updates = [];
  let appended = [];
  const g = {
    ensureTab: async (tab, headers) => { assert.equal(tab, 'Checker'); assert.deepEqual(headers, c.HEADERS); },
    readTable: async () => sheet,
    updateRow: async (tab, row, fields) => updates.push([row, fields]),
    appendRows: async (tab, objs) => { appended = objs; },
  };
  let sent;
  const client = { messages: { create: async (r) => {
    sent = r;
    return { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'report_findings', input: { findings: [
      { severity: 'problem', page: '/events/', where: 'An event', quote: 'q', problem: 'Wrong', suggestion: 'Fix' },
    ] } }] };
  } } };
  const out = await c.run('listings', { g, client, nowMs: now });
  assert.equal(sent.tool_choice.type, 'auto');
  for (const p of c.LISTING_PAGES) assert.ok(JSON.stringify(sent.messages[0].content).includes(`=== ${p} ===`), p);
  assert.deepEqual(updates, [[2, { status: 'replaced' }]]);
  assert.equal(appended.length, 1);
  assert.equal(out[0].target, 'listings pages');
  await assert.rejects(c.run('bogus', { g, client }), /Unknown scope/);
  console.log('checker: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
