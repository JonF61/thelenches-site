// worker/test/sitestats.test.mjs
// Offline tests for admin/sitestats.js: UK day boundaries, which days the nightly run fills,
// the page list cell, month totals, and the nightly save against mocked Cloudflare and Sheets.
// Run: node --test worker/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ukMidnight, missingDays, pagesCell, parsePages, history, logVisitors, visitorHistory, START, HEADERS } from '../src/admin/sitestats.js';

test('UK midnight in GMT and in BST', () => {
  assert.equal(new Date(ukMidnight('2026-11-03')).toISOString(), '2026-11-03T00:00:00.000Z');
  assert.equal(new Date(ukMidnight('2026-07-01')).toISOString(), '2026-06-30T23:00:00.000Z');
  assert.equal(new Date(ukMidnight('2026-10-25')).toISOString(), '2026-10-24T23:00:00.000Z'); // clocks go back that night
});

test('missing days run from START to yesterday, oldest first, at most 10', () => {
  assert.deepEqual(missingDays([{ date: START }], '2026-10-31'), ['2026-10-29', '2026-10-30']);
  assert.deepEqual(missingDays([], START), []);
  const many = missingDays([], '2026-12-31');
  assert.equal(many.length, 10);
  assert.equal(many[0], START);
});

test('page list cell round trip', () => {
  const pages = [{ path: '/', views: 30 }, { path: '/bins/', views: 7 }];
  assert.equal(pagesCell(pages), '/ 30 | /bins/ 7');
  assert.deepEqual(parsePages('/ 30 | /bins/ 7'), pages);
  assert.deepEqual(parsePages(''), []);
});

test('history: days newest first, month totals, busiest day and merged top pages', () => {
  const rows = [
    { date: '2026-10-30', views: '40', visits: '12', pages: '/ 20 | /events/ 10' },
    { date: '2026-10-31', views: '60', visits: '20', pages: '/events/ 30 | / 15' },
    { date: '2026-11-01', views: '5', visits: '2', pages: '/ 5' },
    { date: 'junk', views: '9' },
  ];
  const h = history(rows, { date: '2026-11-02', views: 3, visits: 1, pages: [{ path: '/bins/', views: 3 }] });
  assert.deepEqual(h.days.map((d) => d.date), ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
  assert.equal(h.days[0].today, true);
  assert.deepEqual(h.months.map((m) => [m.month, m.views, m.visits, m.days]), [['2026-11', 8, 3, 2], ['2026-10', 100, 32, 2]]);
  assert.deepEqual(h.months[1].busiest, { date: '2026-10-31', views: 60 });
  assert.deepEqual(h.months[1].pages, [{ path: '/events/', views: 40 }, { path: '/', views: 35 }]);
});

const saKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const saPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const env = { CF_ANALYTICS_TOKEN: 'tok', CF_ACCOUNT_ID: 'a'.repeat(32), SHEET_ID: 'sheet123',
  GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: saPem }) };
const cfAnswer = { data: { viewer: { accounts: [{ total: [{ count: 50, sum: { visits: 18 } }], pages: [{ count: 30, dimensions: { requestPath: '/' } }] }] } } };

test('off without the secrets', async () => {
  assert.deepEqual(await logVisitors({}), { off: true });
  assert.deepEqual(await visitorHistory({}), { off: true });
});

test('nightly: makes the tab and header, then saves each missing day with UK boundaries', async () => {
  const real = globalThis.fetch;
  const google = await import('../src/admin/google.js');
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), { status: 200 });
    if (u.includes('graphql')) { calls.push({ cf: JSON.parse(init.body).query }); return new Response(JSON.stringify(cfAnswer), { status: 200 }); }
    if (u.includes('/values/') && (!init.method || init.method === 'GET')) return new Response(JSON.stringify({ error: { message: 'Unable to parse range: Visitors!A1:BZ' } }), { status: 400 });
    calls.push({ sheets: u, body: init.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 200 });
  };
  try {
    google.resetTokenCache();
    const r = await logVisitors(env, Date.parse('2026-10-30T00:10:00Z'));
    assert.deepEqual(r.saved, ['2026-10-28', '2026-10-29']);
    assert.deepEqual(r.failed, []);
    const cf = calls.filter((c) => c.cf);
    assert.match(cf[0].cf, /datetime_geq: "2026-10-28T00:00:00.000Z", datetime_lt: "2026-10-29T00:00:00.000Z"/);
    assert.match(cf[0].cf, /requestHost: "thelenches.org.uk"/);
    const sheetCalls = calls.filter((c) => c.sheets);
    assert.ok(sheetCalls.some((c) => c.body && c.body.requests && c.body.requests[0].addSheet.properties.title === 'Visitors'));
    const appends = sheetCalls.filter((c) => c.sheets.includes(':append')).map((c) => c.body.values);
    assert.deepEqual(appends[0], [HEADERS]);
    assert.deepEqual(appends[1].map((v) => v.slice(0, 4)), [['2026-10-28', 50, 18, '/ 30'], ['2026-10-29', 50, 18, '/ 30']]);
  } finally {
    globalThis.fetch = real;
  }
});
