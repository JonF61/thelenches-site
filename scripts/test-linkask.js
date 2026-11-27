// scripts/test-linkask.js: Holly's link request / chaser (scripts/outreach/linkask.js), offline.
'use strict';
const assert = require('assert');
const { linkEmail, subjectFor } = require('./outreach/linkask');

const cfg = { domain: 'thelenches.org.uk' };
assert.strictEqual(subjectFor(cfg), 'A link to thelenches.org.uk?');
const listed = linkEmail({ name: 'ARCH Benefice', listed_page: 'Churches', listed_url: 'https://thelenches.org.uk/churches/' }, 'request', { cfg });
assert.strictEqual(listed.subject, 'A link to thelenches.org.uk?');
assert.match(listed.body, /^Hi there,\n\nI help look after thelenches\.org\.uk/);
assert.match(listed.body, /\n\nARCH Benefice is listed on our Churches page:\nhttps:\/\/thelenches\.org\.uk\/churches\/\n\nWould you be happy/);
assert.match(listed.body, /The Lenches Website \(https:\/\/thelenches\.org\.uk\/\): events, news and local information for the Lenches villages near Evesham\./);
assert.match(listed.body, /Best wishes,\nHolly\n/);
assert.match(listed.body, /If you'd rather we didn't get in touch like this/);
const plain = linkEmail({ name: 'Visit Evesham' }, 'request', { cfg, optout: false });
assert.doesNotMatch(plain.body, /listed on our/);
assert.doesNotMatch(plain.body, /\n{3,}/, 'no gap where the listed line would be');
assert.doesNotMatch(plain.body, /rather we didn't/);
assert.doesNotMatch(plain.body, /\{\w+\}/);
const chase = linkEmail({ name: 'ARCH' }, 'chase', { cfg });
assert.strictEqual(chase.subject, 'Re: A link to thelenches.org.uk?');
assert.match(chase.body, /Just following up my email about a link to thelenches\.org\.uk/);
assert.doesNotMatch(chase.body, /rather we didn't/);

// Harvington (26 Nov): its own wording, never the Lenches' address.
const hcfg = { site: 'harvington', domain: 'harvingtonvillage.org.uk' };
const h = linkEmail({ name: 'Harvington Parish Council', listed_page: 'Council', listed_url: 'https://harvingtonvillage.org.uk/living-here/council/' }, 'request', { cfg: hcfg });
assert.strictEqual(h.subject, 'A link to harvingtonvillage.org.uk?');
assert.match(h.body, /I help look after harvingtonvillage\.org\.uk, the free community website and weekly newsletter for Harvington, Norton and Lenchwick\./);
assert.match(h.body, /The Harvington Website \(https:\/\/harvingtonvillage\.org\.uk\/\): events, news and local information for Harvington, Norton and Lenchwick\./);
assert.match(h.body, /Harvington Parish Council is listed on our Council page/);
assert.doesNotMatch(h.body, /thelenches/);
const hc = linkEmail({ name: 'ARCH' }, 'chase', { cfg: hcfg });
assert.match(hc.body, /a link to harvingtonvillage\.org\.uk from your website/);
assert.doesNotMatch(hc.body, /thelenches/);

// Known to us (27 Nov): no introduction, no "send us your news" line.
const k = linkEmail({ name: 'Harvington Parish Council', listed_page: 'Council', listed_url: 'https://harvingtonvillage.org.uk/living-here/council/' }, 'request', { cfg: hcfg, known: true, optout: false });
assert.match(k.body, /^Hi there,\n\nI'm getting in touch about the Harvington Website \(harvingtonvillage\.org\.uk\)\.\n\nHarvington Parish Council is listed on our Council page:/);
assert.doesNotMatch(k.body, /I help look after|news or events to share|thelenches/);
assert.match(k.body, /show up in Google\.\n\nBest wishes,/);
const kl = linkEmail({ name: 'Theatre' }, 'request', { cfg, known: true, optout: false });
assert.match(kl.body, /^Hi there,\n\nI'm getting in touch about the Lenches Website \(thelenches\.org\.uk\)\.\n\nWould you be happy/);
// One email for both sites (27 Nov), the Lenches first whichever site drafts it.
const lcfg = { site: 'lenches', domain: 'thelenches.org.uk' };
const twinH = { site: 'harvington', row: { id: 'arch', name: 'ARCH', listed_url: 'https://harvingtonvillage.org.uk/churches/' }, cfg: hcfg };
const b = linkEmail({ name: 'ARCH Benefice', listed_page: 'Churches', listed_url: 'https://thelenches.org.uk/churches/' }, 'request', { cfg: lcfg, twin: twinH, optout: false });
assert.strictEqual(b.subject, 'Links to thelenches.org.uk and harvingtonvillage.org.uk?');
assert.match(b.body, /our two community websites, the Lenches Website \(thelenches\.org\.uk\) and the Harvington Website/);
assert.match(b.body, /ARCH Benefice is listed on both websites:\nhttps:\/\/thelenches\.org\.uk\/churches\/\nhttps:\/\/harvingtonvillage\.org\.uk\/churches\/\n\nWould you be happy to add links to them/);
assert.doesNotMatch(b.body, /\{\w+\}|\n{3,}/);
const bc = linkEmail({ name: 'ARCH' }, 'chase', { cfg: lcfg, twin: twinH });
assert.strictEqual(bc.subject, 'Re: Links to thelenches.org.uk and harvingtonvillage.org.uk?');
assert.match(bc.body, /links to thelenches\.org\.uk and harvingtonvillage\.org\.uk from your website/);

// draftLinkAsk with the Sheet mocked: one awaiting outreach row, then nothing while it waits.
(async () => {
  const g = require('./ingest/google');
  const feedback = require('./ingest/feedback');
  const { draftLinkAsk } = require('./outreach/linkask');
  const tabs = {
    'Link partners': [{ _row: 2, id: 'arch', name: 'ARCH Benefice', status: 'To ask', email: 'office@arch.example', listed_page: 'Churches', listed_url: 'https://thelenches.org.uk/churches/' },
      { _row: 3, id: 'nomail', name: 'No mail', status: 'To ask', email: '' }],
    Replies: [],
  };
  g.readSettings = async () => ({ settings: { replies_mode: 'live' } });
  g.readTable = async (t) => tabs[t] || [];
  const other = { 'Link partners': [], Replies: [], Contacts: [] };
  g.readOtherTable = async (site, t) => other[t];
  let gmailHits = [];
  g.searchMessageIds = async () => gmailHits;
  g.appendRows = async (t, rows) => { tabs[t].push(...rows); };
  feedback.record = async () => {};
  const fresh = await draftLinkAsk('arch');
  assert.strictEqual(fresh.status, 'awaiting');
  assert.strictEqual(fresh.type, 'outreach');
  assert.strictEqual(fresh.policy_codes, 'link_request_arch');
  assert.strictEqual(fresh.to, 'office@arch.example');
  assert.match(fresh.reply_id, /^link-arch-request-\d+$/);
  assert.strictEqual(tabs.Replies.length, 1);
  assert.strictEqual(await draftLinkAsk('arch'), null, 'one waiting draft at a time');
  assert.strictEqual(await draftLinkAsk('nomail'), null);
  assert.strictEqual(await draftLinkAsk('missing'), null);
  assert.match(fresh.body, /I help look after/, 'never written to: the full introduction');
  assert.match(fresh.body, /rather we didn't/, 'a first email keeps the opt-out line');

  // Known through Gmail, and the same address on the other site: one email for both.
  tabs['Link partners'].push({ _row: 4, id: 'pc', name: 'Parish Council', status: 'To ask', email: 'Clerk@pc.example' });
  other['Link partners'].push({ _row: 9, id: 'pc-h', name: 'Parish Council', status: 'To ask', email: 'clerk@pc.example' });
  gmailHits = ['m1'];
  const two = await draftLinkAsk('pc');
  const otherSite = require('../lib/site').otherSites()[0];
  assert.strictEqual(two.policy_codes, `link_request_pc link_request_pc-h@${otherSite}`);
  assert.match(two.subject, /^Links to /);
  assert.match(two.body, /our two community websites/);
  assert.match(two.notes, /both websites/);
  // The other site now sees it waiting, then sent, and offers no request or chaser of its own.
  const R = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'worker', 'src', 'admin', 'links.mjs')).href);
  assert.match(R.planLinkAsk(other['Link partners'][0], R.bothReplies([], [tabs.Replies]), '2026-11-27', otherSite).error, /already waiting/);
  two.status = 'sent'; two.sent_at = '2026-11-27 10:00';
  const r2 = R.requestsFor('pc-h', R.bothReplies([], [tabs.Replies]), otherSite);
  assert.strictEqual(r2.requestSent, '2026-11-27');
  assert.ok(r2.viaOther);
  assert.match(R.planLinkAsk(other['Link partners'][0], R.bothReplies([], [tabs.Replies]), '2027-01-01', otherSite).error, /other site/);
  // Its chaser from this site covers both.
  const chaser = await draftLinkAsk('pc');
  assert.strictEqual(chaser, null, 'not due yet');

  // Known through a Contacts row (no Gmail hit), one site only: the shorter wording.
  gmailHits = [];
  tabs.Contacts = [{ email: 'a@x.example', other_emails: 'theatre@t.example', status: 'organiser' }];
  tabs['Link partners'].push({ _row: 5, id: 'theatre', name: 'Theatre', status: 'To ask', email: 'theatre@t.example' });
  const kt = await draftLinkAsk('theatre');
  assert.strictEqual(kt.policy_codes, 'link_request_theatre');
  assert.match(kt.body, /I'm getting in touch about/);
  assert.match(kt.notes, /written to them before/);
  assert.doesNotMatch(kt.body, /rather we didn't/, 'no opt-out line to someone we know');
  // A Gmail failure counts as not known.
  g.searchMessageIds = async () => { throw new Error('down'); };
  tabs['Link partners'].push({ _row: 6, id: 'new', name: 'New', status: 'To ask', email: 'n@new.example' });
  assert.match((await draftLinkAsk('new')).body, /I help look after/);
  console.log('test-linkask: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
