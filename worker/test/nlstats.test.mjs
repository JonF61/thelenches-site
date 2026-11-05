// worker/test/nlstats.test.mjs
// Offline test of nlstats.js sentIssues: issues sent before opens and clicks were counted
// (COUNTS_FROM) are marked early, so the panel stars them. Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { sentIssues, COUNTS_FROM } from '../src/admin/nlstats.js';

test('issues before counts began are marked early', () => {
  const issues = ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05'].map((d) => ({ issue_date: d, status: 'sent', recipients: '420' }));
  const out = sentIssues(issues, [], []);
  assert.equal(COUNTS_FROM, '2026-10-28');
  assert.deepEqual(out.map((x) => [x.date, !!x.early]), [['2026-11-05', false], ['2026-10-29', false], ['2026-10-22', true], ['2026-10-15', true]]);
});
