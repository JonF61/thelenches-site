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
for (const u of ['/', '/events/', '/churches/', '/living-here/council/', '/living-here/eat/', '/groups/', '/halls/', '/living-here/health/']) assert.ok(h.pages.includes(u), `has ${u}`);
for (const u of ['/living-here/walks/']) assert.ok(!h.pages.includes(u), `no ${u}`);
assert.ok(!h.keys.includes('walks') && h.keys.includes('council'), 'only its own sections');
assert.ok(h.services.url === 'https://harvingtonvillage.org.uk/churches/');
assert.ok(Array.isArray(h.services.sundays) && h.services.midweek !== undefined, 'church services read');
assert.ok(/website@harvingtonvillage\.org\.uk/.test(h.home), 'Home blurb names its own address');

const l = probe('lenches');
assert.strictEqual(l.site, 'https://thelenches.org.uk');
for (const u of ['/groups/', '/halls/', '/living-here/health/', '/living-here/walks/']) assert.ok(l.pages.includes(u), `Lenches keeps ${u}`);
assert.ok(l.keys.includes('health') && l.keys.includes('transport') && l.keys.includes('walks'));
assert.ok(/website@thelenches\.org\.uk/.test(l.home));
assert.deepStrictEqual(h.services.sundays, l.services.sundays, 'one ARCH rota for both sites');

// Planning facts (28 Nov 2026): each application's stage, our card and its Wychavon page; both links allowed.
{
  const { execFileSync: ex } = require('child_process');
  const pl = JSON.parse(ex(process.execPath, ['-e', `
    const { siteFacts } = require('./scripts/ingest/sitefacts');
    const data = { weeks: [{ from: '2026-11-16', to: '2026-11-20', applications: [{ ref: 'W/26/1/FUL', location: 'Hill Barn', proposal: 'Two dwellings', link: 'https://plan.wychavon.gov.uk/Planning/Display/W/26/1/FUL' }],
      decisions: [{ ref: 'W/26/9/HP', location: 'Rose Cottage', proposal: 'Extension', decision: 'Approval', link: 'https://plan.wychavon.gov.uk/Planning/Display/W/26/9/HP' }] }],
      open: [{ ref: 'W/26/1/FUL', location: 'Hill Barn', proposal: 'Two dwellings', link: 'https://plan.wychavon.gov.uk/Planning/Display/W/26/1/FUL', valid: '2026-11-17', consultationEnd: '2026-12-08', committee: '2026-12-10', homesLabel: '2 new homes' }] };
    const f = siteFacts({ today: '2026-11-28', planning: data });
    console.log(JSON.stringify({ p: f.facts.planning, ok: f.urls.has('https://plan.wychavon.gov.uk/Planning/Display/W/26/9/HP') && f.urls.has('https://thelenches.org.uk/living-here/planning/#pl-w-26-1-ful') }));`],
    { cwd: require('path').join(__dirname, '..'), env: { ...process.env, SITE: 'lenches' }, encoding: 'utf8' }).trim().split('\n').pop());
  const [a, d] = pl.p.applications;
  assert.ok(pl.ok, 'planning links allowed');
  assert.strictEqual(a.comments_until, '2026-12-08');
  assert.ok(a.comments_open && a.committee === '2026-12-10' && a.new_homes === '2 new homes');
  assert.ok(/Comments until 8 Dec/.test(a.stage) && /Planning committee 10 Dec/.test(a.stage));
  assert.strictEqual(d.url, 'https://thelenches.org.uk/living-here/planning/#pl-w-26-9-hp');
  assert.ok(/^Decision in Wychavon's list for 2026-11-16 to 2026-11-20: Approval$/.test(d.stage));
}

console.log('test-sitefacts-sites: all passed');
