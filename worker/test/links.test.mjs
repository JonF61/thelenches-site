// worker/test/links.test.mjs: SEO → Inbound links (admin/links.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLinkEdit, linkPartners, LINK_STATUSES, requestsFor, planLinkAsk, bothReplies } from '../src/admin/links.mjs';

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
    { waiting: false, requestSent: '2026-11-27', requestSentAt: '2026-11-27 10:00', chaseSent: '', viaOther: false });
});

test('planLinkAsk: no chaser once emails have gone back and forth since the request', async () => {
  const { theirMail, talkSince, ukEpoch } = await import('../src/admin/links.mjs');
  const asked = { ...partner, status: 'Asked' };
  const req = [sent('link_request_arch', '2026-11-27')];
  const reply = (to, at) => ({ type: 'answer', status: 'sent', to, created_at: at, policy_codes: '' });
  // Holly answered them (their address, or a colleague at their own domain) after the request.
  for (const to of ['office@arch.example', 'Clerk <clerk@arch.example>']) {
    const p = planLinkAsk(asked, [...req, reply(to, '2026-11-29 09:00')], '2026-12-20');
    assert.equal(p.status, 409);
    assert.match(p.error, /emailing them since the request \(latest 2026-11-29\)/);
  }
  // Before the request, someone else, or a shared free-mail domain: no effect.
  assert.deepEqual(planLinkAsk(asked, [...req, reply('office@arch.example', '2026-11-20 09:00')], '2026-12-20'), { kind: 'chase' });
  assert.deepEqual(planLinkAsk(asked, [...req, reply('someone@else.example', '2026-11-29 09:00')], '2026-12-20'), { kind: 'chase' });
  const gm = { ...asked, email: 'arch@gmail.com' };
  const greq = [{ ...req[0], to: 'arch@gmail.com' }];
  assert.deepEqual(planLinkAsk(gm, [...greq, reply('other@gmail.com', '2026-11-29 09:00')], '2026-12-20'), { kind: 'chase' });
  // Gmail's live check (heard) blocks too; a first request is never blocked.
  assert.equal(planLinkAsk(asked, req, '2026-12-20', '', { heard: '2026-12-01 10:00' }).status, 409);
  assert.deepEqual(planLinkAsk(partner, [reply('office@arch.example', '2026-11-29 09:00')], '2026-11-30'), { kind: 'request' });
  assert.equal(talkSince('arch', 'office@arch.example', req, ''), '');
  assert.equal(theirMail('office@arch.example').query, 'from:office@arch.example to:office@arch.example from:@arch.example to:@arch.example');
  assert.equal(theirMail('arch@gmail.com').query, 'from:arch@gmail.com to:arch@gmail.com');
  assert.equal(ukEpoch('2026-11-27 08:58'), Date.UTC(2026, 10, 27, 8, 58) / 1000, 'GMT in winter');
  assert.equal(ukEpoch('2026-07-01 10:00'), Date.UTC(2026, 6, 1, 9, 0) / 1000, 'BST in summer');
});

test('linkPartners: each card says what Draft request would do', () => {
  const t = linkPartners({ headers: ['id'], rows: [partner, { id: 'x', name: 'X', status: '' }] }, [], '2026-11-26');
  assert.deepEqual(t.partners.find((p) => p.id === 'arch').ask, { kind: 'request' });
  assert.match(t.partners.find((p) => p.id === 'x').ask.why, /email address/);
});

test('one request for both sites (27 Nov): counts on the other site, whose chaser goes from the first', () => {
  const sent = [{ policy_codes: 'link_request_arch-benefice link_request_arch@harvington', status: 'sent', sent_at: '2026-11-27 10:00' }];
  const r = requestsFor('arch', sent, 'harvington');
  assert.deepStrictEqual(r, { waiting: false, requestSent: '2026-11-27', requestSentAt: '2026-11-27 10:00', chaseSent: '', viaOther: true });
  assert.strictEqual(requestsFor('arch', sent, '').requestSent, '', 'without the site, another site\'s code never counts');
  const row = { id: 'arch', email: 'a@b.example', status: 'Asked' };
  assert.match(planLinkAsk(row, sent, '2027-01-01', 'harvington').error, /other site/);
  assert.strictEqual(planLinkAsk({ ...row, id: 'arch-benefice' }, sent, '2027-01-01', 'lenches').kind, 'chase');
  assert.deepStrictEqual(bothReplies([1], [[2], [3]]), [1, 2, 3]);
});

test('a sent request shows as Asked before the Monday check writes it (27 Nov)', () => {
  const sent = [{ policy_codes: 'link_request_arch', status: 'sent', sent_at: '2026-11-27 09:20' }];
  const t = linkPartners({ headers: ['id'], rows: [{ id: 'arch', name: 'ARCH', status: 'To ask', email: 'a@b.example' }, { id: 'y', name: 'Y', status: 'To ask' }] }, sent, '2026-11-27');
  const p = t.partners.find((x) => x.id === 'arch');
  assert.equal(p.status, 'Asked');
  assert.equal(p._status, 'To ask', 'edits still checked against the Sheet');
  assert.deepEqual(t.counts, { 'To ask': 1, Asked: 1 });
});
