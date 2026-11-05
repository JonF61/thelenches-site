// scripts/test-listingcontacts.js
// Offline test of the listing check (5 Nov): Holly's fixed listing_check / listing_chase email
// for a Where to eat entry whose address is in the Org outreach tab (no opt-out line, link to
// the card, no Claude), and the address finder (scripts/listingcontacts): addresses from
// mailto links, plain text and Cloudflare's hidden form, the same-domain pick, contact pages,
// never overwriting a cell, Facebook skipped. Google and the web are mocked.
// Run: node scripts/test-listingcontacts.js
'use strict';

const assert = require('assert');

process.env.GMAIL_USER = 'owner@thelenches.org.uk';
const sdkPath = require.resolve('@anthropic-ai/sdk');
let claudeCalls = 0;
class FakeAnthropic { constructor() { this.messages = { create: async () => { claudeCalls += 1; throw new Error('no Claude'); } }; } }
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const g = require('./ingest/google');
const fbHeaders = require('./ingest/feedback').HEADERS;
const HEADERS = {
  Replies: ['reply_id', 'message_id', 'thread_id', 'to', 'type', 'status', 'policy_codes', 'subject', 'body', 'notes', 'created_at', 'sent_at', 'class', 'class_confidence', 'hold_reason'],
  Contacts: ['email', 'name', 'organisation', 'status', 'last_contact', 'other_emails'],
  'Org outreach': ['id', 'next_check', 'notes', 'other_emails'],
  'Reply feedback': fbHeaders,
};
let tables;
const pick = (tab, o) => Object.fromEntries(HEADERS[tab].map((h) => [h, o[h] == null ? '' : String(o[h])]));
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings: { replies_mode: 'live' } }),
  readTable: async (tab) => tables[tab].map((r, i) => ({ ...r, _row: i + 2 })),
  readHeaders: async (tab) => HEADERS[tab],
  setHeader: async (tab, i, name) => { assert.equal(i, HEADERS[tab].length); HEADERS[tab] = [...HEADERS[tab], name]; },
  appendRows: async (tab, objs) => { tables[tab].push(...objs.map((o) => pick(tab, o))); },
  updateRow: async (tab, n, f) => { Object.assign(tables[tab][n - 2], f); },
  ensureTab: async () => false,
  searchMessageIds: async () => [],
});

const orgs = require('./outreach/orgs');
const finder = require('./listingcontacts');

let checks = 0;
const ok = (c, what) => { assert.ok(c, what); checks += 1; };

// A fake web: url -> html.
function web(pages) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const html = pages[url];
    return html == null ? { ok: false, headers: { get: () => 'text/html' }, text: async () => '' }
      : { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => html };
  };
  return { fetch, asked };
}
const cf = (email, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

async function main() {
  // Address extraction.
  ok(finder.cfDecode(cf('bar@pub.co.uk')) === 'bar@pub.co.uk', 'Cloudflare hidden address decoded');
  const found = finder.addressesIn(`<a href="mailto:Info@Pub.co.uk?subject=Hi">Email</a> logo@2x.png sentry@abc.wixpress.com
    <span data-cfemail="${cf('book@pub.co.uk')}">[email&#160;protected]</span> chef&#64;pub.co.uk`);
  ok(found.includes('info@pub.co.uk') && found.includes('book@pub.co.uk') && found.includes('chef@pub.co.uk'), 'mailto, cf and entity addresses');
  ok(!found.some((e) => /wixpress|2x/.test(e)), 'junk left out');
  ok(finder.pick(['someone@gmail.com', 'bookings@pub.co.uk', 'info@pub.co.uk'], 'https://www.pub.co.uk/') === 'info@pub.co.uk', 'same domain, info@ first');
  ok(finder.pick(['someone@gmail.com'], 'https://www.pub.co.uk/') === 'someone@gmail.com', 'else the first found');

  // Contact page followed when the home page has none.
  const w1 = web({
    'https://www.thebootinn.com/': '<a href="/get-in-touch">Contact us</a><a href="https://other.com/contact">x</a>',
    'https://www.thebootinn.com/get-in-touch': '<p>Email enquiries@thebootinn.com</p>',
  });
  ok(await finder.findEmail('https://www.thebootinn.com/', w1) === 'enquiries@thebootinn.com', 'found on the contact page');
  ok(!w1.asked.some((u) => u.includes('other.com')), 'never leaves the site');
  ok(await finder.findEmail('https://www.facebook.com/somepub', web({})) === '', 'Facebook skipped');

  // The run: saves to the Org outreach tab, never overwrites, logs no address.
  tables = { 'Org outreach': [pick('Org outreach', { id: 'eat-mysuru', notes: 'x' }), { id: 'eat-ivy-inn', next_check: '', notes: '', other_emails: '', email: '', email_source: 'panel' }], Replies: [], Contacts: [], 'Reply feedback': [] };
  const pages = {
    'https://www.thebootinn.com/': '<a href="mailto:info@thebootinn.com">e</a>',
    'https://www.mysuru.co.uk': '<a href="mailto:hello@mysuru.co.uk">e</a>',
    'https://www.theivyinn.co.uk': '<a href="mailto:ivy@theivyinn.co.uk">e</a>',
  };
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const w2 = web(pages);
  const r = await finder.run({}, { g, fetch: w2.fetch });
  console.log = log;
  const tab = tables['Org outreach'];
  ok(tab.find((x) => x.id === 'eat-boot-inn').email === 'info@thebootinn.com' && tab.find((x) => x.id === 'eat-boot-inn').email_source === 'website', 'new row appended');
  ok(tab.find((x) => x.id === 'eat-mysuru').email === 'hello@mysuru.co.uk' && tab.find((x) => x.id === 'eat-mysuru').notes === 'x', 'existing row updated, notes kept');
  ok(tab.find((x) => x.id === 'eat-ivy-inn').email === '', 'a cleared (panel) cell is never refilled');
  ok(!w2.asked.some((u) => /facebook/.test(u)), 'Facebook pages never fetched');
  ok(!tab.some((x) => x.id === 'trade-b-tomes-son'), 'an entry with its own address is skipped');
  ok(r.saved === 2 && !logs.some((l) => l.includes('@')), 'counts right and no address logged');
  ok(HEADERS['Org outreach'].slice(-2).join() === 'email,email_source', 'headers added at the end');
  const again = await finder.run({ only: 'eat-boot-inn' }, { g, fetch: web({}).fetch });
  ok(again.looked === 0, 'second run leaves a found address alone');

  // The listing check email: fixed wording, link to the card, no opt-out line, no Claude.
  const fresh = await orgs.draftOrgCheck('eat-boot-inn');
  ok(fresh && fresh.to === 'info@thebootinn.com' && fresh.status === 'awaiting' && fresh.policy_codes === 'org_check_eat-boot-inn', 'awaiting draft to the found address');
  ok(fresh.subject === 'Your listing on thelenches.org.uk', 'subject');
  ok(fresh.body.includes('Boot Inn is listed free of charge on our Where to eat page:\nhttps://thelenches.org.uk/living-here/eat/#eat-boot-inn'), 'name, page and card link');
  ok(fresh.body.includes('This is what it shows at the moment:\nBoot Inn\nFlyford Flavell\nPub and restaurant'), 'the entry as shown');
  ok(fresh.body.includes("If you'd rather not be listed, let me know and we'll take it off.") && !fresh.body.includes("rather we didn't get in touch"), 'own opt-out wording only');
  ok(/Best wishes,\nHolly\nLenches website assistant/.test(fresh.body), 'Holly signs');
  ok(/^Listing check for Boot Inn/.test(fresh.notes), 'card note');
  const chase = orgs.orgEmail((await orgs.allEntries()).find((e) => e.id === 'trade-b-tomes-son'), 'chase', await orgs.rules());
  ok(chase.subject === 'Re: Your listing on thelenches.org.uk' && chase.body.includes("B Tomes & Son's free listing on our Local trades page"), 'chaser wording');
  ok(claudeCalls === 0, 'no Claude');
  console.log('--- sample listing check ---\n' + fresh.body + '\n---');
  console.log(`test-listingcontacts: ${checks} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
