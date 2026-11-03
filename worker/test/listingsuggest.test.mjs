// worker/test/listingsuggest.test.mjs
// Offline tests for Suggest a tradesperson / somewhere to eat (part 2 of Suggest/Recommend):
// POST /sg (validation, honeypot, Turnstile, its own rate limiter, the Listing suggestions tab
// being created and appended to, one request per address per day, the dispatch carrying the row
// id only), the confirm link (GET shows a button, POST dispatches confirm; /a and /r refuse it),
// the shared rules in admin/suggestions.mjs (the draft entry, Jon's edits checked, "already
// listed?", where the entry goes) and the panel's Approve / Edit / Reject -> decide() payloads
// (panel only, to listing-suggest.yml). Google, Turnstile and GitHub are mocked.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { handleSuggest, validateSuggestion, SUGGEST_THANKS, PER_EMAIL_DAY } from '../src/listingsuggest.js';
import {
  SUGGEST_HEADERS, SUGGEST_TAB, draftEntry, cleanEntry, contactFields, areaFor, similarNames, insertEntry, planSuggestion, panelRows, slug,
} from '../src/admin/suggestions.mjs';
import { dispatchFor, validPayload, PANEL_ONLY } from '../src/core.js';
import { resetMemoryLimit } from '../src/feedback.js';
import { resetTokenCache } from '../src/admin/google.js';
import worker from '../src/index.js';
import tradesData from '../../src/_data/trades.json' with { type: 'json' };
import eatData from '../../src/_data/eat.json' with { type: 'json' };
import { createRequire } from 'node:module';

const { listingId } = createRequire(import.meta.url)('../../lib/listings.js');
const DATA = { trades: tradesData, eat: eatData };

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
  return new Request('https://approvals.example.workers.dev/sg', { method: 'POST', body: form, headers });
}
const good = (extra = {}) => ({ email: ' Reader@Example.org ', kind: 'trades', name: 'Smith Electrical', trade: 'electricians', contact: '07700 900123', area: 'Rous Lench', why: 'Rewired our cottage.\nTidy and on time.', website: '', js: '1', 'cf-turnstile-response': 'good-token', ...extra });

test.beforeEach(() => { resetMemoryLimit(); resetTokenCache(); });

const rowOf = (tabs) => Object.fromEntries(SUGGEST_HEADERS.map((h, i) => [h, tabs[SUGGEST_TAB][1][i]]));

test('a good suggestion creates the tab, appends one row and dispatches the id only', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  const res = await handleSuggest(post(good()), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: SUGGEST_THANKS });
  assert.deepEqual(calls.added, [SUGGEST_TAB]);
  assert.deepEqual(tabs[SUGGEST_TAB][0], SUGGEST_HEADERS);
  const row = rowOf(tabs);
  assert.match(row.id, /^sg-\d{8}-[a-z0-9]{6}$/);
  assert.deepEqual([row.kind, row.name, row.trade, row.contact, row.area, row.email, row.status], ['trades', 'Smith Electrical', 'electricians', '07700 900123', 'Rous Lench', 'reader@example.org', 'new']);
  assert.equal(row.why, 'Rewired our cottage.\nTidy and on time.');
  assert.match(row.key, /^[0-9a-f]{24}$/);
  assert.deepEqual(calls.dispatches, [{ event_type: 'listing-suggest', client_payload: { action: 'send', id: row.id } }]);
  assert.ok(!JSON.stringify(calls.dispatches).includes('example.org'));
});

test('up to 10 a day per address, then a "try again tomorrow" message', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  for (let n = 1; n <= 10; n += 1) {
    resetMemoryLimit();
    const r = await handleSuggest(post(good({ name: `Place ${n}`, email: n % 2 ? 'reader@example.org' : 'READER@example.org' })), env());
    assert.equal((await r.json()).message, SUGGEST_THANKS);
  }
  assert.equal(tabs[SUGGEST_TAB].length, 11);
  resetMemoryLimit();
  const over = await handleSuggest(post(good({ name: 'Place 11' })), env());
  assert.equal(over.status, 429);
  assert.match((await over.json()).message, /You've sent 10 suggestions today.*try again tomorrow/);
  assert.equal(tabs[SUGGEST_TAB].length, 11);
  await handleSuggest(post(good({ email: 'other@example.org', kind: 'eat', trade: 'pub' })), env());
  assert.equal(tabs[SUGGEST_TAB].length, 12, 'another address is fine');
  assert.equal(calls.dispatches.length, 11);
  assert.equal(PER_EMAIL_DAY, 10);
});

test('missing fields, honeypot, bad Turnstile and other origin write nothing', async () => {
  const tabs = {};
  const calls = fakeWorld(tabs);
  for (const [extra, msg] of [[{ name: '' }, /their name/], [{ trade: '' }, /their trade/], [{ kind: 'eat', trade: '' }, /type of place/],
    [{ contact: '' }, /phone number or website/], [{ email: 'nope' }, /doesn't look right/], [{ kind: 'shops' }, /reload/],
    [{ why: 'x'.repeat(1001) }, /too long/]]) {
    const r = await handleSuggest(post(good(extra), { ip: `198.51.100.${Math.floor(Math.random() * 200)}` }), env());
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, msg);
  }
  resetMemoryLimit();
  assert.equal((await handleSuggest(post(good({ website: 'x' })), env())).status, 200);
  assert.equal((await handleSuggest(post(good({ 'cf-turnstile-response': 'bad' })), env())).status, 403);
  assert.equal((await handleSuggest(post(good(), { origin: 'https://evil.example' }), env())).status, 403);
  assert.equal(calls.appends.length, 0);
  assert.equal(calls.dispatches.length, 0);
});

test('its own rate limiter binding is used', async () => {
  fakeWorld({});
  const res = await handleSuggest(post(good()), env({ SUGGEST_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429);
});

test('validateSuggestion trims and keeps why\'s line breaks', () => {
  const v = validateSuggestion(good({ name: '  Smith \n Electrical ' }));
  assert.equal(v.value.name, 'Smith Electrical');
  assert.equal(v.value.email, 'reader@example.org');
});

test('confirm link: GET shows the button and dispatches nothing; POST dispatches confirm', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const t = sign({ a: 'sug', i: 'sg-20261103-abc123', k: 'eat', e: Math.floor(Date.now() / 1000) + 3600 });
  const html = await (await worker.fetch(new Request(`https://w.example/sg?t=${t}`), e)).text();
  assert.match(html, /Yes, send my suggestion/);
  assert.match(html, /Where to eat/);
  assert.equal(calls.dispatches.length, 0);
  const done = await worker.fetch(new Request(`https://w.example/sg?t=${t}`, { method: 'POST' }), e);
  assert.match(await done.text(), /Thank you, we'll take a look at your suggestion\./);
  assert.deepEqual(calls.dispatches, [{ event_type: 'listing-suggest', client_payload: { action: 'confirm', id: 'sg-20261103-abc123' } }]);
});

test('expired and foreign tokens are refused; /a and /r refuse suggestion tokens', async () => {
  const calls = fakeWorld({});
  const e = env({ APPROVAL_SIGNING_KEY: KEY });
  const old = sign({ a: 'sug', i: 'sg-20261103-abc123', k: 'trades', e: 1 });
  assert.equal((await worker.fetch(new Request(`https://w.example/sg?t=${old}`), e)).status, 410);
  const rec = sign({ a: 'rec', i: 'rc-20261103-abc123', k: 'eat', n: 'the-anchor-inn', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.doesNotMatch(await (await worker.fetch(new Request(`https://w.example/sg?t=${rec}`), e)).text(), /send my suggestion/);
  const sug = sign({ a: 'sug', i: 'sg-20261103-abc123', k: 'eat', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.doesNotMatch(await (await worker.fetch(new Request(`https://w.example/a?t=${sug}`), e)).text(), /Send suggestion/);
  const form = new FormData(); form.append('t', sug);
  await worker.fetch(new Request('https://w.example/a', { method: 'POST', body: form }), e);
  assert.doesNotMatch(await (await worker.fetch(new Request(`https://w.example/r?t=${sug}`), e)).text(), /count my/);
  // Jon's decisions are panel only: a signed email link can't carry them.
  const ok = sign({ a: 'sug_ok', i: 'sg-20261103-abc123', e: Math.floor(Date.now() / 1000) + 3600 });
  assert.match(await (await worker.fetch(new Request(`https://w.example/a?t=${ok}`), e)).text(), /Invalid link/);
  assert.equal(calls.dispatches.length, 0);
});

test('slug matches lib/listings.js listingId', () => {
  for (const n of ['B Tomes & Son', 'Café Rouge', '  The Anchor Inn!  ', 'Ab Lench Plumbing & Heating Ltd']) assert.equal(slug(n), listingId(n));
});

test('contactFields sorts the one box into phone, website, email or other', () => {
  assert.deepEqual(contactFields('07700 900123'), { phone: '07700 900123' });
  assert.deepEqual(contactFields('+44 1386 793248'), { phone: '+44 1386 793248' });
  assert.deepEqual(contactFields('www.smith-electrical.co.uk/'), { website: { text: 'smith-electrical.co.uk', url: 'https://www.smith-electrical.co.uk/' } });
  assert.deepEqual(contactFields('http://example.com/menu'), { website: { text: 'example.com/menu', url: 'http://example.com/menu' } });
  assert.deepEqual(contactFields('Bob@Example.org'), { email: 'bob@example.org' });
  assert.deepEqual(contactFields('Ring the pub'), { other: 'Ring the pub' });
  assert.deepEqual(contactFields(''), {});
});

test('areaFor maps a village to one of the Where to eat areas', () => {
  const areas = eatData.areas;
  assert.equal(areaFor('evesham', areas), 'Evesham');
  assert.equal(areaFor('Norton, near Evesham', areas), 'Harvington and Norton');
  assert.equal(areaFor('Pershore', areas), 'Pershore');
  assert.equal(areaFor('Bishampton', areas), 'Nearby villages');
  assert.equal(areaFor('', areas), 'Nearby villages');
});

test('draftEntry: an existing trade section is reused; eat gets an area and type', () => {
  const t = draftEntry('trades', { name: 'Smith Electrical', trade: 'chimney sweeps', contact: '07700 900123', area: 'Rous Lench' }, DATA);
  assert.deepEqual(t, { name: 'Smith Electrical', trade: 'Chimney sweeps', base: 'Rous Lench', phone: '07700 900123' });
  const n = draftEntry('trades', { name: 'X', trade: 'tree surgeons', contact: 'x.com', area: '' }, DATA);
  assert.deepEqual(n, { name: 'X', trade: 'Tree surgeons', website: { text: 'x.com', url: 'https://x.com' } });
  const e = draftEntry('eat', { name: 'The Fleece', trade: 'pub', contact: 'thefleece.co.uk', area: 'Bretforton' }, DATA);
  assert.deepEqual(e, { name: 'The Fleece', area: 'Nearby villages', where: 'Bretforton', type: 'Pub', website: { text: 'thefleece.co.uk', url: 'https://thefleece.co.uk' } });
});

test('cleanEntry keeps only known fields, checks required ones and the area', () => {
  const ok = cleanEntry('eat', { name: ' The Fleece ', area: 'Nearby villages', type: 'Pub', garden: true, dogs: 'yes', evil: '<b>', website: { url: 'thefleece.co.uk' } }, DATA);
  assert.deepEqual(ok.entry, { name: 'The Fleece', area: 'Nearby villages', type: 'Pub', website: { text: 'thefleece.co.uk', url: 'https://thefleece.co.uk' }, garden: true });
  assert.match(cleanEntry('eat', { name: 'X', area: 'Mars', type: 'Pub' }, DATA).error, /Area must be one of/);
  assert.match(cleanEntry('eat', { name: 'X', area: 'Evesham' }, DATA).error, /type/);
  assert.match(cleanEntry('trades', { name: 'X', trade: 'Builders' }, DATA).error, /phone, email, website/);
  assert.match(cleanEntry('trades', { name: 'X', trade: 'Builders', website: { url: 'javascript:alert(1)' } }, DATA).error, /https/);
  assert.match(cleanEntry('trades', { name: 'X', trade: 'Builders', email: 'nope' }, DATA).error, /email/);
  assert.deepEqual(cleanEntry('trades', { phone: '1', name: 'X', trade: 'Builders', base: '' }, DATA).entry, { name: 'X', trade: 'Builders', phone: '1' });
});

test('similarNames flags names already listed', () => {
  assert.deepEqual(similarNames('trades', 'B Tomes and Son', DATA), ['B Tomes & Son']);
  assert.deepEqual(similarNames('eat', 'Anchor Inn', DATA), ['The Anchor Inn']);
  assert.deepEqual(similarNames('trades', 'Zebra Zookeeping', DATA), []);
});

test('insertEntry: trades after the last of its trade, eat in name order within its area', () => {
  const sweeps = tradesData.trades.map((t, i) => [t, i]).filter(([t]) => t.trade === 'Chimney sweeps');
  const t = insertEntry('trades', DATA, { id: 'new', name: 'New', trade: 'Chimney sweeps', phone: '1' });
  assert.equal(t.trades.length, tradesData.trades.length + 1);
  assert.equal(t.trades[sweeps.at(-1)[1] + 1].id, 'new');
  assert.equal(t.intro, tradesData.intro);
  const end = insertEntry('trades', DATA, { id: 'z', name: 'Z', trade: 'Zzz', phone: '1' });
  assert.equal(end.trades.at(-1).id, 'z');
  const e = insertEntry('eat', DATA, { id: 'b', name: 'Bell Inn', area: 'Nearby villages', type: 'Pub' });
  const near = e.places.filter((p) => p.area === 'Nearby villages');
  const at = near.findIndex((p) => p.id === 'b');
  assert.ok(at >= 0);
  if (at > 0) assert.ok(near[at - 1].name.localeCompare('Bell Inn', 'en-GB', { sensitivity: 'base' }) < 0);
  if (at < near.length - 1) assert.ok(near[at + 1].name.localeCompare('Bell Inn', 'en-GB', { sensitivity: 'base' }) > 0);
  assert.equal(e.areas, eatData.areas);
  assert.ok(!tradesData.trades.some((x) => x.id === 'new'), 'the bundled data is untouched');
});

const waiting = { _row: 5, id: 'sg-20261103-abc123', kind: 'trades', name: 'Smith Electrical', trade: 'Electricians', contact: '07700 900123', area: 'Rous Lench', why: 'Good', email: 'reader@example.org', key: 'k', status: 'confirmed', confirmed_at: '2026-11-03 14:12' };

test('panelRows: confirmed rows only, never the address or key', () => {
  const out = panelRows({ headers: [], rows: [waiting, { ...waiting, id: 'sg-20261103-zzz999', status: 'sent' }] }, DATA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]._label, 'Local trades');
  assert.deepEqual(out.rows[0]._draft, { name: 'Smith Electrical', trade: 'Electricians', base: 'Rous Lench', phone: '07700 900123' });
  assert.ok(!JSON.stringify(out).includes('example.org'));
  assert.ok(!('key' in out.rows[0]));
});

test('planSuggestion: Approve, Edit and Reject -> decide() payloads for listing-suggest.yml', () => {
  const a = planSuggestion({ action: 'approve', id: waiting.id }, waiting, DATA);
  assert.deepEqual(a.p, { a: 'sug_ok', i: waiting.id });
  assert.deepEqual(dispatchFor(a.p, a.reason, a.body), ['listing-suggest', { action: 'approve', id: waiting.id, body: '' }]);
  const ed = planSuggestion({ action: 'edit', id: waiting.id, fields: { name: 'Smith Electrical Ltd', trade: 'Electricians', phone: '07700 900123', what: 'Rewiring' } }, waiting, DATA);
  assert.ok(validPayload(ed.p));
  assert.deepEqual(JSON.parse(ed.body), { name: 'Smith Electrical Ltd', trade: 'Electricians', what: 'Rewiring', phone: '07700 900123' });
  assert.deepEqual(dispatchFor(ed.p, ed.reason, ed.body)[1].body, ed.body);
  const r = planSuggestion({ action: 'reject', id: waiting.id, reason: ' Not local\n' }, waiting, DATA);
  assert.deepEqual(dispatchFor(r.p, r.reason, r.body), ['listing-suggest', { action: 'reject', id: waiting.id, reason: 'Not local' }]);
  assert.ok(PANEL_ONLY.includes('sug_ok') && PANEL_ONLY.includes('sug_no'));
  assert.equal(planSuggestion({ action: 'approve', id: waiting.id }, { ...waiting, status: 'approved' }, DATA).status, 409);
  assert.equal(planSuggestion({ action: 'approve', id: waiting.id }, null, DATA).status, 404);
  assert.equal(planSuggestion({ action: 'edit', id: waiting.id, fields: { name: 'X' } }, waiting, DATA).status, 400);
  assert.equal(planSuggestion({ action: 'nuke', id: waiting.id }, waiting, DATA).status, 400);
  assert.equal(planSuggestion({ action: 'approve', id: '../x' }, waiting, DATA).status, 400);
});
