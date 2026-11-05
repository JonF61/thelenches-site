// worker/test/sendprogress.test.mjs: the panel's send progress counts (admin/sendprogress.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendProgress } from '../src/admin/sendprogress.js';

test('counts this issue\'s Sends rows by status; live is done when the Issues row says sent', () => {
  const sends = [
    { issue_id: '2026-11-05', status: 'sent' }, { issue_id: '2026-11-05', status: 'sending' }, { issue_id: '2026-11-05', status: 'queued' },
    { issue_id: '2026-11-05', status: 'failed' }, { issue_id: '2026-10-29', status: 'sent' }, { issue_id: '2026-11-05:canary', status: 'sent' },
  ];
  const p = sendProgress(sends, [{ issue_date: '2026-11-05', status: 'tested' }], '2026-11-05');
  assert.deepEqual(p, { issue: '2026-11-05', mode: 'live', total: 4, sent: 1, failed: 1, stuck: 0, queued: 1, sending: 1, status: 'tested', done: false });
  assert.equal(sendProgress(sends, [{ issue_date: '2026-11-05', status: 'sent' }], '2026-11-05').done, true);
  const c = sendProgress(sends, [], '2026-11-05', 'canary');
  assert.equal(c.total, 1);
  assert.equal(c.done, true);
  assert.equal(sendProgress([], [], '2026-11-05').done, false);
  assert.ok(!JSON.stringify(p).includes('@'));
});
