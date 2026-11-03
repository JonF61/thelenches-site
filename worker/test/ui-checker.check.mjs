// worker/test/ui-checker.check.mjs
// Browser check of the Checker (ui/client.js checkerCard) against a mock API, on desktop and
// phone sizes: Summary lists the open findings with Dismiss (one POST, finding gone), Health shows
// the card with its three Check buttons, and Check posts the scope and shows the new findings.
// Saves screenshots (SHOTS=dir). Run: node worker/test/ui-checker.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-checker: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null, draft: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});
const summary = {
  today: '2026-11-02', failing: [], devTasks: [], lessons: [], outreach: { seasonal: 0, quiet: 0, lead: 0 }, orgs: { due: 0, chase: 0 },
  coming: { events: [], roads: [] }, subscribers: { since: '2026-10-29', joined: 0, left: 0, total: 425 },
  visitors: { views: 120, visits: 40, days: [{ date: '2026-11-01', views: 27, visits: 9 }], pages: [] },
  issue: { date: '2026-11-05', deadline: '2026-11-04 18:00', deadlineAt: '2026-11-04T18:00:00.000Z', status: '', row: 0, onThisDay: 'x', events: 0, fresh: 0 },
  lastSent: null,
};
const F = (id, scope, severity, page, where, problem, extra = {}) => ({ id, created_at: '2026-11-01 19:17', scope, target: '', page, where, severity, problem, quote: '', suggestion: '', ...extra });
let checker;
let posts;
const reset = () => {
  posts = [];
  checker = {
    last: { newsletter: '2026-11-01 18:37', listings: '2026-11-01 19:17' },
    open: [
      F('K1-n1', 'newsletter', 'problem', 'newsletter', 'Website update', 'The same two pages are announced twice.', { quote: 'There are two new pages', suggestion: 'Remove one of the two.' }),
      F('K1-l1', 'listings', 'check', '/events/', 'Quiz night', 'Saturday 7 November is a Saturday but the body says Friday.', { quote: 'Friday 7 November' }),
    ],
  };
};
reset();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.method === 'POST') {
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(JSON.parse(b || '{}'))); });
    posts.push([url.pathname, body]);
    if (url.pathname === '/admin/api/checker-dismiss') {
      checker.open = checker.open.filter((f) => f.id !== body.id);
      return send({ ok: true, message: 'Dismissed' });
    }
    if (url.pathname === '/admin/api/checker-run') {
      setTimeout(() => {
        checker.last = { ...checker.last, [body.scope]: '2026-11-02 10:00' };
        checker.open.push(F('K2-s1', body.scope, 'problem', '/bins/', 'Bin days', 'Two different collection days are given.'));
      }, 100);
      return send({ ok: true, message: 'Checking' });
    }
    return send({ ok: false }, 'application/json', 404);
  }
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/summary') return send(summary);
  if (url.pathname === '/admin/api/checker') return send(checker);
  return send({ error: 'nf' }, 'application/json', 404);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    reset();
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Speed up the 15-20 second polling for the check.
    await page.addInitScript(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, Math.min(ms, 200), ...a); });
    await page.goto(`${base}/admin`);
    const main = page.locator('.main');
    const card = main.locator('.card.checker');
    await card.locator('.finding').first().waitFor();
    let text = await card.innerText();
    assert.match(text, /Checker \(2\)/);
    assert.match(text, /Problem\s+Website update\s+The same two pages are announced twice\.\s+"There are two new pages"\s+Suggested fix: Remove one of the two\./);
    assert.match(text, /Check\s+\/events\/ · Quiz night/);
    assert.match(text, /Newsletter last checked/);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `checker-summary-${name}.png`), fullPage: true });
    await card.locator('.finding', { hasText: 'Quiz night' }).locator('button', { hasText: 'Dismiss' }).click();
    await card.locator('.finding', { hasText: 'Quiz night' }).waitFor({ state: 'detached' });
    assert.deepEqual(posts.at(-1), ['/admin/api/checker-dismiss', { id: 'K1-l1' }]);
    assert.match(await card.innerText(), /Checker \(1\)/);

    // Health: the card with all three buttons; Check whole site shows the new finding.
    await page.locator('button', { hasText: 'Diagnostic' }).first().click();
    const hc = main.locator('.card.checker');
    await hc.waitFor();
    for (const b of ['Check newsletter', 'Check listings', 'Check whole site']) assert.equal(await hc.locator('button', { hasText: b }).count(), 1, b);
    await hc.locator('button', { hasText: 'Check whole site' }).click();
    await hc.locator('.finding', { hasText: 'Two different collection days' }).waitFor();
    assert.deepEqual(posts.find((p) => p[0] === '/admin/api/checker-run'), ['/admin/api/checker-run', { scope: 'site' }]);
    assert.match(await hc.innerText(), /Whole site last checked/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `checker-health-${name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-checker: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
