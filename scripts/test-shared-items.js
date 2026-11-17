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

// Harvington gets every Lenches event and regular, marked as the Lenches', with no edit key.
eq(H.events.length, L.events.length, 'Harvington shows the Lenches events');
ok(H.events.every((e) => siteOf(e) === 'lenches' && !entryKeyOf(e)), 'other-site events: _site set, no _entry');
eq(H.regularsPage.length, L.regularsPage.length, 'Harvington shows the Lenches regular activities');
ok(H.regularsPage.every((r) => siteOf(r) === 'lenches' && !entryKeyOf(r)), 'other-site regulars marked');

// Single-site notices stay on their site.
const limited = L.notices.filter((n) => n.sites).map((n) => n.title);
ok(limited.some((t) => /South Lenches Parish Council/.test(t)), 'parish council notices are Lenches-only');
eq(H.notices.length, L.notices.length - limited.length, 'Harvington leaves out the Lenches-only notices');
ok(!H.notices.some((n) => n.sites && !sitesFor(n, 'x').includes('harvington')), 'none for the Lenches alone on Harvington');

// Pictures: a shared item's image is found in its own site's folder.
const pic = H.events.concat(H.notices).find((x) => x.image && /^\/images\/items\//.test(x.image.url));
if (pic) ok(imageFile(pic.image.url, 'harvington').includes('/sites/lenches/'), 'image found in the Lenches folder');
eq(imageFile('/images/../_data/site.json'), '', 'no climbing out');

console.log(`test-shared-items: ${checks} checks passed`);
