// worker/test/recommend.test.mjs
// Offline tests for the Recommend buttons (POST /r) and their confirm link (GET/POST /r?t=):
// only listed entries, honeypot, Turnstile, the Recommendations tab being created and
// appended to (with a hashed key), one request per address per entry per day, the
// dispatches (row id only, never an address), the confirm button, and /a and /s refusing
// recommendation tokens. Google, Turnstile and GitHub are mocked; nothing leaves the machine.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';

import { handleRecommend, listedEntry, emailKey, RECOMMEND_HEADERS, RECOMMEND_THANKS } from '../src/recommend.js';
import { resetMemoryLimit } from '../src/feedback.js';
import { resetTokenCache } from '../src/admin/google.js';
import worker from '../src/index.js';

const SITE = 'https://thelenches.org.uk';
const saKey = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const saPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;

const env = (extra = {}) => ({
  SITE_URL: `${SITE}/`,
  SHEET_ID: 'sheet1',
  REPO: 'owner/repo',
  DISPATCH_TOKEN: 'gh',
  TURNSTILE_SECRET: 'ts-secret',
  GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: saPem }),
  ...extra,
});

// Fake Google Sheet (tabs: { title: rows }), Turnstile and GitHub behind global fetch.
function fakeWorld(tabs, { turnstile = true } = {}) {
  const calls = { added: [], appends: [], writes: [], turnstile: [], dispatches: [] };
  const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'goog', expires_in: 3600 });
    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      calls.turnstile.push({ secret: init.body.get('secret'), response: init.body.get('response'), ip: init.body.get('remoteip') });
      return Response.json({ success: turnstile && init.body.get('response') === 'good-token' });
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/owner/repo/dispatches') {
      calls.dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      const path = decodeURIComponent(url.pathname);
      if (path.endsWith(':batchUpdate') && !path.endsWith('values:batchUpdate')) {
        const title = JSON.parse(init.body).requests[0].addSheet.properties.title;
        calls.added.push(title);
        tabs[title] = [];
        return Response.json({});
      }
      if (path.endsWith('values:batchUpdate')) {
        for (const d of JSON.parse(init.body).data) {
          calls.writes.push(d);
          const [, tab, col, row] = d.range.match(/^'(.+)'!([A-Z]+)(\d+)$/);
          d.values.forEach((vals, i) => {
            const r = Number(row) - 1 + i;
            tabs[tab][r] = tabs[tab][r] || [];
            vals.forEach((v, j) => { tabs[tab][r][colIndex(col) + j] = v; });
          });
        }
        return Response.json({});
      }
      const ap = path.match(/\/values\/'(.+)'!A1:append$/);
      if (ap && method === 'POST') {
        assert.equal(url.searchParams.get('valueInputOption'), 'RAW');
        const rows = JSON.parse(init.body).values;
        calls.appends.push({ tab: ap[1], rows });
        tabs[ap[1]].push(...rows);
        return Response.json({});
      }
      const get = path.match(/\/values\/'(.+)'!(.+)$/);
      if (get && method === 'GET') {
        if (!tabs[get[1]]) return new Response('Unable to parse range', { status: 400 });
        return Response.json({ values: tabs[get[1]] });
      }
      return Response.json({ sheets: Object.keys(tabs).map((title, i) => ({ properties: { title, sheetId: i } })) });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  return calls;
}

const KEY = 'signing-key';
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', KEY).update(body).digest('base64url')}`;
};
function post(fields, { origin = SITE, ip = '203.0.113.9' } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers = { 'cf-connecting-ip': ip };
  if (origin) headers.origin = origin;
  return new Request('https://approvals.example.workers.dev/r', { method: 'POST', body: form, headers });
}
const good = (extra = {}) => ({ email: ' Reader@Example.org ', kind: 'trades', entry: 'b-tomes-son', website: '', js: '1', 'cf-turnstile-response': 'good-token', ...extra });

test.beforeEach(() => { resetMemoryLimit(); resetTokenCache(); });

test('listedEntry knows both pages and nothing else', () => {
  assert.equal(listedEntry('trades', 'b-tomes-son').name, 'B Tomes & Son');
  assert.equal(listedEntry('eat', 'the-anchor-inn').page, '/living-here/eat/');
  assert.equal(listedEntry('trades', 'the-anchor-inn'), null);
  assert.equal(listedEntry('constructor', 'x'), null);
  assert.equal(listedEntry('eat', '../x'), null);
});

test('emailKey matches the script\'s (scripts/recommend emailKey)', async () => {
  const want = createHash('sha256').update('lenches-recommend|reader@example.org').digest('hex').slice(0, 24);
  assert.equal(await emailKey(' Reader@Example.org'), want);
});

test('a good recommendation creates the tab, appends one row and dispatches the id only', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  const res = await handleRecommend(post(good()), env());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j, { ok: true, message: RECOMMEND_THANKS });
  assert.deepEqual(calls.added, ['Recommendations']);
  assert.deepEqual(tabs.Recommendations[0], RECOMMEND_HEADERS);
  const row = Object.fromEntries(RECOMMEND_HEADERS.map((h, i) => [h, tabs.Recommendations[1][i]]));
  assert.match(row.id, /^rc-\d{8}-[a-z0-9]{6}$/);
  assert.equal(row.kind, 'trades');
  assert.equal(row.entry, 'b-tomes-son');
  assert.equal(row.email, 'reader@example.org');
  assert.equal(row.key, await emailKey('reader@example.org'));
  assert.equal(row.status, 'new');
  assert.deepEqual(calls.dispatches, [{ event_type: 'recommend', client_payload: { action: 'send', id: row.id } }]);
});

test('same address and entry twice in a day: same answer, nothing more; another entry is fine', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  await handleRecommend(post(good()), env());
  const again = await handleRecommend(post(good({ email: 'reader@example.org' }), { ip: '198.51.100.1' }), env());
  assert.equal((await again.json()).message, RECOMMEND_THANKS);
  assert.equal(tabs.Recommendations.length, 2);
  await handleRecommend(post(good({ kind: 'eat', entry: 'the-anchor-inn' }), { ip: '198.51.100.2' }), env());
  assert.equal(tabs.Recommendations.length, 3);
  assert.equal(calls.dispatches.length, 2);
});

test('an unlisted entry, honeypot, bad Turnstile and other origin write nothing', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  const bad = await handleRecommend(post(good({ entry: 'nobody' })), env());
  assert.equal(bad.status, 400);
  assert.equal((await handleRecommend(post(good({ website: 'x' })), env())).status, 200);
  assert.equal((await handleRecommend(post(good({ 'cf-turnstile-response': 'bad' })), env())).status, 403);
  assert.equal((await handleRecommend(post(good(), { origin: 'https://evil.example' }), env())).status, 403);
  assert.equal(calls.appends.length, 0);
  assert.equal(calls.dispatches.length, 0);
});

test('its own rate limiter binding is used', async () => {
  fakeWorld({});
  const res = await handleRecommend(post(good()), env({ RECOMMEND_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429);
});

test('confirm link: GET names the entry and dispatches nothing; POST dispatches confirm', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const t = sign({ a: 'rec', i: 'rc-20261103-abc123', k: 'eat', n: 'the-anchor-inn', e: Math.floor(Date.now() / 1000) + 3600 });
  const get = await worker.fetch(new Request(`https://w.example/r?t=${t}`), e);
  const html = await get.text();
  assert.match(html, /Recommend The Anchor Inn\?/);
  assert.match(html, /Yes, count my recommendation/);
  assert.equal(calls.dispatches.length, 0);
  const done = await worker.fetch(new Request(`https://w.example/r?t=${t}`, { method: 'POST' }), e);
  assert.match(await done.text(), /Your recommendation is counted/);
  assert.deepEqual(calls.dispatches, [{ event_type: 'recommend', client_payload: { action: 'confirm', id: 'rc-20261103-abc123' } }]);
});

test('expired and foreign tokens are refused; /a and /s refuse recommendation tokens', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const old = sign({ a: 'rec', i: 'rc-20261103-abc123', k: 'eat', n: 'the-anchor-inn', e: 1 });
  assert.equal((await worker.fetch(new Request(`https://w.example/r?t=${old}`), e)).status, 410);
  const su = sign({ a: 'signup', i: 'su-20261027-abc123', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.doesNotMatch(await (await worker.fetch(new Request(`https://w.example/r?t=${su}`), e)).text(), /count my/);
  const rec = sign({ a: 'rec', i: 'rc-20261103-abc123', k: 'eat', n: 'the-anchor-inn', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.doesNotMatch(await (await worker.fetch(new Request(`https://w.example/a?t=${rec}`), e)).text(), /count my/);
  const form = new FormData(); form.append('t', rec);
  await worker.fetch(new Request('https://w.example/a', { method: 'POST', body: form }), e);
  assert.doesNotMatch(await (await worker.fetch(new Request(`https://w.example/s?t=${rec}`), e)).text(), /add me/);
  assert.equal(calls.dispatches.length, 0);
});

test('one address can recommend up to 25 entries a day; the 26th is quietly not saved', async () => {
  const tabs = {};
  fakeWorld(tabs);
  const { LISTINGS } = await import('../src/recommend.js');
  const all = [...LISTINGS.trades.entries.map((e) => ['trades', e.id]), ...LISTINGS.eat.entries.map((e) => ['eat', e.id])];
  assert.ok(all.length > 26);
  for (const [kind, entry] of all.slice(0, 26)) {
    resetMemoryLimit();
    await handleRecommend(post(good({ kind, entry })), env());
  }
  assert.equal(tabs.Recommendations.length, 26, 'header + 25 rows');
});
