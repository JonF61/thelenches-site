// worker/test/links.test.mjs: SEO → Inbound links (admin/links.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLinkEdit, linkPartners, LINK_STATUSES } from '../src/admin/links.mjs';

const row = { id: 'arch', name: 'ARCH', status: 'To ask', notes: '', email: '' };

test('planLinkEdit: status, notes and email only, cleaned and checked', () => {
  assert.deepEqual(planLinkEdit(row, { field: 'status', value: 'Asked', expected: 'To ask' }, '2026-11-26'),
    { field: 'status', expected: 'To ask', value: 'Asked', also: { asked_at: '2026-11-26' } });
  assert.equal(planLinkEdit({ ...row, status: 'Asked' }, { field: 'status', value: 'Asked', expected: 'Asked' }, 'd').also, null);
  assert.equal(planLinkEdit(row, { field: 'status', value: 'Maybe' }).status, 400);
  assert.equal(planLinkEdit(row, { field: 'url', value: 'x' }).status, 400);
  assert.equal(planLinkEdit(row, { field: 'link_found_at', value: 'x' }).status, 400, 'the check columns are the check\'s');
  assert.equal(planLinkEdit(row, { field: 'email', value: 'not an address' }).status, 400);
  assert.equal(planLinkEdit(row, { field: 'email', value: ' info@arch.org.uk ' }).value, 'info@arch.org.uk');
  assert.equal(planLinkEdit(row, { field: 'email', value: '' }).value, '', 'clearing is allowed');
  assert.equal(planLinkEdit(row, { field: 'notes', value: 'x'.repeat(501) }).status, 400);
  assert.equal(planLinkEdit(null, { field: 'notes', value: 'x' }).status, 404);
});

test('linkPartners: order, counts, blank status reads To ask, missing tab', () => {
  const t = linkPartners({ headers: ['id'], rows: [
    { id: 'a', name: 'Zed', status: 'Linking' }, { id: 'b', name: 'Bee', status: '' }, { id: 'c', name: 'Cee', status: 'Declined' },
    { id: 'd', name: 'Dee', status: 'Link gone' }, { id: '', name: '' },
  ] });
  assert.deepEqual(t.partners.map((p) => p.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(t.counts, { 'To ask': 1, 'Link gone': 1, Linking: 1, Declined: 1 });
  assert.equal(t.partners[0]._status, '', 'expected value is the raw cell');
  assert.equal(t.made, true);
  assert.deepEqual(t.statuses, LINK_STATUSES);
  assert.equal(linkPartners({ headers: [], rows: [] }).made, false);
});

import { planLinkAsk, requestsFor } from '../src/admin/links.mjs';

const partner = { id: 'arch', name: 'ARCH', status: 'To ask', email: 'office@arch.example' };
const sent = (code, day) => ({ policy_codes: code, status: 'sent', sent_at: `${day} 10:00`, to: 'office@arch.example' });

test('planLinkAsk: request, then one chaser 21 days on, never past Linking/Declined/Not now', () => {
  assert.deepEqual(planLinkAsk(partner, [], '2026-11-26'), { kind: 'request' });
  assert.equal(planLinkAsk({ ...partner, email: '' }, [], '2026-11-26').status, 400);
  for (const st of ['Linking', 'Declined', 'Not now']) assert.equal(planLinkAsk({ ...partner, status: st }, [], '2026-11-26').status, 409);
  assert.match(planLinkAsk(partner, [{ policy_codes: 'link_request_arch', status: 'awaiting' }], '2026-11-26').error, /already waiting/);
  const req = [sent('link_request_arch', '2026-11-27')];
  assert.match(planLinkAsk({ ...partner, status: 'Asked' }, req, '2026-12-17').error, /chaser is due from 2026-12-18/);
  assert.deepEqual(planLinkAsk({ ...partner, status: 'Asked' }, req, '2026-12-18'), { kind: 'chase' });
  assert.match(planLinkAsk({ ...partner, status: 'Link gone' }, [...req, sent('link_chase_arch', '2026-12-19')], '2027-02-01').error, /chased 2026-12-19/);
  assert.deepEqual(requestsFor('arch', [...req, { policy_codes: 'link_request_other', status: 'sent', sent_at: '2026-11-01' }]),
    { waiting: false, requestSent: '2026-11-27', chaseSent: '' });
});

test('linkPartners: each card says what Draft request would do', () => {
  const t = linkPartners({ headers: ['id'], rows: [partner, { id: 'x', name: 'X', status: '' }] }, [], '2026-11-26');
  assert.deepEqual(t.partners.find((p) => p.id === 'arch').ask, { kind: 'request' });
  assert.match(t.partners.find((p) => p.id === 'x').ask.why, /email address/);
});
