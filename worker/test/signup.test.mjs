// worker/test/signup.test.mjs
// Offline tests for the newsletter sign-up form (POST /s) and its confirmation link
// (GET/POST /s?t=): validation, honeypot, Turnstile, rate limit, the Sign-ups tab being
// created and appended to, one email per address per day, the dispatches (row id only,
// never an address), the confirm button, and /a refusing sign-up tokens.
// Google, Turnstile and GitHub are mocked; nothing leaves the machine.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { handleSignup, validateSignup, SIGNUP_HEADERS, SIGNUP_THANKS } from '../src/signup.js';
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
  return new Request('https://approvals.example.workers.dev/s', { method: 'POST', body: form, headers });
}
const good = (extra = {}) => ({ email: ' Reader@Example.org ', website: '', js: '1', 'cf-turnstile-response': 'good-token', ...extra });

test.beforeEach(() => { resetMemoryLimit(); resetTokenCache(); });

test('validateSignup', () => {
  assert.deepEqual(validateSignup({ email: ' A@Example.org ' }), { ok: true, email: 'a@example.org' });
  assert.match(validateSignup({ email: '' }).error, /enter your email/);
  assert.match(validateSignup({ email: 'nope' }).error, /doesn't look right/);
  assert.match(validateSignup({ email: 'a@b.com, c@d.com' }).error, /doesn't look right/);
  assert.match(validateSignup({ email: 'website@thelenches.org.uk' }).error, /your own/);
});

test('a good sign-up creates the tab, appends one row and dispatches the id only', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  const res = await handleSignup(post(good()), env());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.message, SIGNUP_THANKS);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.deepEqual(calls.added, ['Sign-ups']);
  assert.deepEqual(tabs['Sign-ups'][0], SIGNUP_HEADERS);
  const row = tabs['Sign-ups'][1];
  assert.match(row[0], /^su-\d{8}-[a-z0-9]{6}$/);
  assert.equal(row[2], 'reader@example.org');
  assert.equal(row[3], 'new');
  assert.equal(calls.dispatches.length, 1);
  assert.deepEqual(calls.dispatches[0], { event_type: 'signup', client_payload: { action: 'send', id: row[0] } });
  assert.ok(!JSON.stringify(calls.dispatches).includes('@'), 'no address in the dispatch');
});

test('the same address twice in a day: same answer, no second row or email', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  await handleSignup(post(good()), env());
  const again = await handleSignup(post(good({ email: 'reader@example.org' }), { ip: '198.51.100.1' }), env());
  assert.equal((await again.json()).message, SIGNUP_THANKS);
  assert.equal(tabs['Sign-ups'].length, 2);
  assert.equal(calls.dispatches.length, 1);
});

test('a failed dispatch marks the row failed, and a retry the same day is allowed', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input).includes('api.github.com') ? new Response('no', { status: 500 }) : realFetch(input, init));
  const res = await handleSignup(post(good()), env());
  assert.equal(res.status, 502);
  assert.equal(tabs['Sign-ups'][1][3], 'failed');
  globalThis.fetch = realFetch;
  const retry = await handleSignup(post(good()), env());
  assert.equal(retry.status, 200);
  assert.equal(tabs['Sign-ups'].length, 3);
  assert.equal(calls.dispatches.length, 1);
});

test('honeypot, bad Turnstile, other origin and rate limit write nothing', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  const hp = await handleSignup(post(good({ website: 'spam' })), env());
  assert.equal((await hp.json()).ok, true);
  const ts = await handleSignup(post(good({ 'cf-turnstile-response': 'bad' })), env());
  assert.equal(ts.status, 403);
  const other = await handleSignup(post(good(), { origin: 'https://evil.example' }), env());
  assert.equal(other.status, 403);
  const noJs = await handleSignup(post(good({ js: '', 'cf-turnstile-response': '' })), env());
  assert.match(await noJs.text(), /JavaScript/);
  assert.equal(calls.appends.length, 0);
  assert.equal(calls.dispatches.length, 0);
  resetMemoryLimit();
  for (let n = 0; n < 5; n += 1) await handleSignup(post(good({ email: `p${n}@example.org` }), { ip: '192.0.2.7' }), env());
  const limited = await handleSignup(post(good({ email: 'p9@example.org' }), { ip: '192.0.2.7' }), env());
  assert.equal(limited.status, 429);
});

test('the binding limiter is used when present', async () => {
  fakeWorld({});
  const res = await handleSignup(post(good()), env({ SIGNUP_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429);
});

test('confirm link: GET shows a button and dispatches nothing; POST dispatches confirm', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const t = sign({ a: 'signup', i: 'su-20261027-abc123', e: Math.floor(Date.now() / 1000) + 3600 });
  const get = await worker.fetch(new Request(`https://w.example/s?t=${t}`), e);
  assert.equal(get.status, 200);
  const html = await get.text();
  assert.match(html, /Yes, add me to the list/);
  assert.match(html, /method="post"/);
  assert.equal(calls.dispatches.length, 0);
  const done = await worker.fetch(new Request(`https://w.example/s?t=${t}`, { method: 'POST' }), e);
  assert.match(await done.text(), /You're on the list/);
  assert.deepEqual(calls.dispatches, [{ event_type: 'signup', client_payload: { action: 'confirm', id: 'su-20261027-abc123' } }]);
});

test('confirm link: expired, wrong action and forged tokens do nothing', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const old = sign({ a: 'signup', i: 'su-20261027-abc123', e: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await worker.fetch(new Request(`https://w.example/s?t=${old}`, { method: 'POST' }), e)).status, 410);
  const unsub = sign({ a: 'unsub', i: 'abcdefghijklmnopqrstuv', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await worker.fetch(new Request(`https://w.example/s?t=${unsub}`, { method: 'POST' }), e)).status, 400);
  const forged = `${old.split('.')[0]}.AAAA`;
  assert.equal((await worker.fetch(new Request(`https://w.example/s?t=${forged}`, { method: 'POST' }), e)).status, 400);
  assert.equal(calls.dispatches.length, 0);
});

test('/a refuses a sign-up token', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const t = sign({ a: 'signup', i: 'su-20261027-abc123', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await worker.fetch(new Request(`https://w.example/a?t=${t}`), e)).status, 400);
  const form = new FormData();
  form.append('t', t);
  assert.equal((await worker.fetch(new Request('https://w.example/a', { method: 'POST', body: form }), e)).status, 400);
  assert.equal(calls.dispatches.length, 0);
});

test('GET /s without a token is a plain page', async () => {
  const res = await worker.fetch(new Request('https://w.example/s'), env());
  assert.equal(res.status, 405);
});
