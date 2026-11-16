// The veto window runs for each site against its own Sheet (Harvington stage 4c-2, 16 Nov 2026).
// With no Google key every Sheet read fails, so each site's attempt shows as its own error line:
// both sites are tried, the Lenches first, and one failing never stops the other.
// Run: node --test worker/test/autowindowcron.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('veto window cron: tried for each site, the Lenches first', async () => {
  const env = { REPO: 'JonF61/thelenches-site', DISPATCH_TOKEN: 'x', SCHEDULE: 'off', NIGHTLY: 'off', INGEST: 'off', DAILY: 'off', SHEET_ID: 'sheet123' };
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const errors = [];
  const keep = [console.error, console.log];
  console.error = (m) => errors.push(String(m));
  console.log = () => {};
  try {
    const waits = [];
    await worker.scheduled({ cron: '0,17 * * * *', scheduledTime: Date.parse('2026-11-17T10:17:00Z') }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.allSettled(waits);
  } finally {
    [console.error, console.log] = keep;
  }
  const tried = errors.map((m) => (m.match(/^Veto window run \((\w+)\) failed/) || [])[1]).filter(Boolean);
  assert.deepEqual(tried, ['lenches', 'harvington']);
});
