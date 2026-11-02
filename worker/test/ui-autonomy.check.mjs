// worker/test/ui-autonomy.check.mjs
// Browser check of the panel's Autonomy screen (ui/client.js, stage 2) against a mock API, on
// desktop and phone sizes: sections, progress bars, Latest decisions, Ignore (confirm,
// expected = outcome loaded) and Count again. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-autonomy.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-autonomy: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

import { autonomyStats } from '../src/admin/autonomy.js';
const it = (n, outcome, extra = {}) => ({ item_id: 'm' + n + '-1', created_at: '2026-11-02 09:00', decided_at: '2026-11-03 1' + (n % 10) + ':00', type: 'event', source_kind: 'email', flags: '', outcome, changed: '', ...extra });
const rp = (n, outcome, extra = {}) => ({ reply_id: 'r' + n, created_at: '2026-10-2' + (n % 9) + ' 09:00', decided_at: '2026-11-2' + (n % 9) + ' 10:0' + (n % 10), type: 'answer', class: 'question', outcome, ...extra });
const data = () => autonomyStats({
  items: { rows: [it(1, 'ignored:edited', { changed: 'title' }), it(2, 'approved'), it(3, 'edited', { changed: 'title,summary', draft: JSON.stringify({ title: 'Quiz Night — Village Hall' }), final: JSON.stringify({ title: 'Charity Quiz Night — Church Lench Village Hall' }) }), it(4, 'approved', { type: 'notice', source_kind: 'feed' })] },
  replies: { rows: [...Array.from({ length: 18 }, (_, i) => rp(i, i % 6 === 0 ? 'edited' : 'approved')), rp(30, 'rejected'), ...Array.from({ length: 9 }, (_, i) => rp(40 + i, i ? 'approved' : 'redrafted', { type: 'clarify', class: '' }))] },
}, Date.parse('2026-11-30T19:00:00Z'));
const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});

const posts = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (b, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/autonomy') return send(data());
  if (req.method === 'GET') return send({});
  let b = '';
  for await (const ch of req) b += ch;
  posts.push({ path: url.pathname, ...(b ? JSON.parse(b) : {}) });
  return send({ ok: true, message: 'Done.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    posts.length = 0;
    const page = await browser.newPage({ viewport });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${base}/admin`);
    const navBtn = page.locator('nav.side button', { hasText: 'Autonomy' });
    if (!(await navBtn.isVisible())) await page.locator('button[aria-label*="enu"]').first().click().catch(() => {});
    await navBtn.click();
    await page.locator('h2.section', { hasText: 'Submissions' }).waitFor();
    for (const t of ['Replies', 'If it had been on', 'Never automatic']) assert.ok(await page.locator('h2.section', { hasText: t }).count(), `${name}: ${t} section`);
    assert.ok(await page.locator('.au-card', { hasText: 'Event · email' }).count(), `${name}: event card`);
    assert.ok(await page.locator('.au-card', { hasText: 'Answer · question' }).locator('[role=progressbar]').count(), `${name}: progress bar`);
    assert.ok(await page.getByText('Nothing is automatic yet').count(), `${name}: status note`);
    const card = page.locator('.au-card', { hasText: 'Event · email' });
    await card.locator('summary').click();
    assert.ok(await card.getByText('Ignored').count(), `${name}: ignored decision shown`);
    assert.ok(await card.locator('.au-what', { hasText: 'Charity Quiz Night' }).count(), `${name}: what each decision was`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `autonomy-${name}.png`), fullPage: true });
    await card.locator('.au-dec', { hasText: 'Changed' }).getByRole('button', { name: 'Ignore' }).click();
    await page.waitForTimeout(200);
    assert.ok(dialogs.some((d) => /Ignore this decision/.test(d)), `${name}: confirm before ignoring`);
    let p = posts.find((x) => x.path === '/admin/api/autonomy-ignore' && x.op === 'ignore');
    assert.deepEqual([p.kind, p.id, p.expected], ['item', 'm3-1', 'edited'], `${name}: ignore posts the outcome loaded`);
    await page.locator('.au-card', { hasText: 'Event · email' }).locator('summary').click();
    await page.locator('.au-card', { hasText: 'Event · email' }).getByRole('button', { name: 'Count again' }).click();
    await page.waitForTimeout(200);
    p = posts.find((x) => x.path === '/admin/api/autonomy-ignore' && x.op === 'restore');
    assert.deepEqual([p.id, p.expected], ['m1-1', 'ignored:edited'], `${name}: count again`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${name}: no sideways scroll (${overflow}px)`);
    await page.close();
  }
  console.log('ui-autonomy: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
