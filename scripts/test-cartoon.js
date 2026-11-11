// Offline test for the newsletter cartoon (11 Nov 2026): select.js picks the entry keyed by the
// issue date from src/_data/cartoons.json (only when its JPEG is in the repo); render.js shows the
// picture and caption just before Notices, with no heading (HTML and text). No network, no Sheet.
// Usage: node scripts/test-cartoon.js [preview-dir]   (writes cartoon-preview.html)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { select } = require('./newsletter/select');
const { render } = require('./newsletter/render');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/_data/cartoons.json'), 'utf8'));
let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

// Every entry: a date key, a JPEG that exists, alt text and a caption.
for (const [k, e] of Object.entries(data.entries)) {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(k), `bad key ${k}`);
  ok(/^\/images\/cartoons\/[\w.-]+\.jpe?g$/i.test(e.image || ''), `image path for ${k}`);
  ok(fs.existsSync(path.join(ROOT, 'src', e.image)), `image file for ${k}`);
  ok(typeof e.alt === 'string' && e.alt.trim().length > 10, `alt for ${k}`);
  ok(typeof e.caption === 'string' && e.caption.trim().length > 5, `caption for ${k}`);
}

const SITE = 'https://thelenches.org.uk';
const jpegFor = (u) => (fs.existsSync(path.join(ROOT, 'src', u)) ? `${SITE}${u}` : '');
const notice = { title: 'Hall car park', body: 'Closed for resurfacing.' };
const base = {
  pending: [], whatson: { events: [], notices: [notice] }, bins: {}, siteupdates: { entries: [] },
  issues: [], settings: {}, sources: [], onthisday: { entries: {} }, cartoons: data, jpegFor,
};

const withToon = select({ ...base, issueDate: '2026-11-12' });
ok(withToon.cartoon && withToon.cartoon.src === `${SITE}/images/cartoons/2026-11-12-evesham-road-fountain.jpg`, 'cartoon on 12 Nov');
ok(/Severn Trent/.test(withToon.cartoon.caption), 'caption carried');
ok(select({ ...base, issueDate: '2026-11-19' }).cartoon === null, 'no entry = null');
ok(select({ ...base, cartoons: undefined, issueDate: '2026-11-12' }).cartoon === null, 'no file = null');
ok(select({ ...base, jpegFor: () => '', issueDate: '2026-11-12' }).cartoon === null, 'missing image = null');
ok(select({ ...base, cartoons: { entries: { '2026-11-12': { image: '/images/cartoons/x.jpg', caption: ' ' } } }, issueDate: '2026-11-12' }).cartoon === null, 'blank caption = null');
ok(select({ ...base, cartoons: { entries: { '2026-11-12': { image: 'https://evil.example/x.jpg', caption: 'Hi' } } }, issueDate: '2026-11-12' }).cartoon === null, 'outside image refused');

const a = render(withToon);
const b = render(select({ ...base, issueDate: '2026-11-19' }));
const imgAt = a.html.indexOf('2026-11-12-evesham-road-fountain.jpg');
const noticesAt = a.html.indexOf('>Notices<');
ok(imgAt > 0 && noticesAt > imgAt, 'cartoon sits just before Notices');
ok(a.html.slice(imgAt, noticesAt).includes('Neighbourhood Plan'), 'caption under the picture');
ok(!/>Cartoon</i.test(a.html), 'no heading');
ok(a.text.includes("This week's cartoon:") && a.text.indexOf("This week's cartoon:") < a.text.indexOf('NOTICES'), 'text version before Notices');
ok(!b.html.includes('/images/cartoons/') && !b.text.includes("cartoon"), 'none when no entry');

const dir = process.argv[2];
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cartoon-preview.html'), a.html);
}
console.log(`test-cartoon: ${checks} checks passed`);
