// worker/test/ui-seo.check.mjs
// Browser check of the panel's SEO screen (ui/client.js, SEO step 7, 26 Nov 2026) against a mock API
// fed with a report from lib/seo.js, on desktop and phone sizes. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-seo.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-seo: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null, draft: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});
const { seoReport } = require('../../lib/seo.js');
const pg = (t, d, h1, links = '') => `<html><head><title>${t}</title><meta name="description" content="${d}"></head><body><h1>${h1}</h1>${links}</body></html>`;
const report = seoReport([
  { url: '/', html: pg('The Lenches — Church, Rous, Ab, Atch and Sheriffs Lench', 'Community website and free weekly newsletter for the five Lenches villages between Evesham and Pershore.', 'The Lenches', '<a href="/bins/">Bins</a>') },
  { url: '/bins/', html: pg('Bin collection days — Church Lench, Rous Lench and the Lenches', 'When bins are collected in the Lenches and what goes in each bin.', 'Bins', '<a href="/">Home</a>') },
], { '/': 'the Lenches', '/bins/': 'Lenches bin collection' }, { now: '2026-11-26T10:00:00Z' });
report.eventPages = 33;
report.console = { property: 'sc-domain:thelenches.org.uk', startDate: '2026-10-27', endDate: '2026-11-23',
  totals: { clicks: 40, impressions: 900, position: 12.3 },
  queries: [{ key: 'lenches bin collection', clicks: 5, impressions: 60, position: 3.2 }, { key: 'church lench', clicks: 4, impressions: 80, position: 6.1 }],
  pages: { '/bins/': { key: '/bins/', clicks: 9, impressions: 120, position: 4.5 } } };
const summary = {
  today: '2026-11-26', failing: [], devTasks: [], lessons: [], outreach: { seasonal: 0, quiet: 0, lead: 0 }, orgs: { due: 0, chase: 0 },
  coming: { events: [], roads: [] }, subscribers: { since: '2026-10-29', joined: 0, left: 0, total: 425 },
  visitors: { views: 0, visits: 0, days: [], pages: [] },
  issue: { date: '2026-12-03', deadline: '2026-12-02 18:00', deadlineAt: '2026-12-02T18:00:00.000Z', status: '', row: 0, onThisDay: 'x', events: 0, fresh: 0 },
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
  if (url.pathname === '/admin/api/seo') return send(report);
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
    if (name === 'phone') await page.locator('button.menu-btn, button[aria-label="Menu"]').first().click().catch(() => {});
    await page.locator('nav.side button', { hasText: /^SEO$/ }).click();
    const main = page.locator('.main');
    await main.locator('.seo-probs').first().waitFor();
    const text = await main.innerText();
    assert.match(text, /^How each page is set up for Google/m);
    assert.match(text, /2 pages checked, 1 page with something to look at\. 33 event pages too/);
    assert.match(text, /Search phrase not in the main heading/);
    assert.match(text, /All fine\./);
    assert.match(text, /Google search, Tue 27 Oct to Mon 23 Nov/);
    assert.match(text, /900 times shown in Google results, 40 clicks, average position 12\.3/);
    assert.match(text, /lenches bin collection\s+60\s+5\s+3\.2/);
    assert.match(text, /120 times shown, 9 clicks, position 4\.5/);
    assert.match(text, /Not shown in this period/);
    // The page with something to look at comes first.
    assert.equal(await main.locator('.card h2 a').first().innerText(), '/bins/');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `seo-${name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-seo: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
