// worker/test/ui-stats.check.mjs
// Browser check of the panel's Newsletter stats screen (ui/client.js) against a mock API, on
// desktop and phone sizes: the issues table, picking an issue, opens by day and busiest
// hours, the most-clicked links, and the Summary's Last newsletter line. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-stats.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-stats: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null, draft: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});
const issues = [
  { date: '2026-10-29', sent: 425, bounced: 2, opens: 231, clicks: 64 },
  { date: '2026-10-22', sent: 420, bounced: 0, opens: null, clicks: null },
];
const detail = (date) => (date === '2026-10-22'
  ? { date, days: [], hours: [], links: [] }
  : { date, days: [{ day: '2026-10-29', n: 168 }, { day: '2026-10-30', n: 41 }], hours: [{ hour: 8, n: 74 }, { hour: 9, n: 39 }, { hour: 19, n: 18 }],
    links: [{ url: 'https://thelenches.org.uk/events/', n: 41 }, { url: 'https://thevaleworcestershire.co.uk/upcoming-events/terror-lies-ahead/', n: 9 }] });
const summary = {
  today: '2026-11-02', failing: [], devTasks: [], lessons: [], outreach: { seasonal: 0, quiet: 0, lead: 0 }, orgs: { due: 0, chase: 0 },
  coming: { events: [], roads: [] }, subscribers: { since: '2026-10-29', joined: 0, left: 0, total: 425 }, visitors: { off: true },
  issue: { date: '2026-11-05', deadline: '2026-11-04 18:00', deadlineAt: '2026-11-04T18:00:00.000Z', status: '', row: 0, onThisDay: 'x', events: 0, fresh: 0 },
  lastSent: issues[0],
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
  if (url.pathname === '/admin/api/nlstats') return send({ on: true, issues, detail: detail(url.searchParams.get('i') || '2026-10-29') });
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
    await main.locator('.card.sum', { hasText: 'Last newsletter' }).waitFor();
    assert.match(await main.innerText(), /Last newsletter: Thu 29 Oct[\s→]*425 sent, 2 bounced, ~231 opens, 64 clicks/);
    await main.locator('button.sum-h', { hasText: 'Last newsletter' }).click();
    await main.locator('table.nlstats').waitFor();
    await main.locator('h3', { hasText: 'Most-clicked links' }).waitFor();
    const text = await main.innerText();
    assert.match(text, /^How each newsletter did/m);
    assert.match(text, /Thu 29 Oct\s+425\s+2\s+231\s+64/);
    assert.match(text, /Thu 22 Oct\s+420\s+0\s+–\s+–/);
    assert.match(text, /Opens by day: Thu 29 Oct 168 · Fri 30 Oct 41/);
    assert.match(text, /Busiest hours: 8–9am 74 · 9–10am 39 · 7–8pm 18/);
    assert.match(text, /41\s+thelenches\.org\.uk\/events\//);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `stats-${name}.png`), fullPage: true });
    // Picking another issue.
    await main.locator('table.nlstats tr', { hasText: 'Thu 22 Oct' }).click();
    await main.locator('h2', { hasText: 'Thu 22 Oct' }).waitFor();
    assert.match(await main.innerText(), /No opens counted yet\.[\s\S]*No clicks counted yet\./);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-stats: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
