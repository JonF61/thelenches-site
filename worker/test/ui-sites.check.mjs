// worker/test/ui-sites.check.mjs
// Browser check of the panel's site switcher (Harvington stage 4c-1, ui/client.js) against a
// mock API, on desktop and phone sizes: the top bar shows each site's name and colour; every API
// call carries x-site for the site the tab shows; choosing the other site reopens the panel for
// it (?site=) and remembers it; the Lenches-only screens (Newsletter draft and stats, Site
// visitors, Photos) are not in Harvington's menu. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-sites.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';
import { siteList } from '../src/sites.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-sites: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const NAMES = { lenches: 'The Lenches', harvington: 'Harvington' };

const stateData = (site) => ({
  email: 'admin@example.org', site, sheetId: `sheet-${site}`, gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [{ _row: 2, id: `${site}-1`, status: 'pending', category: 'event', title: `A ${site} event`, summary: 'x' }] },
  replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: site === 'lenches' ? 'r' : '', today: '2026-11-16', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});

const seen = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  const site = req.headers['x-site'] || '';
  seen.push({ path: url.pathname, site });
  if (!NAMES[site]) return send({ error: 'Unknown site' }, 'application/json', 400);
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c', site, siteName: NAMES[site], sites: siteList() });
  if (url.pathname === '/admin/api/state') return send(stateData(site));
  if (url.pathname === '/admin/api/summary') return send({ today: '2026-11-16', devTasks: [] });
  return send({ ok: true });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    seen.length = 0;

    // First visit: the Lenches, its name in the top bar, the full menu.
    await page.goto(`${base}/admin`);
    await page.locator('header.top h1', { hasText: 'The Lenches admin' }).waitFor();
    assert.match(page.url(), /\?site=lenches/, 'the address keeps the site, so a reload stays put');
    const sw = page.locator('.site-switch');
    assert.deepEqual(await sw.locator('button').allInnerTexts(), ['The Lenches', 'Harvington']);
    assert.equal(await sw.locator('button.on').innerText(), 'The Lenches');
    assert.ok(seen.length && seen.every((s) => s.site === 'lenches'), JSON.stringify(seen));
    const menu = async () => page.locator('nav.side button').allInnerTexts();
    if (name === 'desktop') assert.ok((await menu()).some((t) => /^Photos/.test(t)));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sites-lenches-${name}.png`) });

    // Switch: the panel reopens for Harvington, in its colour, and every call says so.
    seen.length = 0;
    await sw.getByRole('button', { name: 'Harvington' }).click();
    await page.locator('header.top h1', { hasText: 'Harvington admin' }).waitFor();
    assert.match(page.url(), /\?site=harvington/);
    assert.equal(await page.title(), 'Harvington admin');
    assert.ok(seen.length && seen.every((s) => s.site === 'harvington'), JSON.stringify(seen));
    const border = await page.locator('header.top').evaluate((el) => getComputedStyle(el).borderTopColor);
    assert.equal(border, 'rgb(45, 74, 99)', 'Harvington river blue');
    if (name === 'desktop') {
      const items = await menu();
      for (const gone of ['Newsletter draft', 'Newsletter stats', 'Site visitors', 'Photos']) assert.ok(!items.some((t) => t.startsWith(gone)), gone);
      assert.ok(items.some((t) => t.startsWith('Submissions')));
      await page.locator('nav.side button', { hasText: 'Submissions' }).click();
      await page.getByText('A harvington event').first().waitFor();
    }
    assert.equal(await page.locator('.chip button', { hasText: 'Draft' }).count(), 0, 'no newsletter draft link for Harvington');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sites-harvington-${name}.png`) });

    // Remembered: a new visit with no ?site opens Harvington.
    seen.length = 0;
    await page.goto(`${base}/admin`);
    await page.locator('header.top h1', { hasText: 'Harvington admin' }).waitFor();
    assert.ok(seen.every((s) => s.site === 'harvington'));

    // A second tab can show the Lenches while this one stays on Harvington.
    const other = await ctx.newPage();
    await other.goto(`${base}/admin?site=lenches`);
    await other.locator('header.top h1', { hasText: 'The Lenches admin' }).waitFor();
    seen.length = 0;
    await page.getByRole('button', { name: 'Reload' }).click();
    await page.locator('.toast').waitFor();
    assert.ok(seen.length && seen.every((s) => s.site === 'harvington'), 'the first tab keeps its site');

    // A remembered site that no longer exists falls back to the Lenches.
    await page.evaluate(() => localStorage.setItem('panelSite', 'gone'));
    await page.goto(`${base}/admin`);
    await page.locator('header.top h1', { hasText: 'The Lenches admin' }).waitFor();
    await ctx.close();
  }
  console.log('ui-sites: all checks passed');
} finally {
  await browser.close();
  server.close();
}
