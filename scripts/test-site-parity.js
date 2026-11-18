// scripts/test-site-parity.js: lib/parity.js (are the two websites in step?): the real repo is in
// step, and a copy with each kind of drift is caught. Run: node scripts/test-site-parity.js
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parityProblems } = require('../lib/parity');

const ROOT = path.join(__dirname, '..');

// The repo as it stands.
assert.deepEqual(parityProblems(), [], 'the two sites have drifted apart: run node lib/parity.js');

// A scratch copy of the parts the check reads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
for (const site of ['lenches', 'harvington']) {
  const from = path.join(ROOT, 'sites', site);
  fs.cpSync(from, path.join(tmp, 'sites', site), { recursive: true, filter: (src) => !src.includes(`${path.sep}images${path.sep}items`) });
}
const file = (site, rel) => path.join(tmp, 'sites', site, rel);
const edit = (site, rel, fn) => { const f = file(site, rel); const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j, null, 2)); };
const problems = () => parityProblems({ root: tmp });
assert.deepEqual(problems(), []);

// Bins: a date moved on one site only; brown is left out for Harvington, so that alone is fine.
edit('lenches', '_data/bins.json', (j) => { j.collections[j.collections.length - 1].date = '2026-12-15'; });
assert.match(problems().join('\n'), /Bins: 2026-12-15 is in the Lenches' dates but not Harvington's[\s\S]*Bins: 2026-12-14 is in Harvington's/);
edit('lenches', '_data/bins.json', (j) => { j.collections[j.collections.length - 1].date = '2026-12-14'; j.collections.push({ date: '2026-12-21', bins: ['green', 'brown'] }); j.validTo = '2026-12-21'; });
assert.match(problems().join('\n'), /validTo[\s\S]*2026-12-21 is in the Lenches' dates/);
edit('harvington', '_data/bins.json', (j) => { j.collections.push({ date: '2026-12-21', bins: ['green'] }); j.validTo = '2026-12-21'; });
assert.deepEqual(problems(), []);
edit('harvington', '_data/bins.json', (j) => { j.collections[j.collections.length - 1].bins = ['black']; });
assert.match(problems()[0], /Bins: 2026-12-21 is green for the Lenches but black for Harvington/);
edit('harvington', '_data/bins.json', (j) => { j.collections[j.collections.length - 1].bins = ['green']; });

// School terms
edit('harvington', '_data/schools.json', (j) => { j.terms.breaks[0].reopens = '2099-01-01'; });
assert.deepEqual(problems(), ['School terms: the breaks differ between the Lenches and Harvington (schools.json terms.breaks)']);
edit('harvington', '_data/schools.json', (j) => { j.terms.breaks = JSON.parse(fs.readFileSync(file('lenches', '_data/schools.json'), 'utf8')).terms.breaks; });

// Cartoons: on one site only, a different caption, a missing JPEG; before Harvington's first issue only the Lenches'.
edit('lenches', '_data/cartoons.json', (j) => { j.entries['2026-11-26'] = { image: '/images/cartoons/x.jpg', alt: 'a', caption: 'c' }; });
fs.writeFileSync(file('lenches', 'images/cartoons/x.jpg'), '');
assert.deepEqual(problems(), ["Cartoon 2026-11-26: in the Lenches' cartoons.json but not Harvington's"]);
edit('harvington', '_data/cartoons.json', (j) => { j.entries['2026-11-26'] = { image: '/images/cartoons/x.jpg', alt: 'a', caption: 'other' }; });
assert.deepEqual(problems(), ['Cartoon 2026-11-26: caption differs between the two sites', 'Cartoon 2026-11-26: images/cartoons/x.jpg is missing from sites/harvington/']);
edit('harvington', '_data/cartoons.json', (j) => { j.entries['2026-11-26'].caption = 'c'; });
fs.writeFileSync(file('harvington', 'images/cartoons/x.jpg'), '');
assert.deepEqual(problems(), []);

// Data files and pages on one site only.
fs.writeFileSync(file('lenches', '_data/newthing.json'), '{}');
fs.writeFileSync(file('harvington', 'living-here/new-page.njk'), '');
assert.deepEqual(problems(), [
  'Data: the Lenches has _data/newthing but Harvington has none (add it there, or list it in lib/parity.js KNOWN)',
  'Pages: Harvington has living-here/new-page.njk but the Lenches has none (add it there, or list it in lib/parity.js KNOWN)',
]);
fs.rmSync(file('lenches', '_data/newthing.json'));
fs.rmSync(file('harvington', 'living-here/new-page.njk'));

// Wording: a new block on one site's shared page.
const ev = file('lenches', 'events.njk');
fs.writeFileSync(ev, fs.readFileSync(ev, 'utf8').replace(/(\{%-? include)/, '{%- set extraNote = "x" -%}\n$1'));
assert.deepEqual(problems(), ['Wording: events.njk sets extraNote for the Lenches but not for Harvington']);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-site-parity: all passed');
