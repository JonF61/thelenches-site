// Offline test for the newsletter's "On this day" line (28 Oct 2026): select.js picks the
// entry for the issue's MM-DD from src/_data/onthisday.json; render.js shows it under the
// header (HTML and text) only when there is one. No network, no Sheet.
// Usage: node scripts/test-onthisday.js [preview-dir]   (writes onthisday-with.html / -without.html)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { select } = require('./newsletter/select');
const { render } = require('./newsletter/render');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/_data/onthisday.json'), 'utf8'));
let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

// Every entry: MM-DD key that exists in a leap year, text, an https source.
for (const [k, e] of Object.entries(data.entries)) {
  const m = k.match(/^(\d{2})-(\d{2})$/);
  ok(m && !Number.isNaN(Date.parse(`2028-${k}T12:00:00Z`)) && new Date(`2028-${k}T12:00:00Z`).getUTCDate() === Number(m[2]), `bad key ${k}`);
  ok(typeof e.text === 'string' && e.text.trim().length > 20 && e.text.length < 400, `text for ${k}`);
  ok(/^https:\/\//.test(e.source || ''), `source for ${k}`);
}

const base = {
  pending: [], whatson: { events: [], notices: [] }, bins: {}, siteupdates: { entries: [] },
  issues: [], settings: {}, sources: [], onthisday: data,
};

const withLine = select({ ...base, issueDate: '2026-11-12' });
ok(withLine.onThisDay && /Richard Baxter/.test(withLine.onThisDay.text), 'Baxter on 12 Nov');
ok(select({ ...base, issueDate: '2031-11-12' }).onThisDay, 'any year matches');
const without = select({ ...base, issueDate: '2026-11-13' });
ok(without.onThisDay === null, 'no entry = null');
ok(select({ ...base, onthisday: undefined, issueDate: '2026-11-12' }).onThisDay === null, 'no file = null');
ok(select({ ...base, onthisday: { entries: { '11-12': { text: '  ' } } }, issueDate: '2026-11-12' }).onThisDay === null, 'blank text = null');

const a = render(withLine);
const b = render(without);
ok(a.html.includes('ON THIS DAY') && a.html.includes('Rous Lench Court'), 'HTML has the line');
ok(a.html.indexOf('ON THIS DAY') < a.html.indexOf('This week') || !a.html.includes('This week'), 'line above the summary');
ok(a.text.includes('On this day: In 1615'), 'text has the line');
ok(!b.html.includes('ON THIS DAY') && !b.text.includes('On this day'), 'no line without an entry');
ok(a.hash !== b.hash, 'hash covers the line');
// An older snapshot (no onThisDay key) renders exactly as one with null.
const { onThisDay, ...old } = without;
ok(render(old).hash === b.hash, 'old snapshots unchanged');
ok(render({ ...withLine, onThisDay: { text: '<b>x</b> & "y"' } }).html.includes('&lt;b&gt;x&lt;/b&gt; &amp;'), 'text escaped');

const dir = process.argv[2];
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'onthisday-with.html'), a.html);
  fs.writeFileSync(path.join(dir, 'onthisday-without.html'), b.html);
}
console.log(`On this day OK (${checks} checks, ${Object.keys(data.entries).length} entries).`);
