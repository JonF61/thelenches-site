// scripts/test-sitefacts-sites.js
// Holly's site facts per site (18 Nov 2026): a Harvington run gets Harvington's address, only the
// pages Harvington has, its council and schools, and the shared ARCH church services (its
// services.js reads the Lenches' services.json). The Lenches keeps its pages and sections.
// Run: node scripts/test-sitefacts-sites.js
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');

const probe = (site) => JSON.parse(execFileSync(process.execPath, ['-e', `
  const f = require('./scripts/ingest/sitefacts');
  const r = f.siteFacts({ today: '2026-11-18' });
  console.log(JSON.stringify({ site: f.SITE, pages: f.PAGES.map((p) => p[1]), keys: Object.keys(r.facts),
    urls: [...r.urls], services: r.facts.church_services, home: f.PAGES[0][2] }));
`], { cwd: require('path').join(__dirname, '..'), env: { ...process.env, SITE: site }, encoding: 'utf8' }).trim().split('\n').pop());

const h = probe('harvington');
assert.strictEqual(h.site, 'https://harvingtonvillage.org.uk');
assert.ok(h.urls.filter((u) => u.startsWith('https://thelenches.org.uk')).length === 0, 'every link is on harvingtonvillage.org.uk');
for (const u of ['/', '/events/', '/churches/', '/living-here/council/', '/living-here/eat/']) assert.ok(h.pages.includes(u), `has ${u}`);
for (const u of ['/groups/', '/halls/', '/living-here/health/', '/living-here/walks/']) assert.ok(!h.pages.includes(u), `no ${u}`);
assert.ok(!h.keys.includes('health') && !h.keys.includes('walks') && h.keys.includes('council'), 'only its own sections');
assert.ok(h.services.url === 'https://harvingtonvillage.org.uk/churches/');
assert.ok(Array.isArray(h.services.sundays) && h.services.midweek !== undefined, 'church services read');
assert.ok(/website@harvingtonvillage\.org\.uk/.test(h.home), 'Home blurb names its own address');

const l = probe('lenches');
assert.strictEqual(l.site, 'https://thelenches.org.uk');
for (const u of ['/groups/', '/halls/', '/living-here/health/', '/living-here/walks/']) assert.ok(l.pages.includes(u), `Lenches keeps ${u}`);
assert.ok(l.keys.includes('health') && l.keys.includes('transport') && l.keys.includes('walks'));
assert.ok(/website@thelenches\.org\.uk/.test(l.home));
assert.deepStrictEqual(h.services.sundays, l.services.sundays, 'one ARCH rota for both sites');

console.log('test-sitefacts-sites: all passed');
