// scripts/test-rimmer.js: offline test of Rimmer (scripts/rimmer): text from HTML, the
// request it sends Claude, cleaning findings, dismissed ones passed back, and a whole run with
// the Sheet and Claude mocked (old open findings replaced, new ones appended).
// Run: node scripts/test-rimmer.js (the listings/site parts need an Eleventy build in _site).
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const c = require('./rimmer');

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
for (const k of Object.keys(nr[0])) assert.ok(c.HEADERS.includes(k), k);
// mailto: targets are shown; table cells are not pipe-separated (3 Nov: two false alarms).
// The Lenches badge reads as a marker, on the site and in the newsletter (5 Nov).
assert.equal(c.htmlToText('<h3>Quiz — The Lenches Club <span class="lenches-badge" data-pagefind-ignore>Lenches</span></h3>'), '### Quiz — The Lenches Club [Lenches badge]');
assert.match(c.htmlToText('<table><tr><td style="x">Quiz</td><td><table><tr><td bgcolor="#fbe6d6" style="background:#fbe6d6;">Lenches</td></tr></table></td></tr></table>'), /^Quiz \[Lenches badge\]$/);
assert.match(c.SYSTEM, /\[Lenches badge\]/);
assert.equal(c.htmlToText('<p><a href="mailto:bids@club.org">Bid: email the club</a></p>'), 'Bid: email the club (bids@club.org)');
assert.equal(c.htmlToText('<table><tr><td>The Club</td><td></td><td>Lenches</td></tr></table>'), 'The Club Lenches');

// A whole listings run, Sheet and Claude mocked.
(async () => {
  if (!fs.existsSync(path.join(__dirname, '..', '_site', 'events', 'index.html'))) {
    console.log('rimmer: run Eleventy first for the run test; other tests passed');
    return;
  }
  const sheet = [
    { _row: 2, id: 'K1-l1', scope: 'listings', status: 'open', created_at: '2026-11-01 19:17' },
    { _row: 3, id: 'K1-n1', scope: 'newsletter', status: 'open', created_at: '2026-11-01 18:37' },
  ];
  const updates = [];
  let appended = [];
  const g = {
    ensureTab: async (tab, headers) => { assert.equal(tab, 'Rimmer'); assert.deepEqual(headers, c.HEADERS); },
    readTable: async () => sheet,
    updateRow: async (tab, row, fields) => updates.push([row, fields]),
    appendRows: async (tab, objs) => { appended = objs; },
  };
  let sent;
  let hollyCalls = 0;
  const client = { messages: { create: async (r) => {
    if (r.tools[0].name === 'propose_fix') {
      // Holly drafts the fix in the same run: one change to the first candidate's first field.
      hollyCalls += 1;
      const c0 = JSON.parse(r.messages[0].content[0].text.split('\n\nCalendar:')[0]).candidates[0];
      const [field, text] = Object.entries(c0.fields)[0];
      return { stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'tool_use', name: 'propose_fix', input: { source: c0.key, field, new_value: `${text} (fixed)`, reason: 'Test.' } }] };
    }
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
  assert.equal(hollyCalls, 1);
  assert.equal(appended[0].fix_status, 'offered');
  assert.match(appended[0].fix_new, / \(fixed\)$/);
  assert.equal(appended[0].status, 'open');
  // Turned off: no Holly call, the finding waits for Fix….
  process.env.RIMMER_AUTOFIX = 'off';
  updates.length = 0;
  await c.run('listings', { g, client, nowMs: now });
  delete process.env.RIMMER_AUTOFIX;
  assert.equal(hollyCalls, 1);
  assert.equal(appended[0].fix_status, undefined);
  // A fix Holly drafted in an earlier run is replaced by the next run; one Jon asked for is kept.
  sheet.push({ _row: 4, id: 'K1-l2', scope: 'listings', status: 'open', fix_status: 'offered' }, { _row: 5, id: 'K1-l3', scope: 'listings', status: 'open', fix_status: 'proposed' });
  updates.length = 0;
  await c.run('listings', { g, client, nowMs: now });
  assert.deepEqual(updates.map((u) => u[0]), [2, 4]);
  sheet.splice(3, 2);
  await assert.rejects(c.run('bogus', { g, client }), /Unknown scope/);
  // A cut-off answer (max_tokens) fails and replaces nothing (3 Nov: 0 findings at 4000 tokens).
  updates.length = 0; appended = null;
  const cut = { messages: { create: async () => ({ stop_reason: 'max_tokens', usage: {}, content: [{ type: 'tool_use', name: 'report_findings', input: {} }] }) } };
  await assert.rejects(c.run('listings', { g, client: cut, nowMs: now }), /ran out of room/);
  assert.deepEqual(updates, []);
  assert.equal(appended, null);
  assert.ok(sent.max_tokens >= 16000, 'room to think');
  console.log('rimmer: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

// Newsletter check reads the website pages beside the issue and compares them (10 Nov).
{
  const both = c.buildRequest({ scope: 'newsletter', docs: [{ page: 'newsletter', text: 'Body' }, { page: '/events/', text: 'Site' }], today: '2026-11-10', dismissed: [], issueDate: '2026-11-12' });
  assert.match(both.messages[0].content, /Check the newsletter against them/);
  assert.match(both.messages[0].content, /never report website items that are not in the newsletter/);
  assert.match(both.messages[0].content, /=== \/events\/ ===\nSite/);
  const alone = c.buildRequest({ scope: 'newsletter', docs: [{ page: 'newsletter', text: 'Body' }], today: '2026-11-10', dismissed: [], issueDate: '2026-11-12' });
  assert.doesNotMatch(alone.messages[0].content, /Check the newsletter against them/);
  const docs = [{ page: 'newsletter' }, { page: '/events/' }];
  assert.equal(c.cleanFindings({ findings: [{ page: '/events/', problem: 'p' }] }, 'newsletter', docs)[0].page, '/events/');
  assert.equal(c.cleanFindings({ findings: [{ page: '/elsewhere/', problem: 'p' }] }, 'newsletter', docs)[0].page, 'newsletter');
  assert.deepEqual(c.NEWSLETTER_SITE_PAGES, ['/events/', '/notices/', '/living-here/roads/', '/regulars/']);
  console.log('rimmer newsletter-vs-site: ok');
}
