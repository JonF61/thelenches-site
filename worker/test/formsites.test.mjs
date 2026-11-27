// worker/test/formsites.test.mjs
// Harvington stage 7 (16 Nov 2026): the public forms (/s sign-up, /f Suggest an update,
// /r Recommend, /sg Suggest a listing) and their signed links work for the site they came
// from: the Origin (or Referer) picks the site, which picks its Sheet, wording, listed
// entries and the dispatch's site; anything else is the Lenches, as before. Google,
// Turnstile and GitHub are mocked; nothing leaves the machine.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import worker from '../src/index.js';
import { siteFromRequest, siteWords, publicEnv, ownDomains } from '../src/sites.js';
import { listedEntry } from '../src/recommend.js';
import { validateSignup } from '../src/signup.js';
import { resetMemoryLimit } from '../src/feedback.js';
import { resetTokenCache } from '../src/admin/google.js';
import harvington from '../../sites/harvington/_data/site.json' with { type: 'json' };

const LENCHES = 'https://thelenches.org.uk';
const HARV = 'https://harvingtonvillage.org.uk';
const KEY = 'signing-key';

const saKey = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const saPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const env = () => ({
  SITE_URL: `${LENCHES}/`, SHEET_ID: 'lenches-sheet', REPO: 'owner/repo', DISPATCH_TOKEN: 'gh',
  TURNSTILE_SECRET: 'ts', APPROVAL_SIGNING_KEY: KEY,
  GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: saPem }),
});

// A fake world of Sheets keyed by spreadsheet id: { sheetId: { tab: rows } }.
function fakeWorld() {
  const books = {};
  const calls = { appends: [], dispatches: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'goog', expires_in: 3600 });
    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: true });
    if (url.hostname === 'api.github.com') {
      calls.dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      const path = decodeURIComponent(url.pathname);
      const id = path.split('/')[3].split(':')[0];
      const tabs = (books[id] = books[id] || {});
      if (path.endsWith(':batchUpdate') && !path.endsWith('values:batchUpdate')) {
        tabs[JSON.parse(init.body).requests[0].addSheet.properties.title] = [];
        return Response.json({});
      }
      if (path.endsWith('values:batchUpdate')) {
        for (const d of JSON.parse(init.body).data) {
          const [, tab, , row] = d.range.match(/^'(.+)'!([A-Z]+)(\d+)$/);
          d.values.forEach((vals, i) => { tabs[tab][Number(row) - 1 + i] = vals; });
        }
        return Response.json({});
      }
      const ap = path.match(/\/values\/'(.+)'!A1:append$/);
      if (ap && method === 'POST') {
        const rows = JSON.parse(init.body).values;
        calls.appends.push({ sheet: id, tab: ap[1], rows });
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

function post(route, fields, origin) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ website: '', js: '1', 'cf-turnstile-response': 'ok', ...fields })) form.append(k, v);
  const headers = { 'cf-connecting-ip': '203.0.113.7' };
  if (origin) headers.origin = origin;
  return new Request(`https://w.example${route}`, { method: 'POST', body: form, headers });
}
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', KEY).update(body).digest('base64url')}`;
};
const soon = () => Math.floor(Date.now() / 1000) + 3600;

test.beforeEach(() => { resetMemoryLimit(); resetTokenCache(); });

test('the site comes from Origin, then Referer; anything else is the Lenches', () => {
  const req = (h) => new Request('https://w.example/s', { method: 'POST', headers: h });
  assert.equal(siteFromRequest(req({ origin: HARV })), 'harvington');
  assert.equal(siteFromRequest(req({ referer: `${HARV}/newsletter/` })), 'harvington');
  assert.equal(siteFromRequest(req({ origin: LENCHES })), 'lenches');
  assert.equal(siteFromRequest(req({ origin: 'https://evil.example' })), 'lenches');
  assert.equal(siteFromRequest(req({})), 'lenches');
  const e = env();
  assert.equal(publicEnv(e, 'lenches'), e, 'the Lenches keeps the real env');
  assert.equal(publicEnv(e, 'nowhere'), e);
  assert.equal(publicEnv(e, 'harvington').SHEET_ID, harvington.sheetId);
});

test('each site\'s own wording', () => {
  assert.deepEqual(siteWords(env()), {
    website: 'the Lenches website', email: 'website@thelenches.org.uk', domain: 'thelenches.org.uk', newsletter: 'The Lenches Newsletter',
  });
  assert.equal(siteWords(publicEnv(env(), 'harvington')).website, 'the Harvington website');
  assert.deepEqual(ownDomains(), ['thelenches.org.uk', 'harvingtonvillage.org.uk']);
  assert.equal(validateSignup({ email: 'x@harvingtonvillage.org.uk' }).ok, false);
});

test('Recommend accepts only the posting site\'s entries', () => {
  assert.equal(listedEntry('trades', 'will-begg-carpentry-services', 'harvington').name, 'Will Begg Carpentry Services');
  assert.equal(listedEntry('trades', 'will-begg-carpentry-services'), null);
  assert.equal(listedEntry('trades', 'cannins', 'harvington'), null);
  assert.equal(listedEntry('trades', 'b-tomes-son').name, 'B Tomes & Son');
});

test('a Harvington sign-up goes to its Sheet and its run; a Lenches one is unchanged', async () => {
  const calls = fakeWorld();
  let res = await worker.fetch(post('/s', { email: 'reader@example.org' }, HARV), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), HARV);
  assert.equal(calls.appends[0].sheet, harvington.sheetId);
  assert.equal(calls.appends[0].tab, 'Sign-ups');
  assert.equal(calls.dispatches[0].client_payload.site, 'harvington');

  res = await worker.fetch(post('/s', { email: 'reader2@example.org' }, LENCHES), env());
  assert.equal(res.status, 200);
  assert.equal(calls.appends[1].sheet, 'lenches-sheet');
  assert.equal(calls.dispatches[1].client_payload.site, undefined);

  res = await worker.fetch(post('/s', { email: 'reader3@example.org' }, 'https://evil.example'), env());
  assert.equal(res.status, 403);
  assert.match(await res.text(), /only works on the Lenches website/);
});

test('Recommend from Harvington: its entry is saved in its Sheet; a Lenches entry is refused', async () => {
  const calls = fakeWorld();
  let res = await worker.fetch(post('/r', { email: 'r@example.org', kind: 'trades', entry: 'will-begg-carpentry-services' }, HARV), env());
  assert.equal(res.status, 200);
  assert.equal(calls.appends[0].sheet, harvington.sheetId);
  assert.equal(calls.dispatches[0].client_payload.site, 'harvington');
  res = await worker.fetch(post('/r', { email: 'r@example.org', kind: 'trades', entry: 'cannins' }, HARV), env());
  assert.equal((await res.json()).ok, false);
  assert.equal(calls.appends.length, 1);
});

test('Suggest a listing and Suggest an update from Harvington use its Sheet', async () => {
  const calls = fakeWorld();
  let res = await worker.fetch(post('/sg', {
    kind: 'trades', name: 'A Builder', trade: 'Builders', contact: '01386 000000', area: 'Harvington', why: '', email: 's@example.org',
  }, HARV), env());
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.appends[0].sheet, harvington.sheetId);
  assert.equal(calls.dispatches[0].client_payload.site, 'harvington');

  res = await worker.fetch(post('/f', {
    type: 'correction', message: 'The hall phone number has changed.', email: '', page_url: `${HARV}/events/`, page_title: 'Events',
  }, HARV), env());
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.appends[1].sheet, harvington.sheetId);
  assert.equal(calls.appends[1].tab, 'Feedback');
});

test('signed links carry their site: Harvington wording, page and run', async () => {
  const calls = fakeWorld();
  const t = sign({ a: 'signup', i: 'su-1', e: soon(), s: 'harvington' });
  let res = await worker.fetch(new Request(`https://w.example/s?t=${t}`), env());
  assert.match(await res.text(), /Join The Harvington Newsletter\?/);
  res = await worker.fetch(new Request(`https://w.example/s?t=${t}`, { method: 'POST' }), env());
  assert.match(await res.text(), new RegExp(HARV));
  assert.deepEqual(calls.dispatches[0], { event_type: 'signup', client_payload: { action: 'confirm', id: 'su-1', site: 'harvington' } });

  const r = sign({ a: 'rec', i: 'rc-1', k: 'trades', n: 'will-begg-carpentry-services', e: soon(), s: 'harvington' });
  res = await worker.fetch(new Request(`https://w.example/r?t=${r}`), env());
  const html = await res.text();
  assert.match(html, /Recommend Will Begg Carpentry Services\?/);
  assert.match(html, /harvingtonvillage\.org\.uk/);

  const g = sign({ a: 'sug', i: 'sg-1', k: 'eat', e: soon(), s: 'harvington' });
  res = await worker.fetch(new Request(`https://w.example/sg?t=${g}`), env());
  assert.match(await res.text(), /page of harvingtonvillage\.org\.uk/);

  const old = sign({ a: 'signup', i: 'su-2', e: soon() });
  res = await worker.fetch(new Request(`https://w.example/s?t=${old}`), env());
  assert.match(await res.text(), /Join The Lenches Newsletter\?/, 'a Lenches link (no s) is unchanged');
});

test('a form posted from a site\'s www address works (Safari showed "Load failed", 22 Nov)', async () => {
  const req = (h) => new Request('https://w.example/s', { method: 'POST', headers: h });
  assert.equal(siteFromRequest(req({ origin: 'https://www.harvingtonvillage.org.uk' })), 'harvington');
  const calls = fakeWorld();
  for (const [origin, sheet] of [['https://www.harvingtonvillage.org.uk', harvington.sheetId], ['https://www.thelenches.org.uk', 'lenches-sheet']]) {
    const pre = await worker.fetch(new Request('https://w.example/s', { method: 'OPTIONS', headers: { origin } }), env());
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    const res = await worker.fetch(post('/s', { email: `www${calls.appends.length}@example.org` }, origin), env());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(calls.appends.at(-1).sheet, sheet);
  }
  const res = await worker.fetch(post('/s', { email: 'x@example.org' }, 'https://www.evil.example'), env());
  assert.equal(res.status, 403);
});

test('the Facebook app\'s http:// origin is that site (27 Nov: 11 Harvington sign-ups refused as the Lenches\')', async () => {
  const req = (h) => new Request('https://w.example/s', { method: 'POST', headers: h });
  assert.equal(siteFromRequest(req({ origin: 'http://harvingtonvillage.org.uk' })), 'harvington');
  assert.equal(siteFromRequest(req({ origin: 'http://www.thelenches.org.uk' })), 'lenches');
  assert.equal(siteFromRequest(req({ origin: 'ftp://harvingtonvillage.org.uk' })), 'lenches');
  const calls = fakeWorld();
  for (const [origin, sheet] of [['http://harvingtonvillage.org.uk', harvington.sheetId], ['http://thelenches.org.uk', 'lenches-sheet']]) {
    const res = await worker.fetch(post('/s', { email: `http${calls.appends.length}@example.org` }, origin), env());
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(calls.appends.at(-1).sheet, sheet);
  }
  for (const bad of ['http://harvingtonvillage.org.uk:8080', 'http://evil.example', 'http://harvingtonvillage.org.uk.evil.example']) {
    const res = await worker.fetch(post('/s', { email: 'x@example.org' }, bad), env());
    assert.equal(res.status, 403, bad);
  }
});

// 27 Nov 2026: the Facebook app's browser sends an Origin that is neither site (e.g. "null"),
// and every sign-up from it was refused. Turnstile's answer names the host the check was
// solved on, which then picks the site; a failed check or another host is still refused.
function withTurnstile(calls, answer) {
  const inner = globalThis.fetch;
  calls.verifies = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      calls.verifies += 1;
      return Response.json(answer);
    }
    return inner(input, init);
  };
}

test('Facebook app ("null" origin): Turnstile\'s hostname picks the site, checked once', async () => {
  const calls = fakeWorld();
  withTurnstile(calls, { success: true, hostname: 'harvingtonvillage.org.uk' });
  let res = await worker.fetch(post('/s', { email: 'fb@example.org' }, 'null'), env());
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('access-control-allow-origin'), 'null', 'the browser can read the reply');
  assert.equal(calls.verifies, 1, 'a Turnstile token is used once');
  assert.equal(calls.appends[0].sheet, harvington.sheetId);
  assert.equal(calls.dispatches[0].client_payload.site, 'harvington');

  res = await worker.fetch(post('/f', {
    type: 'correction', message: 'The hall phone number has changed.', email: '', page_url: `${HARV}/events/`, page_title: 'Events',
  }, 'null'), env());
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.appends.at(-1).tab, 'Feedback');
  assert.equal(calls.appends.at(-1).sheet, harvington.sheetId);

  res = await worker.fetch(post('/sg', {
    kind: 'trades', name: 'A Builder', trade: 'Builders', contact: '01386 000000', area: 'Harvington', why: '', email: 's@example.org',
  }, 'null'), env());
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.appends.at(-1).sheet, harvington.sheetId);

  withTurnstile(calls, { success: true, hostname: 'www.thelenches.org.uk' });
  res = await worker.fetch(post('/s', { email: 'fb2@example.org' }, 'null'), env());
  assert.equal(res.status, 200);
  assert.equal(calls.appends.at(-1).sheet, 'lenches-sheet');
});

test('an unknown origin is still refused when Turnstile fails or names another host, and the origin is recorded', async () => {
  for (const answer of [{ success: false }, { success: true, hostname: 'evil.example' }]) {
    const calls = fakeWorld();
    withTurnstile(calls, answer);
    const res = await worker.fetch(post('/s', { email: 'x@example.org' }, 'null'), env());
    assert.equal(res.status, 403);
    const su = calls.appends.filter((a) => a.tab === 'Sign-ups');
    assert.equal(su.length, 1, 'one row, for Jon\'s review only');
    assert.equal(su[0].rows[0][3], 'review');
    const fail = calls.appends.find((a) => a.tab === 'Form failures');
    assert.equal(fail.rows[0][4], 'origin');
    assert.equal(fail.rows[0][6], 'null', 'the sent origin is recorded');
  }
  const calls = fakeWorld();
  withTurnstile(calls, { success: true, hostname: 'harvingtonvillage.org.uk' });
  const res = await worker.fetch(post('/s', { email: 'x@example.org', 'cf-turnstile-response': '' }, 'https://evil.example'), env());
  assert.equal(res.status, 403, 'no token: refused without asking Turnstile');
  assert.equal(calls.verifies, 0);
  assert.equal(calls.appends.find((a) => a.tab === 'Form failures').rows[0][6], 'https://evil.example');
});
