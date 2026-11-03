// worker/test/checker.test.mjs: the panel's Checker list and Dismiss rules (admin/checker.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkerRows, planDismiss, CHECK_SCOPES } from '../src/admin/checker.js';

const row = (id, scope, status, severity = 'check', created_at = '2026-11-01 18:37') => ({ id, scope, status, severity, created_at, problem: 'p' });

test('open findings only, newsletter first, problems before checks; last run per scope', () => {
  const t = { rows: [
    row('K2-s1', 'site', 'open', 'check', '2026-11-01 20:13'),
    row('K1-n1', 'newsletter', 'replaced'),
    row('K2-n2', 'newsletter', 'open', 'check', '2026-11-04 18:37'),
    row('K2-n1', 'newsletter', 'open', 'problem', '2026-11-04 18:37'),
    row('K1-l1', 'listings', 'dismissed', 'problem', '2026-11-01 19:17'),
    row('', 'listings', 'open'),
  ] };
  const { open, last } = checkerRows(t);
  assert.deepEqual(open.map((f) => f.id), ['K2-n1', 'K2-n2', 'K2-s1']);
  assert.deepEqual(last, { site: '2026-11-01 20:13', newsletter: '2026-11-04 18:37', listings: '2026-11-01 19:17' });
  assert.deepEqual(checkerRows(null), { open: [], last: {} });
});

test('Dismiss only an open finding', () => {
  assert.equal(planDismiss(undefined).status, 404);
  assert.equal(planDismiss(row('a', 'site', 'dismissed')).status, 409);
  assert.deepEqual(planDismiss(row('a', 'site', 'open')), { field: 'status', expected: 'open', value: 'dismissed' });
  assert.deepEqual(CHECK_SCOPES, ['newsletter', 'listings', 'site']);
});
