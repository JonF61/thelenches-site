// worker/test/visitors.test.mjs
// Offline tests for admin/visitors.js: secrets missing, the GraphQL request, and parsing
// Cloudflare's answer (mocked; nothing leaves the machine).
// Run: node --test worker/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { visitors, parseVisitors, HOST } from '../src/admin/visitors.js';

const answer = {
  data: { viewer: { accounts: [{
    total: [{ count: 812, sum: { visits: 301 } }],
    pages: [{ count: 300, dimensions: { requestPath: '/' } }, { count: 120, dimensions: { requestPath: '/bins/' } }],
    days: [{ count: 400, sum: { visits: 150 }, dimensions: { date: '2026-10-27' } }],
  }] } },
};

test('off until both secrets are set', async () => {
  assert.deepEqual(await visitors({ CF_ANALYTICS_TOKEN: 't' }), { off: true });
  assert.deepEqual(await visitors({ CF_ACCOUNT_ID: 'a' }), { off: true });
});

test('asks Cloudflare for this site over the last 7 days and parses the answer', async () => {
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify(answer), { status: 200 }); };
  try {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const v = await visitors({ CF_ANALYTICS_TOKEN: 'tok', CF_ACCOUNT_ID: 'a'.repeat(32) }, now);
    assert.equal(sent.url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(sent.init.headers.authorization, 'Bearer tok');
    const body = JSON.parse(sent.init.body);
    assert.match(body.query, new RegExp(`accountTag: "${'a'.repeat(32)}"`));
    assert.match(body.query, new RegExp(`datetime_geq: "2026-10-21T12:00:00.000Z", datetime_leq: "2026-10-28T12:00:00.000Z", requestHost: "${HOST}"`));
    assert.equal((body.query.match(/rumPageloadEventsAdaptiveGroups/g) || []).length, 3);
    assert.equal(v.views, 812);
    assert.equal(v.visits, 301);
    assert.deepEqual(v.pages[1], { path: '/bins/', views: 120 });
    assert.deepEqual(v.days[0], { date: '2026-10-27', views: 400, visits: 150 });
  } finally {
    globalThis.fetch = real;
  }
});

test('a malformed account ID is refused before any request', async () => {
  assert.match((await visitors({ CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'x"}' })).error, /32-character/);
});

test('errors are reported, not hidden', () => {
  assert.throws(() => parseVisitors({ errors: [{ message: 'not authorized' }] }, ''), /not authorized/);
  assert.throws(() => parseVisitors({ data: { viewer: { accounts: [] } } }, ''), /CF_ACCOUNT_ID/);
  assert.equal(parseVisitors({ data: { viewer: { accounts: [{ total: [], pages: [], days: [] }] } } }, '').views, 0);
});
