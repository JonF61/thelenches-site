// node --test scripts/ingest/subscriptions.test.js — offline.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { offListFrom, planContactSubscriptions } = require('./subscriptions');
const { buildBody } = require('./replies');

const subs = [
  { email: 'Active@x.org', status: 'active' },
  { email: 'blank@x.org', status: '' },
  { email: 'gone@x.org', status: 'unsubscribed' },
];
const dns = [{ email: 'dns@x.org', reason: 'asked by email' }];

test('offListFrom: Do Not Send and non-active Subscribers rows', () => {
  const off = offListFrom(subs, dns);
  assert.equal(off.get('dns@x.org'), 'on Do Not Send (asked by email)');
  assert.equal(off.get('gone@x.org'), 'Subscribers status "unsubscribed"');
  assert.equal(off.has('active@x.org'), false);
  assert.equal(off.has('blank@x.org'), false);
});

test('planContactSubscriptions adds only new, usable, not-unsubscribed addresses', () => {
  const p = planContactSubscriptions(
    ['active@x.org', 'BLANK@x.org', 'gone@x.org', 'dns@x.org', 'new@x.org', 'new@x.org', 'me@thelenches.org.uk', 'bad', ''],
    subs, dns);
  assert.deepEqual(p.add, ['new@x.org']);
  assert.equal(p.already, 2);
  assert.equal(p.offList, 2);
  assert.equal(p.unusable, 2);
});

test('acknowledgement carries the newsletter line only when newly joined', () => {
  const items = [{ title: 'Craft fair', event_date: '', policy: [] }];
  const yes = buildBody({ items, name: 'Kate', joined: true });
  const no = buildBody({ items, name: 'Kate' });
  assert.match(yes, /added you to our weekly newsletter so you can see your entry\. To stop it, just reply UNSUBSCRIBE\./);
  assert.doesNotMatch(no, /weekly newsletter so you can see/);
  console.log(yes);
});

test('ingest: unsubscribed sender found, alert text for Jon', () => {
  const { offListReason, offListAlertText } = require('./index');
  const ctx = { offList: offListFrom(subs, dns) };
  assert.equal(offListReason(ctx, ' DNS@x.org '), 'on Do Not Send (asked by email)');
  assert.equal(offListReason(ctx, 'active@x.org'), '');
  assert.equal(offListReason({}, 'dns@x.org'), '');
  const t = offListAlertText([{ from: 'A <dns@x.org>', subject: 'Fair', items: ['Craft fair'], reason: 'on Do Not Send', link: 'https://mail' }]);
  assert.match(t, /nothing was published and Holly did not reply/);
  assert.match(t, /Items: Craft fair/);
});
