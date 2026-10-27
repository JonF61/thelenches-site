// worker/test/orgoutreach.test.mjs
// Offline tests for organisation outreach (admin/orgoutreach.mjs): every contacts.json
// `outreach` entry resolves from the site's data, each state (due, draft, waiting, chase,
// chased, noreply, replied, held, noemail), the daily cap, next_check values and the
// orgcheck decision. Run: node --test worker/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  orgEntries, orgState, orgLists, planOrgCheck, planNext, dayCount, dueEmails, recentQuery, PAGE_NAMES, DAY_CAP,
} from '../src/admin/orgoutreach.mjs';
import { dispatchFor, validPayload, ACTIONS } from '../src/core.js';

const data = Object.fromEntries(['contacts', 'council', 'schools', 'health', 'transport']
  .map((n) => [n, JSON.parse(fs.readFileSync(new URL(`../../src/_data/${n}.json`, import.meta.url)))]));
const ORGS = orgEntries(data);
const TODAY = '2026-10-27';
const org = (id) => ORGS.find((o) => o.id === id);
const sentCheck = (id, to, day, extra) => ({ reply_id: `r-${id}`, type: 'outreach', to, status: 'sent', policy_codes: `org_check_${id}`,
  created_at: `${day} 09:00`, sent_at: `${day} 09:05`, ...extra });

test('every outreach entry resolves from the site data', () => {
  assert.equal(ORGS.length, data.contacts.outreach.length);
  assert.equal(new Set(ORGS.map((o) => o.id)).size, ORGS.length, 'ids are unique');
  for (const o of ORGS) {
    assert.ok(/^[a-z0-9-]+$/.test(o.id), o.id);
    assert.ok(o.name && PAGE_NAMES[o.page], `${o.id}: name and a known page`);
    assert.ok(o.shown.length, `${o.id}: something shown on the site`);
    if (o.email) assert.match(o.email, /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/, o.id);
  }
  assert.ok(!ORGS.some((o) => o.id === 'website'), 'never our own address');
  assert.equal(org('south-lenches-pc').greet, 'Kate');
  assert.equal(org('walking').greet, 'Pete');
  assert.equal(org('grey-gable').email, 'grey.gable@nhs.net');
  assert.ok(!org('grey-gable').shown.some((s) => s.includes('@')), 'the hidden address is not part of the entry');
  assert.equal(org('glads').email, '');
});

test('states', () => {
  const lc = org('lenches-club');
  const at = (replies, extra = {}) => orgState(lc, { replies, contacts: [], today: TODAY, ...extra }).state;
  assert.equal(at([]), 'due');
  assert.equal(at([{ ...sentCheck('lenches-club', lc.email, TODAY), status: 'awaiting' }]), 'draft');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-10-20')]), 'waiting');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-10-06')]), 'chase');
  const chase = (day) => ({ ...sentCheck('lenches-club', lc.email, day), reply_id: 'ch', policy_codes: 'org_chase_lenches-club' });
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-09-01'), chase('2026-10-20')]), 'chased');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-08-01'), chase('2026-09-01')]), 'noreply');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2025-10-01'), chase('2025-10-25')]), 'due', 'a year on');
  const reply = { reply_id: 'm1-ack', message_id: 'm1', to: lc.email, type: 'ack', status: 'sent', created_at: '2026-10-10 12:00' };
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-10-01'), reply]), 'replied');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-10-12'), reply]), 'waiting', 'mail from before the check does not count');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-10-01')], { contacts: [{ email: lc.email.toUpperCase(), last_contact: '2026-10-02' }] }), 'replied');
  assert.equal(at([], { orgRow: { id: 'lenches-club', next_check: 'never' } }), 'held');
  assert.equal(at([], { orgRow: { id: 'lenches-club', next_check: '2027-10-27' } }), 'held');
  assert.equal(at([], { orgRow: { id: 'lenches-club', next_check: '2026-10-01' } }), 'due');
  assert.equal(at([{ ...sentCheck('lenches-club', lc.email, '2026-10-06'), status: 'skipped' }]), 'due', 'a rejected check does not count');
  assert.equal(orgState(org('glads'), { today: TODAY }).state, 'noemail');
  // In regular contact: emailed us in the last 6 months.
  assert.equal(at([], { recent: new Set([lc.email]) }), 'regular');
  assert.equal(at([], { contacts: [{ email: 'x@example.org', other_emails: lc.email, last_contact: '2026-06-01' }] }), 'regular');
  assert.equal(at([], { contacts: [{ email: lc.email, last_contact: '2026-03-01' }] }), 'due', 'over 6 months ago');
  assert.equal(at([sentCheck('lenches-club', lc.email, '2026-10-01')], { recent: new Set([lc.email]) }), 'chase', 'only replaces due');
  assert.equal(planOrgCheck(lc, { replies: [], contacts: [], today: TODAY, recent: new Set([lc.email]) }).status, 409);
  assert.deepEqual(dueEmails(ORGS, { replies: [], contacts: [], orgRows: [{ id: 'lenches-club', next_check: 'never' }], today: TODAY })
    .includes(lc.email), false, 'held ones are not looked up');
  assert.equal(recentQuery('A@Example.org'), 'from:a@example.org newer_than:183d');
  // Another organisation's rows never count.
  assert.equal(at([sentCheck('tennis', lc.email, '2026-10-20')]), 'due');
});

test('lists, cap and plans', () => {
  const v = orgLists(ORGS, { replies: [], contacts: [], orgRows: [], today: TODAY });
  assert.equal(v.lists.due.length + v.lists.noemail.length, ORGS.length);
  assert.equal(v.count, 0);
  assert.equal(v.cap, DAY_CAP);
  const lc = org('lenches-club');
  assert.deepEqual(planOrgCheck(lc, { replies: [], contacts: [], today: TODAY }), { ok: true, kind: 'check' });
  assert.deepEqual(planOrgCheck(lc, { replies: [sentCheck('lenches-club', lc.email, '2026-10-01')], contacts: [], today: TODAY }), { ok: true, kind: 'chase' });
  assert.equal(planOrgCheck(lc, { replies: [sentCheck('lenches-club', lc.email, '2026-10-20')], contacts: [], today: TODAY }).status, 409);
  assert.equal(planOrgCheck(null, { today: TODAY }).status, 404);
  assert.equal(planOrgCheck(org('glads'), { replies: [], today: TODAY }).status, 409);
  const many = Array.from({ length: DAY_CAP }, (_, i) => ({ ...sentCheck(`x${i}`, `p${i}@example.org`, TODAY), status: 'skipped' }));
  assert.equal(dayCount(many, TODAY), DAY_CAP);
  assert.equal(planOrgCheck(lc, { replies: many, contacts: [], today: TODAY }).status, 429);
  assert.deepEqual(planNext('2027-10-27'), { value: '2027-10-27' });
  assert.deepEqual(planNext('Never'), { value: 'never' });
  assert.deepEqual(planNext(''), { value: '' });
  assert.ok(planNext('soon').error);
});

test('orgcheck goes to approval.yml with the slug only', () => {
  assert.ok(ACTIONS.orgcheck);
  assert.ok(validPayload({ a: 'orgcheck', i: 'lenches-club' }));
  assert.deepEqual(dispatchFor({ a: 'orgcheck', i: 'lenches-club' }), ['approval', { id: 'lenches-club', action: 'orgcheck' }]);
});
