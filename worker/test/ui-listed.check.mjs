// worker/test/ui-listed.check.mjs
// Browser check of an "Already listed" submission (ui/client.js listedBox / mergeForm, 3 Nov):
// the banner, Add details with Holly's proposal (editable) posting merge with the fields, and
// Approve asking first. Mock API, desktop and phone. Saves screenshots (SHOTS=dir).
// Also Submissions' Check email now (ingest-now, then the Ingest run watched in Activity's runs).
// Run: node worker/test/ui-listed.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-listed: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const dup = {
  key: 'h:events/2026-11-10-autumn-coffee-morning-church-lench.json', title: 'Autumn bring and buy coffee morning — Church Lench',
  url: 'https://thelenches.org.uk/events/#ev-2026-11-10-autumn-bring-and-buy-coffee-morning-church-lench', source: 'hand-written',
  confidence: 0.93, sure: true, details: 'Entry is £3, including cake', official: false,
  changes: { body: 'Celia Hall is kindly hosting a coffee morning with a bring and buy sale and a raffle, 10am to noon. Entry £3, including cake.' },
};
const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: { Pending: 1 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: ['people_ok', 'duplicate'], rows: [{ _row: 2, id: 'n1-1', title: "Celia's Bring & Buy Coffee Morning", status: 'pending', category: 'event',
    event_date: '2026-11-10', summary: 'Coffee, cake and a bring and buy at Tudor House, 10am to 12. £3.', received: '2026-11-03 09:00',
    message_id: 'n1', source: 'website', duplicate: JSON.stringify(dup) }] },
  replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-03', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});
const posts = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (b, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/runs') return send({ runs: [{ name: 'Ingest', status: 'completed', conclusion: 'success', started: new Date().toISOString() }] });
  if (req.method === 'GET') return send({});
  let b = '';
  for await (const ch of req) b += ch;
  posts.push({ path: url.pathname, ...(b ? JSON.parse(b) : {}) });
  return send({ ok: true, message: 'Details being added.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    posts.length = 0;
    const page = await browser.newPage({ viewport });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.goto(`${base}/admin`);
    const navBtn = page.locator('nav.side button', { hasText: 'Submissions' });
    if (!(await navBtn.isVisible())) await page.locator('button[aria-label*="enu"]').first().click().catch(() => {});
    await navBtn.click();
    // Check email now (3 Nov): starts the ingest run, then reloads when the Ingest run finishes.
    await page.getByRole('button', { name: 'Check email now' }).click();
    await page.getByRole('button', { name: /Checking email/ }).waitFor();
    assert.ok(posts.some((x) => x.path === '/admin/api/ingest-now'), `${name}: Check email now posts ingest-now`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ingest-${name}.png`), fullPage: false });
    await page.getByRole('button', { name: 'Check email now' }).waitFor({ timeout: 30000 });
    posts.length = 0;
    const box = page.locator('section[aria-label="Already listed"]').first();
    await box.waitFor();
    const text = await box.innerText();
    assert.match(text, /Already listed: Autumn bring and buy coffee morning/, `${name}: banner names the listed entry`);
    assert.match(text, /This email adds: Entry is £3/, `${name}: says what's new`);
    assert.match(text, /told it is already on the website/, `${name}: says what the sender was told`);
    assert.equal(await page.locator('.badge', { hasText: 'Already listed' }).count() > 0, true, `${name}: badge`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `listed-${name}.png`), fullPage: false });
    // 4 Nov: no Approve (or Trust) button on an already listed item; a small link asks first.
    const card = page.locator('section[aria-label="Already listed"]').first().locator('xpath=..');
    assert.equal(await card.getByRole('button', { name: 'Approve', exact: true }).count(), 0, `${name}: no Approve button`);
    assert.equal(await card.getByRole('button', { name: 'Trust this source' }).count(), 0, `${name}: no Trust button`);
    const anyway = page.getByRole('button', { name: 'Publish as a new item…' }).first();
    if (SHOTS) { await anyway.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, `listed-actions-${name}.png`), fullPage: false }); }
    await anyway.click();
    assert.match(dialogs[0] || '', /Publish it as a new item anyway/, `${name}: the link asks first`);
    assert.equal(posts.length, 0, `${name}: dismissed link posts nothing`);
    await page.getByRole('button', { name: 'Add details' }).first().click();
    const body = page.locator('#mg-body');
    assert.match(await body.inputValue(), /Entry £3, including cake/, `${name}: Holly's proposal prefilled`);
    await page.locator('#mg-link_url').fill('https://example.org/flyer');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `listed-form-${name}.png`), fullPage: false });
    await page.locator('form').getByRole('button', { name: 'Add details' }).click();
    await page.waitForTimeout(300);
    const p = posts.find((x) => x.path === '/admin/api/action');
    assert.deepEqual([p.kind, p.id, p.action, p.fields.link_url], ['pending', 'n1-1', 'merge', 'https://example.org/flyer'], `${name}: posts merge with the fields`);
    assert.match(p.fields.body, /Entry £3/, `${name}: body sent`);
    await page.close();
  }
  console.log('ui-listed: all checks passed');
} finally {
  await browser.close();
  server.close();
}
