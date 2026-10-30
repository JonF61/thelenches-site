// worker/test/ui-visitors.check.mjs
// Browser check of the panel's Site visitors screen (ui/client.js) against a mock API, on
// desktop and phone sizes: opened from the Summary's Visitors heading, the day bars and table,
// month totals, and picking a month for its top pages. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-visitors.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-visitors: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null, draft: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});
const days = [];
for (let i = 0; i < 40; i += 1) {
  const d = new Date(Date.UTC(2026, 10, 2) - i * 86400000).toISOString().slice(0, 10);
  days.push({ date: d, views: 20 + (i * 7) % 30, visits: 8 + i % 5, pages: [{ path: '/', views: 10 }], today: i === 0 || undefined });
}
const months = [
  { month: '2026-11', views: 41, visits: 17, days: 2, busiest: { date: '2026-11-01', views: 27 }, pages: [{ path: '/', views: 20 }, { path: '/bins/', views: 9 }] },
  { month: '2026-10', views: 900, visits: 300, days: 31, busiest: { date: '2026-10-29', views: 49 }, pages: [{ path: '/events/', views: 210 }] },
];
const summary = {
  today: '2026-11-02', failing: [], devTasks: [], lessons: [], outreach: { seasonal: 0, quiet: 0, lead: 0 }, orgs: { due: 0, chase: 0 },
  coming: { events: [], roads: [] }, subscribers: { since: '2026-10-29', joined: 0, left: 0, total: 425 },
  visitors: { views: 120, visits: 40, days: [{ date: '2026-11-01', views: 27, visits: 9 }], pages: [] },
  issue: { date: '2026-11-05', deadline: '2026-11-04 18:00', deadlineAt: '2026-11-04T18:00:00.000Z', status: '', row: 0, onThisDay: 'x', events: 0, fresh: 0 },
  lastSent: null,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/summary') return send(summary);
  if (url.pathname === '/admin/api/site-visitors') return send({ days, months, todayError: '' });
  return send({ error: 'nf' }, 'application/json', 404);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/admin`);
    const main = page.locator('.main');
    await main.locator('button.sum-h', { hasText: 'Visitors' }).click();
    await main.locator('.sv-bars').waitFor();
    assert.equal(await main.locator('.sv-bar').count(), 30);
    assert.equal(await main.locator('.sv-bar.today').count(), 1);
    const text = await main.innerText();
    assert.match(text, /^How many people use the website/m);
    assert.match(text, /Mon 2 Nov \(so far\)\s+20\s+8/);
    assert.match(text, /November 2026\s+41\s+17\s+2\s+Sun 1 Nov \(27\)/);
    assert.match(text, /October 2026\s+900\s+300\s+31\s+Thu 29 Oct \(49\)/);
    assert.match(text, /Most viewed pages: November 2026[\s\S]*9\s+\/bins\//);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `visitors-${name}.png`), fullPage: true });
    await main.locator('table.nlstats tr', { hasText: 'October 2026' }).click();
    await main.locator('h2', { hasText: 'Most viewed pages: October 2026' }).waitFor();
    assert.match(await main.innerText(), /210\s+\/events\//);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-visitors: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
