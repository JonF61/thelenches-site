// worker/test/rimmer.test.mjs: the panel's Rimmer list and the Dismiss / Send to Kryten / Fix rules
// (admin/rimmer.js), and the rfix / rfix_ok decisions (core.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rimmerRows, planDismiss, planKryten, planFix, CHECK_SCOPES } from '../src/admin/rimmer.js';
import { dispatchFor, validPayload, PANEL_ONLY } from '../src/core.js';

const row = (id, scope, status, severity = 'check', created_at = '2026-11-01 18:37', extra = {}) => ({ id, scope, status, severity, created_at, problem: 'p', ...extra });

test('open findings only, newsletter first, problems before checks; Kryten list; last run per scope', () => {
  const t = { rows: [
    row('K2-s1', 'site', 'open', 'check', '2026-11-01 20:13'),
    row('K1-n1', 'newsletter', 'replaced'),
    row('K2-n2', 'newsletter', 'open', 'check', '2026-11-04 18:37', { fix_status: 'proposed', fix_new: 'x' }),
    row('K2-n1', 'newsletter', 'open', 'problem', '2026-11-04 18:37'),
    row('K1-l1', 'listings', 'dismissed', 'problem', '2026-11-01 19:17'),
    row('K1-l2', 'listings', 'kryten', 'problem', '2026-11-01 19:17', { fix_note: 'layout' }),
    row('', 'listings', 'open'),
  ] };
  const { open, kryten, last } = rimmerRows(t);
  assert.deepEqual(open.map((f) => f.id), ['K2-n1', 'K2-n2', 'K2-s1']);
  assert.equal(open[1].fix_status, 'proposed');
  assert.equal(open[1].fix_new, 'x');
  assert.deepEqual(kryten.map((f) => [f.id, f.fix_note]), [['K1-l2', 'layout']]);
  assert.deepEqual(last, { site: '2026-11-01 20:13', newsletter: '2026-11-04 18:37', listings: '2026-11-01 19:17' });
  assert.deepEqual(rimmerRows(null), { open: [], kryten: [], last: {} });
});

test('Dismiss and Send to Kryten only an open finding', () => {
  assert.equal(planDismiss(undefined).status, 404);
  assert.equal(planDismiss(row('a', 'site', 'dismissed')).status, 409);
  assert.deepEqual(planDismiss(row('a', 'site', 'open')), { field: 'status', expected: 'open', value: 'dismissed' });
  assert.deepEqual(planKryten(row('a', 'site', 'open'), ' needs\nlayout '), { field: 'status', expected: 'open', value: 'kryten', also: { fix_note: 'needs layout' } });
  assert.equal(planKryten(row('a', 'site', 'open', 'check', '', { fix_status: 'asked' })).status, 409);
  assert.deepEqual(CHECK_SCOPES, ['newsletter', 'listings', 'site']);
});

test('Fix…, Apply and Discard: stale-checked fix_status moves, decisions only for propose and apply', () => {
  const fresh = row('a', 'site', 'open');
  assert.deepEqual(planFix(fresh, { op: 'propose', note: 'Fran: 01386 000000', expected: '' }),
    { field: 'fix_status', expected: '', value: 'asked', also: { fix_note: 'Fran: 01386 000000' }, action: 'rfix' });
  assert.equal(planFix(fresh, { op: 'propose', expected: 'proposed' }).status, 409);
  assert.equal(planFix(row('a', 'site', 'open', 'check', '', { fix_status: 'asked' }), { op: 'propose', expected: 'asked' }).status, 409);
  const prop = row('a', 'site', 'open', 'check', '', { fix_status: 'proposed' });
  assert.deepEqual(planFix(prop, { op: 'apply', expected: 'proposed' }), { field: 'fix_status', expected: 'proposed', value: 'applying', action: 'rfix_ok' });
  assert.equal(planFix(fresh, { op: 'apply', expected: '' }).status, 409);
  assert.deepEqual(planFix(prop, { op: 'discard', expected: 'proposed' }), { field: 'fix_status', expected: 'proposed', value: 'discarded' });
  assert.equal(planFix(prop, { op: 'propose', expected: 'proposed' }).action, 'rfix');
  assert.equal(planFix(row('a', 'site', 'fixed'), { op: 'apply', expected: '' }).status, 409);
  assert.equal(planFix(prop, { op: 'zap', expected: 'proposed' }).status, 400);
  // A fix Holly drafted with Rimmer's own run ("offered", 4 Nov): Apply, Discard or ask again.
  const off = row('b', 'listings', 'open', 'problem', '', { fix_status: 'offered' });
  assert.deepEqual(planFix(off, { op: 'apply', expected: 'offered' }), { field: 'fix_status', expected: 'offered', value: 'applying', action: 'rfix_ok' });
  assert.deepEqual(planFix(off, { op: 'discard', expected: 'offered' }), { field: 'fix_status', expected: 'offered', value: 'discarded' });
  assert.equal(planFix(off, { op: 'propose', expected: 'offered', note: 'It is on 6 December' }).value, 'asked');
  assert.equal(planFix(off, { op: 'apply', expected: 'proposed' }).status, 409);
  assert.equal(planKryten(off, '').value, 'kryten');
  assert.equal(planDismiss(off).value, 'dismissed');
  assert.equal(planFix(undefined, { op: 'apply' }).status, 404);
});

test('rfix / rfix_ok: panel only, to rimmer-fix with the finding id only', () => {
  assert.ok(PANEL_ONLY.includes('rfix') && PANEL_ONLY.includes('rfix_ok'));
  assert.deepEqual(dispatchFor({ a: 'rfix', i: 'K202611031853-n1' }, 'ignored reason'), ['rimmer-fix', { action: 'propose', id: 'K202611031853-n1' }]);
  assert.deepEqual(dispatchFor({ a: 'rfix_ok', i: 'K202611031853-n1' }), ['rimmer-fix', { action: 'apply', id: 'K202611031853-n1' }]);
  assert.equal(validPayload({ a: 'rfix', i: 'K202611031853-n1' }), true);
  assert.equal(validPayload({ a: 'rfix', i: 'bad id!' }), false);
});
