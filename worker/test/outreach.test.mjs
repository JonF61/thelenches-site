// worker/test/outreach.test.mjs
// Offline tests for outreach (admin/outreach.mjs): who is due a nudge and why, who is held
// back, the weekly cap, the contact id hash, next_nudge edits, and the nudge decision.
// Run: node --test worker/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  idFor, contributionList, dueFor, sentRows, heldBack, weekCount, outreachLists, planNudge, seasonalFor, WEEK_CAP,
} from '../src/admin/outreach.mjs';
import { planContact } from '../src/admin/contacts.js';
import { dispatchFor, validPayload, ACTIONS } from '../src/core.js';

const TODAY = '2026-10-26';
const c = (extra) => ({
  email: 'a@example.org', name: 'Ann', status: 'contributor', contributions: '', contribution_count: '0',
  first_contact: '2025-01-01', last_contact: '2026-01-10', next_nudge: '', ...extra,
});
const nudge = (to, created, status = 'sent') => ({ type: 'outreach', to, created_at: `${created} 09:00`, status });

test('idFor: "c" + 16 hex of SHA-256 of the lower-cased address', async () => {
  const want = `c${createHash('sha256').update('a@example.org').digest('hex').slice(0, 16)}`;
  assert.equal(await idFor(' A@Example.org '), want);
  assert.ok(validPayload({ a: 'nudge', i: want }));
});

test('contributionList: dated entries, tags dropped, newest first', () => {
  assert.deepEqual(contributionList('2025-11-08 Quiz night (event, approved); 2026-02-01 Bingo (fun) night (event); junk'),
    [{ date: '2026-02-01', title: 'Bingo (fun) night' }, { date: '2025-11-08', title: 'Quiz night' }]);
});

test('seasonal: anniversary 4 weeks ahead to a week past, nothing sent this season', () => {
  const row = c({ status: 'organiser', contributions: '2025-11-08 Quiz night (event)', contribution_count: '1', last_contact: '2025-11-08' });
  assert.equal(dueFor(row, TODAY).kind, 'seasonal');
  assert.equal(seasonalFor(row, TODAY).anniversary, '2026-11-08');
  assert.equal(seasonalFor(row, '2026-10-10'), null, 'too early');
  assert.equal(seasonalFor(row, '2026-11-16'), null, 'too late');
  assert.equal(seasonalFor({ ...row, contributions: '2026-10-01 Quiz night; 2025-11-08 Quiz night' }, TODAY), null, 'already sent this season');
  assert.equal(dueFor({ ...row, status: 'lead' }, TODAY), null, 'leads are never seasonal');
});

test('quiet: 90 to 365 days, only contributor / organiser / collaborator', () => {
  assert.equal(dueFor(c({ last_contact: '2026-07-01' }), TODAY).kind, 'quiet');
  assert.equal(dueFor(c({ last_contact: '2026-09-01' }), TODAY), null, 'too recent');
  assert.equal(dueFor(c({ last_contact: '2025-09-01' }), TODAY), null, 'over a year');
  for (const status of ['official', 'business', 'media', 'other', 'not a contributor', 'ignore', '']) {
    assert.equal(dueFor(c({ status, last_contact: '2026-07-01' }), TODAY), null, status);
  }
});

test('lead: no contributions, first email 14+ days ago, within a year', () => {
  const lead = c({ status: 'lead', first_contact: '2026-09-02', last_contact: '2026-09-02' });
  assert.equal(dueFor(lead, TODAY).kind, 'lead');
  assert.equal(dueFor({ ...lead, first_contact: '2026-10-20', last_contact: '2026-10-20' }, TODAY), null);
  assert.equal(dueFor({ ...lead, contribution_count: '2' }, TODAY), null);
});

test('heldBack: never, snoozed, waiting draft, nudged in 120 days; skipped drafts do not count', () => {
  const row = c({ last_contact: '2026-07-01' });
  assert.equal(heldBack({ ...row, next_nudge: 'never' }, [], TODAY), 'never nudge');
  assert.equal(heldBack({ ...row, next_nudge: '2027-01-26' }, [], TODAY), 'snoozed until 2027-01-26');
  assert.equal(heldBack({ ...row, next_nudge: '2026-10-01' }, [], TODAY), '');
  assert.equal(heldBack(row, [nudge('A@example.org', '2026-10-20', 'awaiting')], TODAY), 'a draft is waiting for you');
  assert.equal(heldBack(row, [nudge('a@example.org', '2026-08-01')], TODAY), 'nudged 2026-08-01');
  assert.equal(heldBack(row, [nudge('a@example.org', '2026-05-01')], TODAY), '');
  assert.equal(heldBack(row, [nudge('a@example.org', '2026-10-20', 'skipped')], TODAY), '');
});

test('outreachLists and planNudge', async () => {
  const rows = [
    c({ email: 'q@example.org', last_contact: '2026-07-01' }),
    c({ email: 's@example.org', last_contact: '2026-07-01', next_nudge: 'never' }),
    c({ email: 'n@example.org', last_contact: '2026-10-01' }),
  ];
  const o = await outreachLists(rows, [], TODAY);
  assert.deepEqual(o.quiet.map((e) => e.email), ['q@example.org']);
  assert.deepEqual(o.held.map((e) => [e.email, e.held]), [['s@example.org', 'never nudge']]);
  assert.equal(o.cap, WEEK_CAP);
  assert.ok(planNudge(rows[0], [], TODAY).ok);
  assert.equal(planNudge(rows[1], [], TODAY).status, 409);
  assert.equal(planNudge(rows[2], [], TODAY).status, 409);
  assert.equal(planNudge(null, [], TODAY).status, 404);
  const five = [1, 2, 3, 4, 5].map((i) => nudge(`p${i}@example.org`, '2026-10-2' + i, 'skipped'));
  assert.equal(weekCount(five, TODAY), 5);
  assert.equal(planNudge(rows[0], five, TODAY).status, 429);
  assert.equal(weekCount([nudge('p@example.org', '2026-10-19')], TODAY), 0, 'older than 7 days');
});

test('next_nudge edits: a date, never or blank', () => {
  const row = c({});
  assert.deepEqual(planContact({ field: 'next_nudge', value: '2027-01-26' }, row), { field: 'next_nudge', value: '2027-01-26', also: null });
  assert.equal(planContact({ field: 'next_nudge', value: 'Never' }, row).value, 'never');
  assert.equal(planContact({ field: 'next_nudge', value: '' }, row).value, '');
  assert.equal(planContact({ field: 'next_nudge', value: 'soon' }, row).status, 400);
});

test('nudge goes to approval.yml with the hashed id only', async () => {
  const i = await idFor('a@example.org');
  assert.deepEqual(dispatchFor({ a: 'nudge', i }), ['approval', { id: i, action: 'nudge' }]);
  assert.equal(ACTIONS.nudge[0], 'Draft nudge');
});

test('Redraft link shows the draft it carries; only the instruction is dispatched', async () => {
  const { createHmac } = await import('node:crypto');
  const { default: worker } = await import('../src/index.js');
  const env = { APPROVAL_SIGNING_KEY: 'k', DISPATCH_TOKEN: 't', REPO: 'o/r' };
  const sign = (p) => {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return `${body}.${createHmac('sha256', 'k').update(body).digest('base64url')}`;
  };
  const e = Math.floor(Date.now() / 1000) + 3600;
  const t = sign({ i: 'out-c1-202610260918', a: 'redraft', t: 'Reply to g@example.org', b: 'Hi George,\n\n<b>EP</b> news?', e });
  const html = await (await worker.fetch(new Request(`https://w.example/a?t=${t}`), env)).text();
  assert.match(html, /The draft now:[\s\S]*Hi George,\n\n&lt;b&gt;EP&lt;\/b&gt; news\?/);
  const plain = await (await worker.fetch(new Request(`https://w.example/a?t=${sign({ i: 'r1', a: 'redraft', t: 'x', e })}`), env)).text();
  assert.doesNotMatch(plain, /The draft now/);
  assert.match(plain, /What should Holly change/);

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
  try {
    const form = new FormData();
    form.set('t', t);
    form.set('reason', 'Drop the October bit');
    const r = await worker.fetch(new Request('https://w.example/a', { method: 'POST', body: form }), env);
    assert.equal(r.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [{ event_type: 'approval', client_payload: { id: 'out-c1-202610260918', action: 'redraft', reason: 'Drop the October bit' } }]);
});

test('sentRows: sent only, newest first, by type, limited', async () => {
  const rows = [
    { reply_id: 'a', status: 'sent', type: 'ack', to: 'x@example.org', sent_at: '2026-10-25 10:00', notes: 'n' },
    { reply_id: 'b', status: 'sent', type: 'outreach', to: 'A@example.org', sent_at: '2026-10-26 09:00' },
    { reply_id: 'c', status: 'awaiting', type: 'outreach', to: 'y@example.org' },
  ];
  assert.deepEqual(sentRows(rows).map((r) => r.reply_id), ['b', 'a']);
  assert.equal('notes' in sentRows(rows)[1], false);
  assert.deepEqual(sentRows(rows, { type: 'outreach' }).map((r) => r.reply_id), ['b']);
  assert.equal(sentRows(rows, { limit: 1 }).length, 1);
  const o = await outreachLists([c({ email: 'a@example.org', name: 'Ann' })], rows, TODAY);
  assert.deepEqual(o.sent.map((r) => [r.reply_id, r.name]), [['b', 'Ann']]);
});
