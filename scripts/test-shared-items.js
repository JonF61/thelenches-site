// Shared hand-written items (17 Nov 2026, Jon): every site shows every site's events, notices and
// regular activities unless an item's "sites" field names only some. Uses the real items folders.
'use strict';
const assert = require('assert');
const { loadWhatson, sitesFor, siteOf, entryKeyOf, imageFile } = require('../lib/whatson');

let checks = 0;
const ok = (v, msg) => { assert.ok(v, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

eq(sitesFor({}, 'x'), ['lenches', 'harvington'], 'blank = both');
eq(sitesFor({ sites: 'both' }, 'x'), ['lenches', 'harvington'], 'both');
eq(sitesFor({ sites: 'Lenches' }, 'x'), ['lenches'], 'one site, any case');
eq(sitesFor({ sites: 'lenches, harvington' }, 'x'), ['lenches', 'harvington'], 'a list');
assert.throws(() => sitesFor({ sites: 'lench' }, 'events/x.json'), /events\/x\.json: "sites" must be/); checks++;

const today = '2026-11-17';
const L = loadWhatson({ site: 'lenches', today, all: true });
const H = loadWhatson({ site: 'harvington', today, all: true });
const own = loadWhatson({ site: 'lenches', today, all: true, shared: false });

// The Lenches keeps exactly its own items, keys unchanged.
eq(L.events.map(entryKeyOf), own.events.map(entryKeyOf), 'Lenches events unchanged');
eq(L.notices.map(entryKeyOf), own.notices.map(entryKeyOf), 'Lenches notices unchanged');
eq(L.regularsPage.map(entryKeyOf), own.regularsPage.map(entryKeyOf), 'Lenches regulars unchanged');

// Harvington gets every Lenches event (plus those in the Lenches folder set to Harvington only)
// and every regular, marked as the Lenches', with no edit key.
const evDir = require('path').join(__dirname, '..', 'sites', 'lenches', 'items', 'events');
const evFiles = require('fs').readdirSync(evDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(require('fs').readFileSync(require('path').join(evDir, f), 'utf8')));
const harvOnlyEvents = evFiles.filter((e) => !sitesFor(e, 'x').includes('lenches')).map((e) => e.title);
ok(!L.events.some((e) => harvOnlyEvents.includes(e.title)), 'the Lenches leaves out the Harvington-only events');
eq(H.events.length, L.events.length + H.events.filter((e) => harvOnlyEvents.includes(e.title)).length, 'Harvington shows the Lenches events');
ok(H.events.every((e) => siteOf(e) === 'lenches' && !entryKeyOf(e)), 'other-site events: _site set, no _entry');
eq(H.regularsPage.length, L.regularsPage.length, 'Harvington shows the Lenches regular activities');
ok(H.regularsPage.every((r) => siteOf(r) === 'lenches' && !entryKeyOf(r)), 'other-site regulars marked');

// Single-site notices stay on their site (every notice file in the Lenches folder, any site).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'sites', 'lenches', 'items', 'notices');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const lenchesOnly = files.filter((n) => !sitesFor(n, 'x').includes('harvington')).map((n) => n.title);
const harvOnly = files.filter((n) => !sitesFor(n, 'x').includes('lenches')).map((n) => n.title);
ok(lenchesOnly.some((t) => /South Lenches Parish Council/.test(t)), 'parish council notices are Lenches-only');
ok(!H.notices.some((n) => lenchesOnly.includes(n.title)), 'Harvington leaves out the Lenches-only notices');
ok(!L.notices.some((n) => harvOnly.includes(n.title)), 'the Lenches leaves out the Harvington-only notices');
eq(H.notices.length, files.length - lenchesOnly.length, 'Harvington shows every other Lenches notice');

// Pictures: a shared item's image is found in its own site's folder.
const pic = H.events.concat(H.notices).find((x) => x.image && /^\/images\/items\//.test(x.image.url));
if (pic) ok(imageFile(pic.image.url, 'harvington').includes('/sites/lenches/'), 'image found in the Lenches folder');
eq(imageFile('/images/../_data/site.json'), '', 'no climbing out');

console.log(`test-shared-items: ${checks} checks passed`);
