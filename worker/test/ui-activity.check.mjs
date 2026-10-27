// worker/test/ui-activity.check.mjs
// Browser check of the panel's Activity screen (ui/client.js) against a mock API, on desktop
// and phone sizes: plain names, status icons, a failed row in red, links to GitHub, and the
// 15-second refresh. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-activity.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-activity: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: { 'Holly lessons': 9 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
let calls = 0;
const runs = () => ({ runs: [
  { id: 1, name: 'Build site', title: 'Page edit: privacy.njk (1 change, from the admin panel)', event: 'after a change', status: 'in_progress', conclusion: '', started: iso(42000), updated: iso(1000), url: 'https://github.com/o/r/actions/runs/1' },
  { id: 2, name: 'Ingest', title: 'Ingest Pipeline label', event: 'started by the Worker', status: 'completed', conclusion: 'success', started: iso(600000), updated: iso(535000), url: 'https://github.com/o/r/actions/runs/2' },
  { id: 3, name: 'Newsletter', title: 'Newsletter', event: 'started by hand', status: 'completed', conclusion: 'failure', started: iso(3600000), updated: iso(3588000), url: 'https://github.com/o/r/actions/runs/3' },
  { id: 4, name: 'Publish', title: 'Publish', event: 'after another run', status: 'completed', conclusion: 'cancelled', started: iso(700000), updated: iso(690000), url: 'https://github.com/o/r/actions/runs/4' },
] });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/runs') { calls += 1; return send(runs()); }
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
    await page.clock.install();
    await page.goto(`${base}/admin`);
    await page.locator('nav.side button', { hasText: 'Activity' }).click();
    const main = page.locator('.main');
    await main.locator('table.runs').waitFor();
    const text = await main.innerText();
    assert.match(text, /^What the website's automatic jobs/m);
    assert.match(text, /Build site[\s\S]*Page edit: privacy\.njk[\s\S]*running/);
    assert.match(text, /Newsletter[\s\S]*failed/);
    assert.equal(await main.locator('tr.run-bad').count(), 1, 'one red row');
    assert.equal(await main.locator('tr.run-on').count(), 1, 'one running row');
    assert.equal(await main.locator('a[href="https://github.com/o/r/actions/runs/3"][target="_blank"]').count(), 1);
    assert.match(text, /cancelled/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `activity-${name}.png`), fullPage: true });
    const before = calls;
    await page.clock.runFor(16000);
    await page.waitForTimeout(300);
    assert.ok(calls > before, 'refreshed after 15 seconds');
    // Leaving the screen stops the refresh.
    await page.locator('nav.side button', { hasText: 'Health' }).click();
    const left = calls;
    await page.clock.runFor(31000);
    await page.waitForTimeout(300);
    assert.equal(calls, left, 'no refresh on other screens');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-activity: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
