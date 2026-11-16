// Rimmer's scheduled checks are fired by the Worker's crons (16 Nov 2026), not GitHub's cron.
// Run: node worker/test/rimmercron.test.mjs
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = { REPO: 'JonF61/thelenches-site', DISPATCH_TOKEN: 'x', SCHEDULE: 'on', NIGHTLY: 'off', INGEST: 'off', DAILY: 'off' };
let sent = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).endsWith('/dispatches')) {
    sent.push(JSON.parse(opts.body));
    return new Response(null, { status: 204 });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
console.log = () => {};

async function fire(cron, iso) {
  sent = [];
  const waits = [];
  await worker.scheduled({ cron, scheduledTime: Date.parse(iso) }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.allSettled(waits);
  return sent.filter((b) => b.event_type === 'rimmer').map((b) => b.client_payload.scope);
}

const HOURLY = '0,17 * * * *';
const SCHED = '0,30 * * * WED,THU';
let n = 0;
const t = async (name, f) => { await f(); n++; console.error(`ok ${name}`); };

await t('newsletter Wed 19:00 GMT', async () => assert.deepEqual(await fire(SCHED, '2026-11-18T19:00:00Z'), ['newsletter']));
await t('newsletter Wed 19:00 BST', async () => assert.deepEqual(await fire(SCHED, '2027-06-02T18:00:00Z'), ['newsletter']));
await t('no newsletter at 18:30', async () => assert.deepEqual(await fire(SCHED, '2026-11-18T18:30:00Z'), []));
await t('listings Sun 19:17 GMT', async () => assert.deepEqual(await fire(HOURLY, '2026-11-22T19:17:00Z'), ['listings']));
await t('listings Sun 19:17 BST', async () => assert.deepEqual(await fire(HOURLY, '2027-06-06T18:17:00Z'), ['listings']));
await t('nothing Sun 19:00 or Mon 19:17', async () => {
  assert.deepEqual(await fire(HOURLY, '2026-11-22T19:00:00Z'), []);
  assert.deepEqual(await fire(HOURLY, '2026-11-23T19:17:00Z'), []);
});
await t('site on the 1st 20:17', async () => assert.deepEqual(await fire(HOURLY, '2026-12-01T20:17:00Z'), ['site']));
await t('no site on the 2nd', async () => assert.deepEqual(await fire(HOURLY, '2026-12-02T20:17:00Z'), []));
console.error(`${n} passed`);
