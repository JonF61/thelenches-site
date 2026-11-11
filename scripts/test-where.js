// Offline test for "Where in the Lenches?" (11 Nov 2026): select.js whereFor gives this issue's close-up
// and the answer to the latest earlier puzzle (last 14 days); render.js shows them after Notices.
// Usage: node scripts/test-where.js [preview-dir]   (writes where-12nov.html and where-19nov.html)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { select } = require('./newsletter/select');
const { render } = require('./newsletter/render');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/_data/wherelenches.json'), 'utf8'));
let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

for (const [k, e] of Object.entries(data.entries)) {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(k), `key ${k}`);
  for (const f of ['puzzle', 'photo']) {
    ok(/^\/images\/[\w./-]+\.jpe?g$/i.test(e[f] || '') && fs.existsSync(path.join(ROOT, 'src', e[f])), `${f} file for ${k}`);
  }
  ok(typeof e.answer === 'string' && e.answer.trim().length > 10, `answer for ${k}`);
}

const SITE = 'https://thelenches.org.uk';
const jpegFor = (u) => (fs.existsSync(path.join(ROOT, 'src', u)) ? `${SITE}${u}` : '');
const base = { pending: [], whatson: { events: [], notices: [{ title: 'Hall car park', body: 'Closed.' }] }, bins: {}, siteupdates: { entries: [] },
  issues: [], settings: {}, sources: [], onthisday: { entries: {} }, wherelenches: data, jpegFor };

const first = select({ ...base, issueDate: '2026-11-12' });
ok(first.where && first.where.puzzle && !first.where.answer, '12 Nov: puzzle only');
const next = select({ ...base, issueDate: '2026-11-19' });
ok(next.where && next.where.answer && !next.where.puzzle && /St Peter's Church, Rous Lench/.test(next.where.answer.text), '19 Nov: answer only');
ok(select({ ...base, issueDate: '2026-12-03' }).where === null, 'answer not shown after 14 days');
ok(select({ ...base, issueDate: '2026-11-12', wherelenches: undefined }).where === null, 'no file = null');
ok(select({ ...base, issueDate: '2026-11-12', jpegFor: () => '' }).where === null, 'missing image = null');

const a = render(first);
const b = render(next);
const at = a.html.indexOf('Where in the Lenches?');
ok(at > a.html.indexOf('>Notices<') && at < a.html.indexOf('>Bins<'), 'after Notices, before Bins');
ok(a.html.includes('2026-11-12-rous-lench-door-hinges.jpg') && !a.html.includes('Rous Lench.'), 'puzzle never gives the answer away');
ok(!/reply/i.test(a.html.slice(at, a.html.indexOf('>Bins<'))), 'no replies asked for');
ok(b.html.includes("LAST WEEK'S ANSWER") && b.html.includes('rous-lench-img-3120.jpg'), 'answer with photo');
ok(a.text.includes('See this week\'s close-up:') && b.text.includes("Last week's answer: The scrolled"), 'text version');

const dir = process.argv[2];
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'where-12nov.html'), a.html);
  fs.writeFileSync(path.join(dir, 'where-19nov.html'), b.html);
}
console.log(`test-where: ${checks} checks passed`);
