// worker/test/feedback.test.mjs
// Offline tests for the reader feedback form (POST /f) and the panel's Feedback actions:
// validation, honeypot, Turnstile failure, rate limit, the Feedback tab being created and
// appended to, decide() routing for every fb_* action, and the stale-checked Add note.
// Google, Turnstile and GitHub are mocked; nothing leaves the machine.
// Run: node --test worker/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleFeedback, validateFeedback, verifyTurnstile, allowed, resetMemoryLimit, FEEDBACK_HEADERS,
} from '../src/feedback.js';
import { feedbackState, feedbackRows, planFeedback, planNote } from '../src/admin/feedback.js';
import { checkedWrite } from '../src/admin/sheet.js';
import { resetTokenCache } from '../src/admin/google.js';
import { dispatchFor, decide, validPayload } from '../src/core.js';
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

function post(fields, { origin = SITE, ip = '203.0.113.9' } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers = { 'cf-connecting-ip': ip };
  if (origin) headers.origin = origin;
  return new Request('https://approvals.example.workers.dev/f', { method: 'POST', body: form, headers });
}

const good = (extra = {}) => ({
  type: 'correction', message: 'The hall phone number is out of date.', email: 'Reader@Example.org',
  page_url: `${SITE}/halls/#top`, page_title: 'Village halls', website: '', js: '1', 'cf-turnstile-response': 'good-token',
  ...extra,
});

test.beforeEach(() => { resetMemoryLimit(); resetTokenCache(); });

/* ----------------------------------------------------------- validation -- */

test('validateFeedback cleans a good submission', () => {
  const v = validateFeedback(good(), SITE);
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, {
    type: 'correction', message: 'The hall phone number is out of date.', email: 'reader@example.org',
    page_url: `${SITE}/halls/`, page_title: 'Village halls',
  });
  assert.equal(validateFeedback(good({ email: '' }), SITE).value.email, '');
});

test('validateFeedback refuses bad fields', () => {
  const bad = (extra) => validateFeedback(good(extra), SITE);
  assert.match(bad({ type: 'spam' }).error, /what kind/);
  assert.match(bad({ message: '  ' }).error, /write your message/);
  assert.match(bad({ message: 'x'.repeat(2001) }).error, /under 2000/);
  assert.match(bad({ email: 'not-an-email' }).error, /email address/);
  assert.match(bad({ email: 'a@b.com, c@d.com' }).error, /email address/);
  assert.match(bad({ page_url: 'https://evil.example/halls/' }).error, /pages of this website/);
  assert.match(bad({ page_url: 'javascript:alert(1)' }).error, /pages of this website/);
  assert.equal(bad({ page_title: 'x'.repeat(500) }).value.page_title.length, 200);
});

/* ------------------------------------------------------------ Turnstile -- */

test('verifyTurnstile: only a confirmed token passes', async () => {
  const calls = fakeWorld({});
  assert.equal(await verifyTurnstile(env(), 'good-token', '1.2.3.4'), true);
  assert.equal(await verifyTurnstile(env(), 'bad-token', '1.2.3.4'), false);
  assert.equal(await verifyTurnstile(env(), '', '1.2.3.4'), false);
  assert.equal(await verifyTurnstile(env({ TURNSTILE_SECRET: '' }), 'good-token', ''), false);
  assert.deepEqual(calls.turnstile[0], { secret: 'ts-secret', response: 'good-token', ip: '1.2.3.4' });
  assert.equal(calls.turnstile.length, 2); // no call without a token or a secret
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal(await verifyTurnstile(env(), 'good-token', ''), false);
});

/* ----------------------------------------------------------- rate limit -- */

test('rate limit: 5 per IP in 10 minutes without the binding, then refused', async () => {
  const t0 = Date.parse('2026-10-25T12:00:00Z');
  for (let i = 0; i < 5; i += 1) assert.equal(await allowed({}, '1.1.1.1', t0 + i), true);
  assert.equal(await allowed({}, '1.1.1.1', t0 + 10), false);
  assert.equal(await allowed({}, '2.2.2.2', t0 + 10), true, 'another IP is not affected');
  assert.equal(await allowed({}, '1.1.1.1', t0 + 11 * 60 * 1000), true, 'allowed again after the window');
});

test('rate limit: the FEEDBACK_LIMITER binding is asked per IP and can refuse', async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: key !== '9.9.9.9' }; } };
  assert.equal(await allowed({ FEEDBACK_LIMITER: limiter }, '8.8.8.8'), true);
  assert.equal(await allowed({ FEEDBACK_LIMITER: limiter }, '9.9.9.9'), false);
  assert.deepEqual(keys, ['8.8.8.8', '9.9.9.9']);
});

/* ------------------------------------------------------------- endpoint -- */

test('POST /f: creates the Feedback tab and appends one row by header name', async () => {
  const tabs = { Pending: [['id']] };
  const calls = fakeWorld(tabs);
  const r = await worker.fetch(post(good()), env());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), SITE);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.message, /email you/);
  assert.deepEqual(calls.added, ['Feedback']);
  assert.deepEqual(tabs.Feedback[0], FEEDBACK_HEADERS);
  assert.equal(calls.appends.length, 1);
  const row = Object.fromEntries(FEEDBACK_HEADERS.map((h, i) => [h, calls.appends[0].rows[0][i]]));
  assert.match(row.id, /^fb-\d{8}-[a-z0-9]{6}$/);
  assert.ok(validPayload({ a: 'fb_approve', i: row.id }), 'the id fits decide()');
  assert.match(row.received, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(row.type, 'correction');
  assert.equal(row.page_url, `${SITE}/halls/`);
  assert.equal(row.email, 'reader@example.org');
  assert.equal(row.status, 'new');
  assert.equal(row.rating, '');

  // Second submission: tab exists, not created again; a column added at the end by Jon is fine.
  tabs.Feedback[0] = [...FEEDBACK_HEADERS, 'extra'];
  const r2 = await worker.fetch(post(good({ type: 'update', email: '' }), { ip: '198.51.100.1' }), env());
  assert.equal((await r2.json()).ok, true);
  assert.deepEqual(calls.added, ['Feedback']);
  assert.equal(calls.appends[1].rows[0].length, FEEDBACK_HEADERS.length + 1);
});

test('POST /f: Turnstile failure saves nothing', async () => {
  const tabs = { Feedback: [FEEDBACK_HEADERS] };
  const calls = fakeWorld(tabs, { turnstile: false });
  const r = await worker.fetch(post(good()), env());
  assert.equal(r.status, 403);
  assert.match((await r.json()).message, /not a robot/);
  assert.equal(calls.appends.length, 0);

  // Without JavaScript: no token, a plain page explaining JavaScript is needed.
  const r2 = await worker.fetch(post(good({ js: '', 'cf-turnstile-response': '' }), { ip: '10.0.0.2' }), env());
  assert.equal(r2.status, 403);
  assert.match(r2.headers.get('content-type'), /text\/html/);
  assert.match(await r2.text(), /needs JavaScript/);
  assert.equal(calls.appends.length, 0);
});

test('POST /f: refused before Turnstile when invalid, from another site, or too often', async () => {
  const tabs = { Feedback: [FEEDBACK_HEADERS] };
  const calls = fakeWorld(tabs);
  let r = await worker.fetch(post(good({ message: '' })), env());
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /write your message/);
  r = await worker.fetch(post(good(), { origin: 'https://evil.example' }), env());
  assert.equal(r.status, 403);
  assert.equal(calls.turnstile.length, 0);

  for (let i = 0; i < 5; i += 1) assert.equal((await worker.fetch(post(good(), { ip: "7.7.7.7" }), env())).status, 200);
  r = await worker.fetch(post(good(), { ip: '7.7.7.7' }), env());
  assert.equal(r.status, 429);
  assert.match((await r.json()).message, /wait ten minutes/);
  assert.equal(calls.appends.length, 5);
});

test('POST /f: honeypot filled looks like success but saves nothing', async () => {
  const tabs = { Feedback: [FEEDBACK_HEADERS] };
  const calls = fakeWorld(tabs);
  const r = await worker.fetch(post(good({ website: 'http://spam.example' })), env());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(calls.appends.length, 0);
  assert.equal(calls.turnstile.length, 0);
});

test('POST /f: no-JS success is a page linking back to where they were', async () => {
  fakeWorld({ Feedback: [FEEDBACK_HEADERS] });
  const r = await worker.fetch(post(good({ js: '' })), env());
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Thank you/);
  assert.match(html, /href="https:\/\/thelenches.org.uk\/halls\/#top"/);
});

test('GET /f is not a form', async () => {
  const r = await worker.fetch(new Request('https://approvals.example.workers.dev/f'), env());
  assert.equal(r.status, 405);
});

test('handleFeedback: daily cap and a Sheet failure are reported, not swallowed', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const full = [FEEDBACK_HEADERS, ...Array.from({ length: 100 }, (_, i) => [`fb-x-${i}`, `${today} 09:00`])];
  fakeWorld({ Feedback: full });
  let r = await handleFeedback(post(good()), env());
  assert.equal(r.status, 503);
  globalThis.fetch = async (u) => (String(u).includes('siteverify') ? Response.json({ success: true })
    : String(u).includes('oauth2') ? Response.json({ access_token: 'goog', expires_in: 3600 }) : new Response('boom', { status: 500 }));
  r = await handleFeedback(post(good(), { ip: '6.6.6.6' }), env());
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /wasn't saved/);
});

/* -------------------------------------------------------- panel / decide -- */

const TODAY = '2026-10-25';
const row = (extra) => ({
  _row: 2, id: 'fb-20261025-abc123', status: 'new', message: 'Hall phone wrong', email: 'r@example.org', notes: '', ...extra,
});

test('feedbackState sorts rows into the screen sections', () => {
  assert.equal(feedbackState(row(), TODAY), 'waiting');
  assert.equal(feedbackState(row({ status: '' }), TODAY), 'waiting');
  assert.equal(feedbackState(row({ status: 'postponed until 2026-11-01' }), TODAY), 'postponed');
  assert.equal(feedbackState(row({ status: 'postponed until 2026-10-25' }), TODAY), 'waiting');
  assert.equal(feedbackState(row({ status: 'approved' }), TODAY), 'approved');
  assert.equal(feedbackState(row({ status: 'implemented', reply_draft: 'Hi' }), TODAY), 'reply');
  assert.equal(feedbackState(row({ status: 'implemented', reply_sent: '2026-10-25 10:00' }), TODAY), '');
  assert.equal(feedbackState(row({ status: 'implemented', email: '' }), TODAY), '');
  assert.equal(feedbackState(row({ status: 'rejected' }), TODAY), '');
  assert.deepEqual(feedbackRows({ headers: [], rows: [row(), row({ status: 'rejected' })] }, TODAY).rows.map((r) => r._state), ['waiting']);
});

test('planFeedback -> decide(): every action goes to approval.yml with the item id', async () => {
  const cases = [
    ['approve', row(), {}, { id: 'fb-20261025-abc123', action: 'fb_approve' }],
    ['reject', row(), {}, { id: 'fb-20261025-abc123', action: 'fb_reject' }],
    ['postpone', row(), { date: '2026-11-08' }, { id: 'fb-20261025-abc123', action: 'fb_postpone', reason: '2026-11-08' }],
    ['done', row({ status: 'approved' }), {}, { id: 'fb-20261025-abc123', action: 'fb_done' }],
    ['send', row({ status: 'implemented', reply_draft: 'Hi there' }), {}, { id: 'fb-20261025-abc123', action: 'fb_send' }],
    ['edit', row({ status: 'implemented', reply_draft: 'Hi there' }), { body: 'Hi there,\r\nAll fixed now.' },
      { id: 'fb-20261025-abc123', action: 'fb_edit', body: 'Hi there,\nAll fixed now.' }],
    ['skip', row({ status: 'implemented', reply_draft: 'Hi there' }), {}, { id: 'fb-20261025-abc123', action: 'fb_skip' }],
  ];
  const calls = fakeWorld({});
  for (const [action, r, extra, expected] of cases) {
    const plan = planFeedback({ action, id: r.id, ...extra }, r, TODAY);
    assert.ok(plan.p, `${action}: ${plan.error}`);
    assert.ok(validPayload(plan.p), action);
    assert.deepEqual(dispatchFor(plan.p, '', plan.body), ['approval', expected], action);
    assert.equal(await decide({ ...env(), REPO: 'owner/repo' }, plan.p, '', plan.body), true);
  }
  assert.deepEqual(calls.dispatches.map((d) => d.event_type), cases.map(() => 'approval'));
  assert.deepEqual(calls.dispatches.map((d) => d.client_payload.action), cases.map((c) => `fb_${c[0]}`));
});

test('planFeedback refuses the wrong state, bad dates and unknown actions', () => {
  const r = (status, extra = {}) => row({ status, ...extra });
  assert.equal(planFeedback({ action: 'approve', id: 'x' }, null, TODAY).status, 404);
  assert.equal(planFeedback({ action: 'nuke', id: 'x' }, r('new'), TODAY).status, 400);
  assert.equal(planFeedback({ action: 'approve', id: 'x' }, r('approved'), TODAY).status, 409);
  assert.equal(planFeedback({ action: 'done', id: 'x' }, r('new'), TODAY).status, 409);
  assert.equal(planFeedback({ action: 'send', id: 'x' }, r('approved'), TODAY).status, 409);
  assert.equal(planFeedback({ action: 'send', id: 'x' }, r('implemented', { reply_draft: '' }), TODAY).status, 409);
  assert.equal(planFeedback({ action: 'edit', id: 'x', body: 'short' }, r('implemented', { reply_draft: 'Hi' }), TODAY).status, 400);
  assert.equal(planFeedback({ action: 'postpone', id: 'x', date: TODAY }, r('new'), TODAY).status, 400);
  assert.equal(planFeedback({ action: 'postpone', id: 'x', date: '2028-01-01' }, r('new'), TODAY).status, 400);
  assert.equal(planFeedback({ action: 'postpone', id: 'x', date: 'soon' }, r('new'), TODAY).status, 400);
  assert.ok(planFeedback({ action: 'approve', id: 'x' }, r('postponed until 2026-12-01'), TODAY).p, 'postponed can be decided early');
  assert.equal(validPayload({ a: 'fb_postpone', i: 'x' }), false, 'postpone needs its date');
});

test('Add note appends with a timestamp and is stale-checked against the Sheet', async () => {
  const H = ['id', 'notes'];
  const tabs = { Feedback: [H, ['fb-1', '2026-10-24 09:00 First note']] };
  fakeWorld(tabs);
  const r = { _row: 2, id: 'fb-1', notes: '2026-10-24 09:00 First note' };
  const ms = Date.parse('2026-10-20T13:05:00Z'); // 14:05 UK (BST)
  const plan = planNote({ note: 'Asked the hall for the new number', expected: r.notes }, r, ms);
  assert.equal(plan.value, '2026-10-24 09:00 First note\n2026-10-20 14:05 Asked the hall for the new number');
  const ok = await checkedWrite(env(), { tab: 'Feedback', keyCol: 'id', key: 'fb-1', field: 'notes', expected: r.notes, value: plan.value });
  assert.equal(ok.ok, true);
  assert.equal(tabs.Feedback[1][1], plan.value);

  // A page loaded before that note: refused, nothing overwritten.
  const stale = planNote({ note: 'Another', expected: '2026-10-24 09:00 First note' }, r, ms);
  const refused = await checkedWrite(env(), { tab: 'Feedback', keyCol: 'id', key: 'fb-1', field: 'notes', expected: '2026-10-24 09:00 First note', value: stale.value });
  assert.equal(refused.status, 409);
  assert.equal(tabs.Feedback[1][1], plan.value);
  assert.equal(planNote({ note: ' ', expected: '' }, r).status, 400);
  assert.equal(planNote({ note: 'x', expected: '' }, null).status, 404);
});
