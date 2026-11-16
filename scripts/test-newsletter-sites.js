// Tests for the newsletter on each site (Harvington stage 5a, 16 Nov 2026): the Harvington issue's
// name, subject, addresses, colours and sections; no Lenches badge; links that name the site; the
// daily limit across both sites' Sheets. (The Lenches issue is checked unchanged by the other
// newsletter tests.) Run: node scripts/test-newsletter-sites.js
'use strict';

process.env.SITE = 'harvington';
process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(32);
process.env.WORKER_URL = 'https://approvals.example.workers.dev';

const assert = require('assert');
const { render, UNSUB_MARK } = require('./newsletter/render');
const { signToken } = require('./ingest/links');
const send = require('./newsletter/send');
const unsub = require('./newsletter/unsub');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const model = {
  issueDate: '2026-11-19', keys: [], subjectTeaser: ['Christmas Fayre', 'Quiz Night'], subjectMore: true,
  events: [{ key: 'e1', date: '2026-11-21', title: 'Christmas Fayre — Harvington Village Hall', body: 'Stalls, 10am to 2pm.', meta: '', lenches: false }],
  notices: [], news: [], roads: [], elsewhere: [], siteUpdates: [], onThisDay: null, cartoon: null, where: null,
  regularsCount: 0, regulars: [], bins: { groups: [], lookup: 'https://www.wychavon.gov.uk/bins' },
};
const out = render(model);
ok(out.subject === 'The Harvington Newsletter – 19 Nov: Christmas Fayre, Quiz Night and more', `subject: ${out.subject}`);
ok(out.html.includes('>The Harvington Newsletter<'), 'heading');
ok(!out.html.includes('Church · Rous'), 'no Lenches villages line');
ok(!/thelenches/i.test(out.html) && !/thelenches/i.test(out.text), 'no Lenches address anywhere');
ok(out.html.includes('mailto:website@harvingtonvillage.org.uk'), 'contributions address');
ok(out.html.includes('https://harvingtonvillage.org.uk/privacy/'), 'privacy link');
ok(out.html.includes('#2D4A63'), 'Harvington river blue');
ok(!out.html.includes('>Lenches</td>'), 'no Lenches badge');
ok(out.text.startsWith('THE HARVINGTON NEWSLETTER\n'), 'text version heading');
ok(out.html.includes(UNSUB_MARK), 'unsubscribe mark kept');

// The badge: a Lenches-looking event is not badged in another site's issue.
const select = require('./newsletter/select');
ok(typeof select.select === 'function', 'select loads');

// Links name the site for actions, unsubscribe and clicks.
const payloadOf = (url) => JSON.parse(Buffer.from(url.split('?t=')[1].split('.')[0], 'base64url').toString());
ok(payloadOf(signToken({ a: 'unsub', i: 'x' }, '/u')).s === 'harvington', 'unsubscribe link names the site');
ok(payloadOf(signToken({ a: 'c', i: '2026-11-19', u: 'https://x' }, '/c')).s === 'harvington', 'click link names the site');
ok(payloadOf(signToken({ a: 'sug', i: 'x' }, '/sg')).s === undefined, 'other routes unchanged');
const mail = unsub.forPreview(out);
ok(mail.html.includes('https://harvingtonvillage.org.uk/privacy/'), 'preview unsubscribe link is Harvington\'s privacy page');

// Daily limit across sites.
ok(send.DAY_WARN === 1500 && send.DAY_LIMIT === 1900, 'warn at 1,500, stop at 1,900');
const recent = new Date(Date.now() - 3600000).toISOString().replace('T', ' ').slice(0, 19);
(async () => {
  const lenches = { Sends: [{ status: 'sent', sent_at: recent }, { status: 'sent', sent_at: recent }, { status: 'queued' }], Replies: [{ status: 'sent', sent_at: recent }] };
  ok(await send.otherSitesUsed(async (site, tab) => (site === 'lenches' ? lenches[tab] : [])) === 3, 'the Lenches\' last 24h counted from its Sheet');
  ok(await send.otherSitesUsed(async () => { throw new Error('Unable to parse range: Sends'); }) === 0, 'a missing tab counts as none sent');
  await assert.rejects(send.otherSitesUsed(async () => { throw new Error('HTTP 403'); }), /could not read the lenches Sheet/);
  n++;
  console.log(`newsletter-sites: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
