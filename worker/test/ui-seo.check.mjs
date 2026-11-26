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

const { linkPartners } = await import('../src/admin/links.mjs');
const LH = ['id', 'name', 'type', 'url', 'status', 'link_found_at', 'last_checked', 'check', 'notes', 'email', 'asked_at'];
const links = linkPartners({ headers: LH, rows: [
  { id: 'rous-lench', name: 'Rous Lench village website', type: 'Village website', url: 'https://rouslench.com/', status: 'Linking', link_found_at: 'https://rouslench.com/', last_checked: '2026-11-30', check: 'Links to us' },
  { id: 'arch', name: 'ARCH Benefice', type: 'Church', url: 'https://www.archbenefice.org.uk/', status: 'To ask', last_checked: '2026-11-30', check: 'No link found', email: 'office@arch.example' },
  { id: 'visit', name: 'Visit Evesham', type: 'Directory', url: '', status: '', check: 'No website address yet', notes: 'Website address to find' },
] }, [], '2026-11-30');
// Rankings (Ahrefs Rank Tracker, admin/rankings.js shape).
const R = (m, mp, d, dp, page, vol) => ({ location: 'Evesham', volume: vol, updated: '2026-11-25T04:00:00Z',
  mobile: { position: m, prev: mp, page }, desktop: { position: d, prev: dp, page } });
const ranks = { project: { id: 2, name: 'Thelenches', url: 'https://thelenches.org.uk/' }, date: '2026-11-26', compared: '2026-11-19',
  updated: '2026-11-25T04:00:00Z', units: 100, keywords: [
    { keyword: 'the Lenches', ...R(1, 1, 1, 2, '/', 90) },
    { keyword: 'Lenches bin collection', ...R(2, 3, 3, 3, '/living-here/bins/', 10) },
    { keyword: 'Lenches church services', ...R(4, null, 5, 7, '/living-here/churches/', 0) },
    { keyword: 'events near Evesham', ...R(14, 11, 18, 18, '/events/', 320) },
    { keyword: 'pubs near Evesham', ...R(null, 40, null, null, '', 600) },
  ] };
const serp = { keyword: 'Lenches bin collection', device: 'mobile', location: 'Evesham', units: 30, positions: [
  { position: 1, url: 'https://www.wychavon.gov.uk/bins', title: 'Bin collections | Wychavon District Council', type: 'organic', ours: false },
  { position: 2, url: 'https://thelenches.org.uk/living-here/bins/', title: 'Bin collection days — the Lenches', type: 'organic', ours: true },
  { position: 3, url: 'https://www.facebook.com/groups/lenches', title: 'Lenches Community | Facebook', type: 'organic', ours: false },
] };
const edits = [];
const asks = [];
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
  if (url.pathname === '/admin/api/links') return send(links);
  if (url.pathname === '/admin/api/rankings') return send(url.searchParams.get('serp') ? { ...serp, keyword: url.searchParams.get('serp'), device: url.searchParams.get('device') } : ranks);
  if (url.pathname === '/admin/api/link-ask') {
    const b = JSON.parse(await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }));
    asks.push(b.id);
    return send({ ok: true, kind: 'request', message: 'Request requested. It appears under Replies in a minute or two.' });
  }
  if (url.pathname === '/admin/api/link-edit') {
    const b = JSON.parse(await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }));
    edits.push(b);
    return send({ ok: true, value: b.value, message: 'Saved.' });
  }
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
    // Rankings (the first sub-page): best first, moves against a week ago, a phrase's top 10.
    await main.locator('table.ranks').waitFor();
    let text = await main.innerText();
    assert.match(text, /^How the site does in Google/m);
    assert.match(text, /5 search phrases: 3 on the first page of Google on a phone, 3 on a computer\. Compared with Thu 19 Nov; Ahrefs last checked Wed 25 Nov\./);
    assert.match(text, /Lenches bin collection\s+Evesham\s+2 ▲1\s+3\s/);
    assert.match(text, /Lenches church services\s+Evesham\s+4 New\s+5 ▲2/);
    assert.match(text, /events near Evesham\s+Evesham\s+14 ▼3/);
    assert.match(text, /pubs near Evesham\s+Evesham\s+Not in top 100 ▼ was 40\s+Not in top 100/);
    await main.locator('tr', { hasText: 'Lenches bin collection' }).locator('button', { hasText: 'Phone' }).click();
    await main.locator('.serp-list li.ours').waitFor();
    text = await main.innerText();
    assert.match(text, /Google’s top 10 on a phone, from Evesham/);
    assert.match(text, /Bin collections \| Wychavon District Council www\.wychavon\.gov\.uk\/bins/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `seo-ranks-${name}.png`), fullPage: true });
    // Search Console.
    await main.locator('button', { hasText: 'Search Console' }).click();
    await main.locator('text=Pages in Google').waitFor();
    text = await main.innerText();
    assert.match(text, /Google search, Tue 27 Oct to Mon 23 Nov/);
    assert.match(text, /900 times shown in Google results, 40 clicks, average position 12\.3/);
    assert.match(text, /lenches bin collection\s+60\s+5\s+3\.2/);
    assert.match(text, /\/bins\/\s+120\s+9\s+4\.5/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `seo-console-${name}.png`), fullPage: true });
    // On-page SEO.
    await main.locator('button', { hasText: 'On-page SEO' }).click();
    await main.locator('.seo-probs').first().waitFor();
    text = await main.innerText();
    assert.match(text, /2 pages checked, 1 page with something to look at\. 33 event pages too/);
    assert.match(text, /Search phrase not in the main heading/);
    assert.match(text, /All fine\./);
    assert.match(text, /120 times shown, 9 clicks, position 4\.5/);
    assert.match(text, /Not shown in this period/);
    assert.equal(await main.locator('.card h2 a').first().innerText(), '/bins/');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `seo-onpage-${name}.png`), fullPage: true });
    // Inbound links: to ask first, then linking; status change and notes save.
    await main.locator('button', { hasText: 'Inbound links' }).click();
    await main.locator('.link-card').first().waitFor();
    text = await main.innerText();
    assert.match(text, /2 to ask · 1 linking\. Last checked Mon 30 Nov; checked each Monday morning\./);
    assert.match(text, /✓ Linking/);
    assert.match(text, /Link found on: rouslench\.com\//);
    assert.match(text, /No link found · checked Mon 30 Nov/);
    assert.match(text, /no website address yet/);
    const names = await main.locator('.link-card h2').allInnerTexts();
    assert.match(names[names.length - 1], /Rous Lench/, 'linking partners after those to ask');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `seo-links-${name}.png`), fullPage: true });
    await main.locator('select[aria-label="Status for ARCH Benefice"]').selectOption('Asked');
    await main.locator('.link-card', { hasText: 'ARCH Benefice' }).locator('.badge', { hasText: 'Asked' }).waitFor();
    const e1 = edits[edits.length - 1];
    assert.deepEqual([e1.id, e1.field, e1.value, e1.expected], ['arch', 'status', 'Asked', 'To ask']);
    // Draft request only where there is an email address.
    assert.equal(await main.locator('.link-card', { hasText: 'Visit Evesham' }).locator('button', { hasText: 'Draft request' }).count(), 0);
    const arch = main.locator('.link-card', { hasText: 'ARCH Benefice' });
    await arch.locator('button', { hasText: 'Draft request' }).click();
    await arch.locator('text=Request waiting for you in Replies').waitFor();
    assert.equal(asks[asks.length - 1], 'arch');
    assert.equal(await arch.locator('button', { hasText: 'Draft request' }).count(), 0);
    const visit = main.locator('.link-card', { hasText: 'Visit Evesham' });
    await visit.locator('button', { hasText: 'Edit notes' }).click();
    await visit.locator('textarea').fill('Try their contact form');
    await visit.locator('button', { hasText: 'Save' }).click();
    await visit.locator('text=Notes: Try their contact form').waitFor();
    const e2 = edits[edits.length - 1];
    assert.deepEqual([e2.id, e2.field, e2.value, e2.expected], ['visit', 'notes', 'Try their contact form', 'Website address to find']);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-seo: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
