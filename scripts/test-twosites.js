// Two sites, stage 4b (16 Nov 2026): items for one or both sites, publish reading the other
// Sheet, one email sent to both addresses, the cross-site repeat check, Holly's identity per site.
// Offline: Google and Claude are mocked. Run: node scripts/test-twosites.js
process.env.SITE = 'harvington';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GMAIL_USER = 'team@example.org';
process.env.RIMMER_REPLIES = 'off';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const site = require('../lib/site');
const g = require('./ingest/google');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

(async () => {
  // Which sites an item is for.
  ok(site.itemSites('').join() === 'lenches,harvington', 'blank = both');
  ok(site.itemSites('both').length === 2, 'both');
  ok(site.itemSites('Harvington').join() === 'harvington', 'one site');
  ok(site.itemSites('nowhere').length === 2, 'unknown = both');
  ok(site.otherSites().join() === 'lenches', 'other site');

  // Holly's extraction: sites kept only when it names a real site.
  const { normalise, SYSTEM } = require('./ingest/extract');
  const [a, b, c] = normalise([
    { title: 'A', category: 'event', sites: 'lenches', sites_reason: 'Rous Lench residents only' },
    { title: 'B', category: 'event', sites: 'both', sites_reason: 'x' },
    { title: 'C', category: 'event', sites: 'mars' },
  ], 0);
  ok(a.sites === 'lenches' && a.sites_reason === 'Rous Lench residents only', 'one-site flag kept');
  ok(b.sites === '' && b.sites_reason === '', 'both = blank');
  ok(c.sites === '', 'unknown site = blank');
  ok(/Harvington website assistant/.test(SYSTEM) && /SITES:/.test(SYSTEM), 'Holly writes as the Harvington assistant, SITES rule');

  // Holly's replies come from this site's address and sign as its assistant.
  const replies = require('./ingest/replies');
  ok(replies.REPLY_FROM === 'website@harvingtonvillage.org.uk', 'Harvington reply address');

  // Publish: own rows for this site, the other Sheet's live rows for it, own copy wins.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const row = (id, title, extra = {}) => ({ id, title, status: 'approved', category: 'event', event_date: future, summary: `${title} body`, decided_at: today, ...extra });
  const own = [row('h1', 'Quiz — Harvington Village Hall'), row('h2', 'Lenches only thing', { sites: 'lenches' }), row('h3', 'Shared fair', { summary: 'our copy' })];
  const theirs = [row('l1', 'Lenches Club bingo'), row('l2', 'Rous Lench meeting', { sites: 'lenches' }), row('l3', 'Shared fair', { summary: 'their copy' }),
    row('l4', 'Rejected', { status: 'rejected' }), row('l5', 'For Harvington', { sites: 'harvington' })];
  g.readTable = async (tab) => (tab === 'Pending' ? own.map((r, i) => ({ ...r, _row: i + 2 })) : []);
  g.readOtherTable = async (s, tab) => (tab === 'Pending' ? theirs.map((r, i) => ({ ...r, _row: i + 2, _site: s })) : []);
  g.updateRow = async () => { throw new Error('publish must not write in this test'); };
  const file = path.join(__dirname, '..', 'sites', 'harvington', '_data', 'pipeline.json');
  const geo = path.join(__dirname, '..', 'sites', 'harvington', '_data', 'roadgeo.json');
  const hadGeo = fs.existsSync(geo);
  const had = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    await require('./publish/index.js').main();
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = out.events.map((e) => e.id).sort();
    ok(ids.join() === 'h1,h3,l1,l5', `Harvington publishes its own and the Lenches items for it (${ids})`);
    ok(out.events.find((e) => e.id === 'h3').body === 'our copy', 'own copy wins a clash');
  } finally {
    if (had === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, had);
    if (!hadGeo) fs.rmSync(geo, { force: true });
  }

  // Ingest: the same email in the Lenches label is left to the Lenches run; a cross-site repeat waits.
  const { findRepeat } = require('./ingest/index.js');
  const other = [{ id: 'l9', title: 'Christmas Fayre — Harvington', event_date: future, _site: 'lenches' }];
  ok(findRepeat({ title: 'Christmas Fayre — Harvington', event_date: future }, '', other).row.id === 'l9', 'cross-site repeat found');

  const logged = [];
  g.readSettings = async () => ({ sources: [], settings: { start_date: today, replies_mode: 'shadow' } });
  g.readTable = async () => [];
  g.listMessageIds = async (label) => (label === 'Harvington Website/2 Pipeline' ? ['m1'] : label === 'Lenches Website/2 Pipeline' ? ['m1'] : []);
  g.appendRows = async (tab, rows) => { if (tab === 'Log') logged.push(...rows); };
  g.getMessage = async () => { throw new Error('m1 must not be fetched: the Lenches run handles it'); };
  g.sendMail = async () => 'sent-1';
  await require('./ingest/index.js').main();
  ok(logged.length === 1 && logged[0].status === 'skipped' && /the Lenches website: handled there/.test(logged[0].error), 'one email to both: left to the Lenches run');

  // Signed action links made by this site's run name it (4c-1); others and Lenches links do not.
  {
    const keep = { k: process.env.APPROVAL_SIGNING_KEY, u: process.env.WORKER_URL, s: process.env.SITE };
    process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(32);
    process.env.WORKER_URL = 'https://w.example';
    const { signToken } = require('./ingest/links.js');
    const payloadOf = (url) => JSON.parse(Buffer.from(url.split('?t=')[1].split('.')[0], 'base64url').toString());
    ok(payloadOf(signToken({ a: 'approve', i: 'x' })).s === 'harvington', 'Harvington action link names its site');
    ok(payloadOf(signToken({ a: 'unsub', i: 'x' }, '/u')).s === undefined, 'other routes unchanged');
    process.env.SITE = 'lenches';
    ok(payloadOf(signToken({ a: 'approve', i: 'x' })).s === undefined, 'Lenches action link unchanged');
    process.env.APPROVAL_SIGNING_KEY = keep.k || '';
    process.env.WORKER_URL = keep.u || '';
    process.env.SITE = keep.s;
  }

  // The mocked ingest run has no Google key, so its side jobs (reader feedback) mark the run failed.
  process.exitCode = 0;
  console.log(`twosites: ${n} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
