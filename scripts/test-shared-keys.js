// scripts/test-shared-keys.js
// Shared items reach every site's tools (18 Nov 2026): on a Harvington run the Already listed
// check sees the Lenches' hand-written items (key h:lenches/events/<file>), Add details and Replace
// write that site's file (a kept picture copied into Harvington's images), and Rimmer's Fix…
// offers the Lenches' shared events, notices and regular activities. Offline; temp folders only.
// Run: node scripts/test-shared-keys.js
'use strict';

process.env.SITE = 'harvington';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const g = require('./ingest/google');
let tables = {};
Object.assign(g, {
  readTable: async (tab) => (tables[tab] || []).map((r, i) => ({ ...r, _row: i + 2 })),
  updateRow: async (tab, row, fields) => { Object.assign(tables[tab][row - 2], fields); },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs); },
  ensureTab: async () => false,
});
const whatson = require('../lib/whatson');
const dupes = require('./ingest/duplicates');
const approve = require('./approve/index');
const fix = require('./rimmer/fix');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };

// Keys
eq(whatson.parseHandKey('h:events/a.json', 'harvington'), { site: 'harvington', folder: 'events', file: 'a.json', rel: 'sites/harvington/items/events/a.json', own: true });
eq(whatson.parseHandKey('h:lenches/notices/b.json', 'harvington').rel, 'sites/lenches/items/notices/b.json');
eq(whatson.parseHandKey('h:lenches/notices/b.json', 'harvington').own, false);
eq(whatson.parseHandKey('h:nowhere/events/a.json'), null, 'unknown site refused');
eq(whatson.parseHandKey('h:events/../x.json'), null, 'no ..');
eq(whatson.handKey('events', 'a.json', 'lenches', 'harvington'), 'h:lenches/events/a.json');
eq(whatson.handKey('events', 'a.json', 'harvington', 'harvington'), 'h:events/a.json', 'own keys unchanged');

// A temp repo with both sites
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharedkeys-'));
const put = (rel, obj) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)); };
put('sites/lenches/items/events/2099-12-05-carols.json', { date: '2099-12-05', title: 'Carols — St Peter\'s', body: 'Old words.', image: { url: '/images/items/carols.webp', alt: 'Poster' } });
put('sites/lenches/items/events/2099-12-06-pc-meeting.json', { date: '2099-12-06', title: 'Parish council meeting', body: 'x', sites: 'lenches' });
put('sites/lenches/items/notices/lane-closed.json', { title: 'Lane closed', body: 'y' });
put('sites/harvington/items/notices/lane-closed.json', { title: 'Lane closed', body: 'Harvington copy' });
put('sites/lenches/items/regulars.json', { regulars: [{ day: 'Monday', time: '7pm', what: 'Bell ringing', where: 'Church' }, { day: 'Tuesday', what: 'Members only', sites: 'lenches' }] });
put('sites/lenches/images/items/carols.webp', 'W');
put('sites/lenches/images/items/carols.jpg', 'J');

// Already listed candidates
const list = dupes.listings([], { root, today: '2099-01-01' });
const keys = list.map((l) => l.key);
ok(keys.includes('h:lenches/events/2099-12-05-carols.json'), 'Lenches event listed on a Harvington run');
ok(!keys.some((k) => k.includes('pc-meeting')), 'Lenches-only item left out');
eq(keys.filter((k) => k.includes('lane-closed')), ['h:notices/lane-closed.json'], "this site's copy wins");

// Rimmer's Fix… sources
const src = fix.sources({ root });
const sk = src.map((x) => x.key);
ok(sk.includes('h:lenches/events/2099-12-05-carols.json'), 'Fix sees the shared Lenches event');
ok(sk.includes('r:lenches:0') && !sk.includes('r:lenches:1'), 'shared regular in, members-only out');
const carols = src.find((x) => x.key === 'h:lenches/events/2099-12-05-carols.json');
eq(carols.file, 'sites/lenches/items/events/2099-12-05-carols.json');
ok(/from the lenches website/.test(carols.label), 'label says whose it is');
fix.writeRepoChange(carols, 'body', 'Old words.', 'New words.', root);
ok(/New words\./.test(fs.readFileSync(path.join(root, carols.file), 'utf8')), 'Fix writes the Lenches file');

(async () => {
  const itemsDir = path.join(root, 'sites', 'harvington', 'items');
  // Add details on a Lenches item from a Harvington run
  const dup = { key: 'h:lenches/events/2099-12-05-carols.json', title: 'Carols' };
  const changed = await approve.applyDetails(dup, { link_url: 'https://example.org/carols', link_text: 'Book' }, [], itemsDir);
  eq(changed, ['link']);
  ok(/example\.org/.test(fs.readFileSync(path.join(root, 'sites/lenches/items/events/2099-12-05-carols.json'), 'utf8')), 'Add details writes the Lenches file');

  // Replace: Lenches file deleted, its picture copied into Harvington's images and kept
  tables = {
    Pending: [{ id: 'h1', status: 'pending', notes: '', duplicate: JSON.stringify({ ...dup, source: 'hand-written', confidence: 0.95, sure: true, changes: {} }), image_url: '', image_part_id: '', image_choice: '', alt_text: '', newsletter_count: 0, flyer_count: 0 }],
    'Item feedback': [{ item_id: 'h1', type: 'duplicate', draft: '{}', outcome: '', changed: '', final: '', decided_at: '' }],
  };
  await approve.replaceItem('h1', itemsDir);
  ok(!fs.existsSync(path.join(root, 'sites/lenches/items/events/2099-12-05-carols.json')), 'Lenches file removed');
  eq(tables.Pending[0].status, 'approved');
  eq(tables.Pending[0].image_url, '/images/items/carols.webp');
  ok(fs.existsSync(path.join(root, 'sites/harvington/images/items/carols.webp')) && fs.existsSync(path.join(root, 'sites/harvington/images/items/carols.jpg')), 'picture copied to Harvington');
  ok(!('fromSite' in tables.Pending[0]), 'no stray cells written');

  fs.rmSync(root, { recursive: true, force: true });

  // Harvington's yearly listing checks: its own pages and subject, the Lenches' shared places left out
  const orgs = require('./outreach/orgs');
  const R = await orgs.rules();
  const data = { trades: { trades: [{ id: 'own-trade', name: 'Own', trade: 'Builders' }, { id: 'shared', name: 'Shared', trade: 'Builders' }] }, eat: { places: [] } };
  const lenches = { trades: { trades: [{ id: 'shared', name: 'Shared', trade: 'Builders' }] }, eat: { places: [] } };
  const skip = new Set(R.listingEntries(lenches).map((e) => e.id));
  const list = R.listingEntries(data, { url: 'https://harvingtonvillage.org.uk', domain: 'harvingtonvillage.org.uk', skip });
  eq(list.map((e) => e.id), ['trade-own-trade'], 'shared entry left to the Lenches');
  eq(list[0].pageUrl, 'https://harvingtonvillage.org.uk/living-here/trades/#trade-own-trade');
  const mail = orgs.orgEmail(list[0], 'check', R);
  eq(mail.subject, 'Your listing on harvingtonvillage.org.uk');
  ok(/harvingtonvillage\.org\.uk, the community website and weekly newsletter for Harvington/.test(mail.body) && !/thelenches|Lenches villages/.test(mail.body), 'Harvington wording');
  ok(/Harvington website assistant/.test(mail.body), 'Harvington sign-off');
  eq(orgs.orgEmail(list[0], 'chase', R).subject, 'Re: Your listing on harvingtonvillage.org.uk');
  eq(R.listingEntries(lenches)[0].subject, 'Your listing on thelenches.org.uk', 'Lenches subject unchanged');
  console.log(`test-shared-keys: ${checks} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
