// worker/test/draft.test.mjs
// Offline tests for admin/draft.js: the Newsletter draft tab as scripts/newsletter/draft.js
// writes it (meta, html in deflated base64 chunks) read back, and the framed page's headers.
// Run: node --test worker/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { draftMeta, draftHtml, draftPage } from '../src/admin/draft.js';

const require = createRequire(import.meta.url);
const { draftRows } = require('../../scripts/newsletter/draft.js');

const html = '<!doctype html><html><head><title>x</title></head><body><p>Hall quiz</p>' + 'é'.repeat(5000) + '</body></html>';
const meta = { issue_date: '2026-10-29', mode: 'live', status: '', subject: 'S', items: 3, events: 1, notices: 2, roads: 0, elsewhere: 0, held: 1, cutoff: '2026-10-28 18:00' };

test('the tab reads back: meta and the html exactly', async () => {
  const rows = draftRows(meta, html, '2026-10-28T12:00:00Z');
  const m = draftMeta(rows);
  assert.equal(m.as_of, '2026-10-28T12:00:00Z');
  assert.equal(m.issue_date, '2026-10-29');
  assert.equal(m.items, 3);
  assert.equal(m.held, 1);
  assert.equal(await draftHtml(rows), html);
  // Several chunks, in any order.
  const big = html + 'x'.repeat(300000).replace(/x/g, () => String.fromCharCode(97 + Math.floor(Math.random() * 26)));
  const many = draftRows(meta, big, 'a');
  assert.ok(many.length > 15);
  const shuffled = [many[0], ...many.slice(1).reverse()];
  assert.equal(await draftHtml(shuffled), big);
});

test('no tab yet: no meta, no html', async () => {
  assert.equal(draftMeta([]), null);
  assert.equal(await draftHtml([]), '');
});

test('the framed page: no scripts, site images only, panel framing only, links in a new tab', async () => {
  const r = draftPage(html);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src https:\/\/thelenches\.org\.uk data:/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /sandbox/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(await r.text(), /<head><base target="_blank"><title>/);
  assert.match(await draftPage('').text(), /No draft yet/);
});
