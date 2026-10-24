// worker/test/admin.test.mjs
// Offline tests for the admin panel plumbing: Access JWT verification, CSRF, the
// stale-write check and the panel -> decision mapping. Google, GitHub and the Access
// certs are mocked; nothing leaves the machine.
// Run: node --test worker/test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyAccess, resetCertCache } from '../src/admin/access.js';
import { makeCsrf, checkCsrf, sameOrigin, CSRF_TTL_MS } from '../src/admin/csrf.js';
import { editCell, colLetter } from '../src/admin/sheet.js';
import { planPending, planReply, planPhoto, trustKeyFor } from '../src/admin/actions.js';
import { resetTokenCache } from '../src/admin/google.js';
import { bytesToB64url, jsonToB64url } from '../src/admin/b64.js';
import { dispatchFor } from '../src/core.js';
import worker from '../src/index.js';

const enc = new TextEncoder();
const TEAM = 'lenches.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const ORIGIN = 'https://approvals.lenches.workers.dev';
const ADMIN = 'admin@example.org';

/* ------------------------------------------------------------ fixtures -- */

const rsa = () => crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const accessKey = await rsa();
const otherKey = await rsa();
const saKey = await rsa();
const accessJwk = { ...(await crypto.subtle.exportKey('jwk', accessKey.publicKey)), kid: 'k1' };
const saPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;

async function jwt(claims, { key = accessKey.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const body = `${jsonToB64url({ alg, kid, typ: 'JWT' })}.${jsonToB64url(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(body));
  return `${body}.${bytesToB64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({ aud: [AUD], iss: `https://${TEAM}`, email: ADMIN, exp: now() + 600, iat: now() });

const env = () => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ADMIN_EMAILS: `${ADMIN}, second@example.org`,
  APPROVAL_SIGNING_KEY: 'test-signing-key',
  DISPATCH_TOKEN: 'gh-token',
  REPO: 'owner/repo',
  SHEET_ID: 'sheet123',
  GMAIL_USER: 'inbox@example.org',
  GOOGLE_SA_KEY: JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: saPem }),
});

// A small fake Google Sheet + GitHub + Access certs behind global fetch.
function fakeWorld(tables) {
  const calls = { writes: [], dispatches: [], certFetches: 0, tokenSubs: [] };
  const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.hostname === TEAM && url.pathname === '/cdn-cgi/access/certs') {
      calls.certFetches += 1;
      return Response.json({ keys: [accessJwk] });
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(init.body).get('assertion');
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', saKey.publicKey,
        Buffer.from(assertion.split('.')[2], 'base64url'), enc.encode(assertion.split('.').slice(0, 2).join('.')));
      if (!ok) return new Response('bad sig', { status: 400 });
      calls.tokenSubs.push(claims.sub || '');
      return Response.json({ access_token: 'goog', expires_in: 3600 });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      assert.equal(init.headers.authorization, 'Bearer goog');
      const m = decodeURIComponent(url.pathname).match(/\/values\/'(.+)'!(.+)$/);
      if (m && method === 'GET') {
        const [, tab, range] = m;
        if (tab === 'Settings' && range === 'E1:F100') return Response.json({ values: tables.SettingsKV });
        if (tab === 'Settings') return Response.json({ values: tables.SettingsSources || [['source', 'match', 'mode']] });
        return Response.json({ values: tables[tab] });
      }
      if (url.pathname.endsWith('/values:batchUpdate')) {
        const body = JSON.parse(init.body);
        assert.equal(body.valueInputOption, 'RAW');
        for (const d of body.data) {
          calls.writes.push(d);
          const [, tab, col, row] = d.range.match(/^'(.+)'!([A-Z]+)(\d+)$/);
          const grid = tab === 'Settings' ? tables.SettingsKV : tables[tab];
          const c = tab === 'Settings' ? 1 : colIndex(col);
          grid[row - 1][c] = d.values[0][0];
        }
        return Response.json({});
      }
      return Response.json({ sheets: [{ properties: { title: 'Pending', sheetId: 7 } }] });
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/owner/repo/dispatches') {
      calls.dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
  return calls;
}

const PENDING_HEADERS = ['id', 'from', 'source', 'message_id', 'title', 'summary', 'event_date', 'village', 'category',
  'status', 'people_in_image', 'own_text', 'people_ok'];
const pendingTable = () => [
  PENDING_HEADERS,
  ['m1-1', 'Hall <hall@example.org>', 'Gmail', 'm1', 'Quiz night', 'Quiz at the hall.', '2026-11-14', 'Rous Lench', 'event', 'pending', 'FALSE', '', ''],
  ['m2-1', 'Fete <fete@example.org>', 'Gmail', 'm2', 'Fete', 'Fete with photos.', '2026-12-01', 'Atch Lench', 'event', 'pending', 'TRUE', '', ''],
  ['m3-1', 'Old <old@example.org>', 'Gmail', 'm3', 'Old', 'Done.', '', '', 'notice', 'approved', 'FALSE', '', ''],
];
const photosTable = () => [
  ['drive_id', 'filename', 'status', 'target', 'people', 'people_ok'],
  ['driveAAAAAAAAAA1', 'church.jpg', 'new', '', 'none', ''],
  ['driveAAAAAAAAAA2', 'fete.jpg', 'new', '', 'children', ''],
];
const tablesFor = () => ({
  Pending: pendingTable(),
  Photos: photosTable(),
  Replies: [['reply_id', 'status', 'body'], ['r1', 'awaiting', 'Thanks!']],
  Health: [['date', 'status', 'summary'], ['2026-10-24 06:00', 'OK', 'OK']],
  Issues: [['issue_id', 'issue_date', 'status', 'snapshot'], ['2026-10-23', '2026-10-23', 'sent', '{big}']],
  SettingsKV: [['key', 'value'], ['from_name', 'X'], ['holiday_mode', 'FALSE']],
});

const reqWith = async (path, { method = 'GET', body, token, csrf, origin = ORIGIN, claims } = {}) => {
  const headers = { 'cf-access-jwt-assertion': token ?? await jwt(claims || goodClaims()) };
  if (origin) headers.origin = origin;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
};

test.beforeEach(() => {
  resetCertCache();
  resetTokenCache();
});

/* ------------------------------------------------------------- Access -- */

test('Access: a valid token for an allowed email passes', async () => {
  fakeWorld(tablesFor());
  const r = await verifyAccess(await reqWith('/admin'), env());
  assert.deepEqual(r, { email: ADMIN });
});

test('Access: every bad token is refused', async () => {
  const calls = fakeWorld(tablesFor());
  const cases = {
    'no header': '',
    garbage: 'not.a.jwt',
    'wrong audience': await jwt({ ...goodClaims(), aud: ['other'] }),
    'wrong issuer': await jwt({ ...goodClaims(), iss: 'https://evil.cloudflareaccess.com' }),
    expired: await jwt({ ...goodClaims(), exp: now() - 3600 }),
    'not yet valid': await jwt({ ...goodClaims(), nbf: now() + 3600 }),
    'email not allowed': await jwt({ ...goodClaims(), email: 'someone@else.org' }),
    'no email': await jwt({ ...goodClaims(), email: '' }),
    'signed by another key': await jwt(goodClaims(), { key: otherKey.privateKey }),
    'unknown key id': await jwt(goodClaims(), { kid: 'nope' }),
    'alg HS256': await jwt(goodClaims(), { alg: 'HS256' }),
  };
  for (const [name, token] of Object.entries(cases)) {
    const r = await verifyAccess(await reqWith('/admin', { token }), env());
    assert.ok(r.error && !r.email, `${name} should be refused`);
  }
  // Tampered payload: same signature, different claims.
  const good = await jwt(goodClaims());
  const [h, , s] = good.split('.');
  const tampered = `${h}.${jsonToB64url({ ...goodClaims(), email: 'second@example.org', exp: now() + 9999 })}.${s}`;
  assert.equal((await verifyAccess(await reqWith('/admin', { token: tampered }), env())).error, 'bad signature');
  assert.ok(calls.certFetches <= 3, 'certs are cached');
});

test('Access: fails closed when not configured', async () => {
  fakeWorld(tablesFor());
  for (const k of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS']) {
    const e = env();
    delete e[k];
    assert.ok((await verifyAccess(await reqWith('/admin'), e)).error, `${k} missing`);
  }
});

test('Router: /admin, API and images all 403 without a valid Access token; email links unaffected', async () => {
  fakeWorld(tablesFor());
  for (const p of ['/admin', '/admin/', '/admin/api/state', '/admin/api/session', '/admin/img/drive/driveAAAAAAAAAA1']) {
    const r = await worker.fetch(await reqWith(p, { token: '' }), env());
    assert.equal(r.status, 403, p);
  }
  const post = await worker.fetch(await reqWith('/admin/api/action', { method: 'POST', token: 'x.y.z', body: { kind: 'pending' } }), env());
  assert.equal(post.status, 403);
  const link = await worker.fetch(new Request(`${ORIGIN}/a?t=bad`), env());
  assert.equal(link.status, 400, '/a still answers its own invalid-link page');
});

/* --------------------------------------------------------------- CSRF -- */

test('CSRF: token is tied to the email and expires', async () => {
  const e = env();
  const t = await makeCsrf(e, ADMIN);
  assert.equal(await checkCsrf(e, ADMIN, t), true);
  assert.equal(await checkCsrf(e, 'second@example.org', t), false);
  assert.equal(await checkCsrf(e, ADMIN, t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), false);
  assert.equal(await checkCsrf(e, ADMIN, await makeCsrf(e, ADMIN, Date.now() - CSRF_TTL_MS - 1000)), false);
  assert.equal(await checkCsrf(e, ADMIN, ''), false);
  assert.equal(await checkCsrf({ ...e, APPROVAL_SIGNING_KEY: 'other' }, ADMIN, t), false);
});

test('CSRF: same-origin check', () => {
  const r = (h) => new Request(`${ORIGIN}/admin/api/edit`, { method: 'POST', headers: h });
  assert.equal(sameOrigin(r({ origin: ORIGIN })), true);
  assert.equal(sameOrigin(r({ origin: 'https://evil.example' })), false);
  assert.equal(sameOrigin(r({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(sameOrigin(r({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(sameOrigin(r({})), false);
});

test('Router: POST without CSRF token or from another origin is refused, nothing written', async () => {
  const calls = fakeWorld(tablesFor());
  const body = { tab: 'Pending', key: 'm1-1', field: 'title', expected: 'Quiz night', value: 'Quiz' };
  let r = await worker.fetch(await reqWith('/admin/api/edit', { method: 'POST', body }), env());
  assert.equal(r.status, 403);
  const csrf = await makeCsrf(env(), ADMIN);
  r = await worker.fetch(await reqWith('/admin/api/edit', { method: 'POST', body, csrf, origin: 'https://evil.example' }), env());
  assert.equal(r.status, 403);
  assert.equal(calls.writes.length, 0);
});

/* --------------------------------------------------------- stale write -- */

test('Edit: writes one cell by header name when the cell is unchanged', async () => {
  const tables = tablesFor();
  const calls = fakeWorld(tables);
  const r = await editCell(env(), { tab: 'Pending', key: 'm1-1', field: 'summary', expected: 'Quiz at the hall.', value: 'Quiz at the hall, 7pm.' });
  assert.deepEqual(r, { ok: true, value: 'Quiz at the hall, 7pm.' });
  assert.deepEqual(calls.writes, [{ range: `'Pending'!${colLetter(PENDING_HEADERS.indexOf('summary'))}2`, values: [['Quiz at the hall, 7pm.']] }]);
  assert.equal(tables.Pending[1][5], 'Quiz at the hall, 7pm.');
});

test('Edit: refused with the current value when the cell changed since loading', async () => {
  const tables = tablesFor();
  tables.Pending[1][4] = 'Quiz night (edited in Sheet)';
  const calls = fakeWorld(tables);
  const r = await editCell(env(), { tab: 'Pending', key: 'm1-1', field: 'title', expected: 'Quiz night', value: 'Mine' });
  assert.equal(r.status, 409);
  assert.equal(r.current, 'Quiz night (edited in Sheet)');
  assert.equal(calls.writes.length, 0);
});

test('Edit: rows found by id even when moved; columns by header even when reordered', async () => {
  const tables = tablesFor();
  // Swap two columns and move the row down.
  tables.Pending = tables.Pending.map((r) => { const c = r.slice(); [c[4], c[5]] = [c[5], c[4]]; return c; });
  tables.Pending.splice(1, 0, tables.Pending.splice(1, 1)[0], ['x', '', '', '', '', '', '', '', '', 'pending']);
  tables.Pending.push(tables.Pending.splice(1, 1)[0]);
  const calls = fakeWorld(tables);
  const r = await editCell(env(), { tab: 'Pending', key: 'm1-1', field: 'title', expected: 'Quiz night', value: 'Quiz!' });
  assert.equal(r.ok, true);
  const rowNo = tables.Pending.findIndex((x) => x[0] === 'm1-1') + 1;
  assert.deepEqual(calls.writes[0].range, `'Pending'!F${rowNo}`);
});

test('Edit: refuses decided rows, unknown fields, bad values, missing or duplicate rows', async () => {
  const tables = tablesFor();
  tables.Photos.push(['driveAAAAAAAAAA1', 'dupe.jpg', 'new', '', '', '']);
  const calls = fakeWorld(tables);
  const e = env();
  const cases = [
    [{ tab: 'Pending', key: 'm3-1', field: 'title', expected: 'Old', value: 'New' }, 409],
    [{ tab: 'Pending', key: 'm1-1', field: 'status', expected: 'pending', value: 'approved' }, 400],
    [{ tab: 'Pending', key: 'm1-1', field: 'event_date', expected: '2026-11-14', value: '14 Nov' }, 400],
    [{ tab: 'Pending', key: 'm1-1', field: 'category', expected: 'event', value: 'news' }, 400],
    [{ tab: 'Pending', key: 'm1-1', field: 'title', expected: 'Quiz night', value: '  ' }, 400],
    [{ tab: 'Pending', key: 'nope', field: 'title', expected: '', value: 'x' }, 404],
    [{ tab: 'Pending', key: '', field: 'title', expected: '', value: 'x' }, 404],
    [{ tab: 'Photos', key: 'driveAAAAAAAAAA1', field: 'target', expected: '', value: 'home' }, 404],
    [{ tab: 'Replies', key: 'r1', field: 'body', expected: 'Thanks!', value: 'x' }, 400],
    [{ tab: 'Subscribers', key: 'a', field: 'email', expected: '', value: 'x' }, 400],
  ];
  for (const [args, status] of cases) {
    const r = await editCell(e, args);
    assert.equal(r.status, status, JSON.stringify(args));
  }
  assert.equal(calls.writes.length, 0);
});

test('Edit: holiday mode is found by key in Settings E:F and stale-checked', async () => {
  const tables = tablesFor();
  const calls = fakeWorld(tables);
  let r = await editCell(env(), { tab: 'Settings', field: 'holiday_mode', expected: 'TRUE', value: 'FALSE' });
  assert.equal(r.status, 409);
  assert.equal(r.current, 'FALSE');
  r = await editCell(env(), { tab: 'Settings', field: 'holiday_mode', expected: 'FALSE', value: 'TRUE' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.writes, [{ range: "'Settings'!F3", values: [['TRUE']] }]);
  r = await editCell(env(), { tab: 'Settings', field: 'preview_to', expected: '', value: 'x@y.z' });
  assert.equal(r.status, 400);
  r = await editCell(env(), { tab: 'Settings', field: 'holiday_mode', expected: 'TRUE', value: 'maybe' });
  assert.equal(r.status, 400);
});

/* ------------------------------------------------------ action mapping -- */

// What the signed email link for the same decision would send to GitHub.
const emailDispatch = (p, reason = '', body = '') => dispatchFor(p, reason, body);

test('Mapping: Pending actions build the same payload as the email links', () => {
  const row = { id: 'm1-1', status: 'pending', from: 'Hall <hall@example.org>', message_id: 'm1', people_in_image: 'FALSE' };
  for (const action of ['approve', 'approve_own', 'approve_rewrite', 'reject']) {
    const { p } = planPending({ action, id: 'm1-1' }, row);
    assert.deepEqual(p, { a: action, i: 'm1-1' });
    assert.deepEqual(dispatchFor(p), ['approval', { id: 'm1-1', action }]);
  }
  const { p } = planPending({ action: 'trust', id: 'm1-1' }, row);
  assert.deepEqual(p, { a: 'trust', i: 'm1-1', k: 'hall@example.org' });
  assert.deepEqual(dispatchFor(p), ['approval', { id: 'm1-1', action: 'trust' }]);
});

test('Mapping: Pending refusals (people_ok, decided, unknown, untrustable)', () => {
  const people = { id: 'm2-1', status: 'pending', people_in_image: 'TRUE', from: 'a@b.org', message_id: 'm2' };
  assert.equal(planPending({ action: 'approve', id: 'm2-1' }, people).status, 409);
  assert.equal(planPending({ action: 'approve', id: 'm2-1' }, people, { hasPeopleOk: true }).status, 409);
  assert.equal(planPending({ action: 'trust', id: 'm2-1' }, people, { hasPeopleOk: true }).status, 409);
  assert.ok(planPending({ action: 'approve', id: 'm2-1' }, { ...people, people_ok: 'yes' }, { hasPeopleOk: true }).p);
  assert.ok(planPending({ action: 'reject', id: 'm2-1' }, people).p, 'reject never needs people_ok');
  assert.equal(planPending({ action: 'approve', id: 'm3-1' }, { status: 'approved' }).status, 409);
  assert.equal(planPending({ action: 'approve', id: 'x' }, null).status, 404);
  for (const bad of ['nlsend', 'nlbuild', 'send', 'unsub', 'delete']) {
    assert.equal(planPending({ action: bad, id: 'm1-1' }, { status: 'pending' }).status, 400, bad);
  }
  assert.equal(planPending({ action: 'approve', id: 'bad id!' }, { status: 'pending' }).status, 400);
  const fb = { status: 'pending', message_id: 'm9', from: 'Facebook <notification@facebookmail.com>' };
  assert.equal(planPending({ action: 'trust', id: 'm9-1' }, fb).status, 409);
});

test('Mapping: trust keys match scripts/ingest/trusted.js', () => {
  const sources = [{ source: 'Parish feed', match: 'https://example.org/Feed' }];
  assert.equal(trustKeyFor({ message_id: 'rss:abc', source: 'Parish feed' }, sources), 'https://example.org/feed');
  assert.equal(trustKeyFor({ message_id: 'rss:abc', source: 'Gone' }, sources), '');
  assert.equal(trustKeyFor({ message_id: 'm', from: '"A B" <A.B@Example.org>' }, []), 'a.b@example.org');
  assert.equal(trustKeyFor({ message_id: 'm', from: 'x@thelenches.org.uk' }, []), '');
});

test('Mapping: reply buttons map to the email actions with the same cleaning', () => {
  assert.deepEqual(planReply({ action: 'approve', id: 'r1' }).p, { a: 'send', i: 'r1' });
  assert.deepEqual(emailDispatch({ a: 'send', i: 'r1' }), ['approval', { id: 'r1', action: 'send' }]);

  const rej = planReply({ action: 'reject', id: 'r1', reason: 'too\nlong-winded' });
  assert.deepEqual([rej.p, rej.reason], [{ a: 'skip', i: 'r1' }, 'too long-winded']);
  assert.deepEqual(dispatchFor(rej.p, rej.reason), ['approval', { id: 'r1', action: 'skip', reason: 'too long-winded' }]);

  assert.equal(planReply({ action: 'redraft', id: 'r1', reason: ' ' }).status, 400, 'redraft needs an instruction');
  const rd = planReply({ action: 'redraft', id: 'r1', reason: 'Shorter please' });
  assert.deepEqual(dispatchFor(rd.p, rd.reason), ['approval', { id: 'r1', action: 'redraft', reason: 'Shorter please' }]);

  assert.equal(planReply({ action: 'edit', id: 'r1', body: 'short' }).status, 400);
  const ed = planReply({ action: 'edit', id: 'r1', body: 'Thanks for your email.\r\nSee you there.', reason: 'tone' });
  assert.deepEqual(dispatchFor(ed.p, ed.reason, ed.body),
    ['approval', { id: 'r1', action: 'edit', body: 'Thanks for your email.\nSee you there.', reason: 'tone' }]);

  assert.deepEqual(dispatchFor(planReply({ action: 'close', id: 'r1' }).p), ['approval', { id: 'r1', action: 'close' }]);
  for (const bad of ['send', 'skip', 'nlsend', 'trust', '']) assert.equal(planReply({ action: bad, id: 'r1' }).status, 400, bad);
});

test('Mapping: photos approve is a status write, gated on people_ok', () => {
  assert.deepEqual(planPhoto({ action: 'approve', expected: 'new' }, { people: 'none' }), { field: 'status', value: 'approved', expected: 'new' });
  assert.equal(planPhoto({ action: 'approve', expected: 'new' }, { people: 'children' }).status, 409);
  assert.ok(planPhoto({ action: 'approve', expected: 'new' }, { people: 'children', people_ok: 'yes' }).field);
  assert.equal(planPhoto({ action: 'reject', expected: 'new' }, { people: 'children' }).value, 'rejected');
  assert.equal(planPhoto({ action: 'publish' }, { people: 'none' }).status, 400);
});

/* ------------------------------------------------------- end to end -- */

async function post(path, body) {
  const csrf = await makeCsrf(env(), ADMIN);
  const r = await worker.fetch(await reqWith(path, { method: 'POST', body, csrf }), env());
  return { status: r.status, json: await r.json() };
}

test('E2E: Approve from the panel fires the same repository_dispatch as the email link', async () => {
  const calls = fakeWorld(tablesFor());
  const r = await post('/admin/api/action', { kind: 'pending', id: 'm1-1', action: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(calls.dispatches, [{ event_type: 'approval', client_payload: { id: 'm1-1', action: 'approve' } }]);
  assert.equal(calls.writes.length, 0, 'decisions never write the Sheet directly');
});

test('E2E: people image blocks approve until people_ok is ticked (stale-checked)', async () => {
  const tables = tablesFor();
  const calls = fakeWorld(tables);
  let r = await post('/admin/api/action', { kind: 'pending', id: 'm2-1', action: 'approve' });
  assert.equal(r.status, 409);
  r = await post('/admin/api/edit', { tab: 'Pending', key: 'm2-1', field: 'people_ok', expected: '', value: 'yes' });
  assert.equal(r.status, 200);
  r = await post('/admin/api/action', { kind: 'pending', id: 'm2-1', action: 'approve' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.dispatches.map((d) => d.client_payload), [{ id: 'm2-1', action: 'approve' }]);
});

test('E2E: reply redraft and photo approve', async () => {
  const tables = tablesFor();
  const calls = fakeWorld(tables);
  let r = await post('/admin/api/action', { kind: 'reply', id: 'r1', action: 'redraft', reason: 'Mention parking' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.dispatches[0], { event_type: 'approval', client_payload: { id: 'r1', action: 'redraft', reason: 'Mention parking' } });
  r = await post('/admin/api/action', { kind: 'photo', id: 'driveAAAAAAAAAA1', action: 'approve', expected: 'new' });
  assert.equal(r.status, 200);
  assert.equal(tables.Photos[1][2], 'approved');
  r = await post('/admin/api/action', { kind: 'photo', id: 'driveAAAAAAAAAA2', action: 'approve', expected: 'new' });
  assert.equal(r.status, 409);
  r = await post('/admin/api/action', { kind: 'photo', id: 'driveAAAAAAAAAA1', action: 'reject', expected: 'new' });
  assert.equal(r.status, 409, 'stale: it is approved now');
  assert.equal(calls.dispatches.length, 1);
});

test('E2E: nothing in the panel can send the newsletter', async () => {
  const calls = fakeWorld(tablesFor());
  for (const body of [
    { kind: 'newsletter', id: '2026-10-29', action: 'nlsend' },
    { kind: 'pending', id: '2026-10-29', action: 'nlsend' },
    { kind: 'reply', id: '2026-10-29', action: 'nlbuild' },
  ]) {
    const r = await post('/admin/api/action', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.dispatches.length, 0);
});

test('E2E: state and session', async () => {
  const calls = fakeWorld(tablesFor());
  const r = await worker.fetch(await reqWith('/admin/api/state'), env());
  const s = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(s.pending.rows.map((x) => x.id), ['m1-1', 'm2-1']);
  assert.deepEqual(s.replies.rows.map((x) => x.reply_id), ['r1']);
  assert.deepEqual(s.photos.rows.map((x) => x.drive_id), ['driveAAAAAAAAAA1', 'driveAAAAAAAAAA2']);
  assert.deepEqual(s.holiday, { value: 'FALSE', on: false });
  assert.equal(s.issue.snapshot, undefined);
  assert.equal(s.gids.Pending, 7);
  assert.ok(calls.tokenSubs.every((x) => x === ''), 'Sheets uses the service account itself');
  const sess = await (await worker.fetch(await reqWith('/admin/api/session'), env())).json();
  assert.equal(sess.email, ADMIN);
  assert.equal(await checkCsrf(env(), ADMIN, sess.csrf), true);
  const home = await worker.fetch(await reqWith('/admin'), env());
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
