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
  g.readTable = async (t) => tabs[t];
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
  console.log('test-linkask: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
