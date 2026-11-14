// worker/test/kryten.test.mjs: Kryten's quick Sheet access (POST /k, src/kryten.js). Since
// 14 Nov (Jon) /k has full access (every tab read in full, every tab but the Kryten log
// written), while the Read Sheet tab and Write Sheet cells workflows (scripts/sheettab,
// scripts/sheetwrite), whose logs are public, keep refusing the personal tabs; then reads,
// writes, undo and the refusals, with a fake Sheet.
// Run: node --test worker/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as k from '../src/kryten.js';
import worker from '../src/index.js';

const require = createRequire(import.meta.url);
const sheettab = require('../../scripts/sheettab/index.js');
const sheetwrite = require('../../scripts/sheetwrite/index.js');
const TOKEN = 'k'.repeat(40);

test('/k full access; the public-log workflows stay strict', () => {
  for (const t of ['Subscribers', 'Do Not Send', 'Sends', 'Replies', 'Feedback', 'Deleted contacts', 'Sign-ups', 'Recommendations', 'Listing suggestions']) {
    assert.equal(sheettab.isRefused(t), true, `workflow read ${t}`);
  }
  for (const t of ['Subscribers', 'Do Not Send', 'Sends', 'Deleted contacts', 'Sign-ups', 'Recommendations', 'Listing suggestions', 'Kryten log']) {
    assert.equal(sheetwrite.isRefused(t), true, `workflow write ${t}`);
  }
  assert.ok(sheettab.allowedColumns('Contacts'), 'workflow still hides Contacts profiles');
  assert.equal(sheettab.maskEmails('team@thelenches.org.uk'), 't***@thelenches.org.uk');
  assert.deepEqual(k.WRITE_REFUSED, ['kryten log']);
  assert.equal(k.MAX_CELLS, sheetwrite.MAX_CELLS);
  assert.deepEqual(k.LOG_HEADERS, sheetwrite.LOG_HEADERS);
  assert.deepEqual(k.targetRange('B5', [['x', 'y']]), sheetwrite.targetRange('B5', [['x', 'y']]));
  assert.deepEqual(k.parseValues('["a","b"]'), sheetwrite.parseValues('["a","b"]'));
});

// A fake Sheet: tabs as arrays of rows, the four calls src/kryten.js makes.
function fake(tabs) {
  const A = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range) => {
    const m = range.match(/^'((?:[^']|'')*)'(?:!(.*))?$/);
    const tab = m[1].replace(/''/g, "'");
    if (!m[2]) return { tab };
    const [a, b] = m[2].split(':');
    const p = (x) => { const r = x.match(/^([A-Z]+)(\d*)$/); return { c: A(r[1]), r: r[2] ? Number(r[2]) - 1 : null }; };
    const s = p(a); const e = b ? p(b) : s;
    return { tab, c0: s.c, r0: s.r == null ? 0 : s.r, c1: e.c, r1: e.r == null ? Infinity : e.r };
  };
  return {
    tabs,
    titles: async () => Object.keys(tabs),
    addTab: async (t) => { tabs[t] = []; },
    get: async (range) => {
      const q = parse(range); const t = tabs[q.tab];
      if (q.c0 == null) return t.map((r) => r.slice());
      const out = [];
      for (let i = q.r0; i <= Math.min(q.r1, t.length - 1); i += 1) out.push((t[i] || []).slice(q.c0, q.c1 + 1));
      while (out.length && out[out.length - 1].every((v) => v === '' || v == null)) out.pop();
      return out;
    },
    put: async (range, values) => {
      const q = parse(range); const t = tabs[q.tab];
      values.forEach((row, i) => { const r = (t[q.r0 + i] = t[q.r0 + i] || []); row.forEach((v, j) => { r[q.c0 + j] = v; }); });
    },
  };
}
const base = () => ({
  Contacts: [['email', 'name', 'status', 'profile'], ['ann@x.org', 'Ann', 'organiser', 'Private notes'], ['me@x.org', 'Me', 'ignore', 'x']],
  Rimmer: [['id', 'status'], ['K1', 'kryten']],
  Subscribers: [['email'], ['a@b.org']],
});
const req = (body, token = TOKEN, method = 'POST') => new Request('https://approvals.lenches.workers.dev/k', {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined,
});
const call = async (body, s, env = { KRYTEN_TOKEN: TOKEN }, token = TOKEN) => {
  const r = await k.handleKryten(req(body, token), env, s);
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('read: CSV with row numbers, every tab in full', async () => {
  const s = fake(base());
  const r = await call({ op: 'read', tab: 'contacts' }, s);
  assert.equal(r.status, 200);
  assert.equal(r.json.csv, 'row,A,B,C,D\n1,email,name,status,profile\n2,ann@x.org,Ann,organiser,Private notes\n3,me@x.org,Me,ignore,x');
  assert.equal((await call({ op: 'read', tab: 'Contacts', range: 'A1:B2' }, s)).json.csv, 'row,A,B\n1,email,name\n2,ann@x.org,Ann');
  assert.equal((await call({ op: 'read', tab: 'Subscribers' }, s)).json.csv, 'row,A\n1,email\n2,a@b.org');
  assert.equal((await call({ op: 'read', tab: 'Rimmer', range: 'A2:B2' }, s)).json.csv, 'row,A,B\n1,id,status\n2,K1,kryten');
});

test('write: stale-checked set with a Kryten log row, undo, and the refusals', async () => {
  const s = fake(base());
  const w = await call({ op: 'set', tab: 'Rimmer', range: 'B2', values: 'fixed', expect: 'kryten' }, s);
  assert.equal(w.status, 200);
  assert.equal(s.tabs.Rimmer[1][1], 'fixed');
  assert.deepEqual(s.tabs['Kryten log'][0], k.LOG_HEADERS);
  assert.deepEqual(s.tabs['Kryten log'][1].slice(2), ['set', 'Rimmer', 'B2:B2', '[["kryten"]]', '[["fixed"]]', 'done', 'kryten endpoint']);
  assert.match(w.json.message, /Undo id: w\d+/);
  // Changed since: refused, nothing written.
  assert.match((await call({ op: 'set', tab: 'Rimmer', range: 'B2', values: 'dismissed', expect: 'kryten' }, s)).json.error, /not what was expected/);
  assert.match((await call({ op: 'set', tab: 'Rimmer', range: 'B2', values: 'x' }, s)).json.error, /not blank/);
  const u = await call({ op: 'undo', undo_id: w.json.id }, s);
  assert.equal(u.status, 200);
  assert.equal(s.tabs.Rimmer[1][1], 'kryten');
  assert.match(s.tabs['Kryten log'][1][7], /^undone /);
  const a = await call({ op: 'append', tab: 'Rimmer', values: ['K2', 'open'] }, s);
  assert.equal(a.json.range, 'A3:B3');
  // Personal tabs are written too (full access, 14 Nov), logged like any other write.
  const sub = await call({ op: 'set', tab: 'Subscribers', range: 'B2', values: 'unsubscribed' }, s);
  assert.equal(sub.status, 200);
  assert.equal(s.tabs.Subscribers[1][1], 'unsubscribed');
  for (const [body, why] of [
    [{ op: 'set', tab: 'Kryten log', range: 'A9', values: 'x' }, /never written/],
    [{ op: 'set', tab: 'Rimmer', range: 'A1', values: 'x' }, /Row 1/],
    [{ op: 'set', tab: 'Rimmer', range: 'C9', values: '=1+1' }, /Formulas/],
    [{ op: 'set', tab: 'Rimmer', range: 'C9', values: [Array(51).fill('x')] }, /more than 50/],
    [{ op: 'delete', tab: 'Rimmer' }, /op must be/],
  ]) assert.match((await call(body, s)).json.error, why);
});

test('the token: off without the secret, 401 for a wrong one, POST only', async () => {
  const s = fake(base());
  assert.equal((await call({ op: 'read', tab: 'Rimmer' }, s, {})).status, 404);
  assert.equal((await call({ op: 'read', tab: 'Rimmer' }, s, { KRYTEN_TOKEN: 'short' }, 'short')).status, 404);
  assert.equal((await call({ op: 'read', tab: 'Rimmer' }, s, { KRYTEN_TOKEN: TOKEN }, `${TOKEN}x`)).status, 401);
  assert.equal((await call({ op: 'read', tab: 'Rimmer' }, s, { KRYTEN_TOKEN: TOKEN }, 'k'.repeat(39) + 'j')).status, 401);
  assert.equal((await k.handleKryten(req(null, TOKEN, 'GET'), { KRYTEN_TOKEN: TOKEN }, s)).status, 405);
  assert.equal(k.tokenOk(`Bearer ${TOKEN}`, TOKEN), true);
  // Routed by the Worker at /k (no secret here: 404).
  assert.equal((await worker.fetch(req({ op: 'read', tab: 'Rimmer' }), {})).status, 404);
});
