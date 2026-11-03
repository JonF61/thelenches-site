// worker/test/ui-history.check.mjs
// Browser check of Submissions → Previous submissions and the Reject reason box (ui/client.js)
// against a mock API, on desktop and phone sizes. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-history.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';
import { submissionHistory } from '../src/admin/history.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-history: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const row = (n, extra = {}) => ({ _row: n + 1, id: 'm' + n + '-1', title: 'Item ' + n, category: 'notice', received: '2026-10-' + (10 + n) + ' 09:00',
  from: 'Ann Smith <ann@example.org>', message_id: 'm' + n, gmail_link: 'https://mail.google.com/mail/#all/m' + n, ...extra });
const hist = () => submissionHistory({
  pending: { headers: ['id', 'reject_reason'], rows: [
    row(2, { status: 'approved', category: 'event', title: 'Charity quiz — Church Lench Village Hall', village: 'Church Lench', event_date: '2026-11-20', decided_at: '2026-10-12 10:00' }),
    row(3, { status: 'rejected', title: 'Double glazing offer', decided_at: '2026-10-20 10:00', reject_reason: 'Commercial advert' }),
    row(4, { status: 'auto', title: 'Road closure — Ab Lench Road', decided_at: '', message_id: 'rss:a', source: 'one.network', gmail_link: 'https://one.network/?x', link_url: 'https://one.network/?x', end_date: '2026-11-30' }),
    row(5, { status: 'done', title: 'Harvest supper', decided_at: '2026-10-18 10:00', notes: 'Holly: already on the site' }),
    ...Array.from({ length: 30 }, (_, i) => row(40 + i, { status: 'approved', received: '2026-09-01 09:00', decided_at: '2026-09-02 09:00', title: 'Old notice ' + i })),
  ] },
  issues: { rows: [{ issue_date: '2026-10-16', status: 'sent', item_keys: 'p:m2-1 p:m4-1' }, { issue_date: '2026-10-23', status: 'sent', item_keys: 'p:m2-1' }] },
  feedback: { rows: [{ item_id: 'm2-1', outcome: 'edited', draft: '{"title":"Quiz"}', final: '{"title":"Charity quiz — Church Lench Village Hall"}' }] },
  today: '2026-11-03',
});
const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: { Pending: 1 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: ['people_ok'], rows: [{ _row: 2, id: 'm9-1', title: 'Coffee morning', status: 'pending', category: 'notice', summary: 'Tea and cake.', received: '2026-11-02 09:00' }] },
  replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-03', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
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
  if (url.pathname === '/admin/api/history') return send(hist());
  if (req.method === 'GET') return send({});
  let b = '';
  for await (const ch of req) b += ch;
  posts.push({ path: url.pathname, ...(b ? JSON.parse(b) : {}) });
  return send({ ok: true, message: 'Rejected.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    posts.length = 0;
    const page = await browser.newPage({ viewport });
    await page.goto(`${base}/admin`);
    const navBtn = page.locator('nav.side button', { hasText: 'Submissions' });
    if (!(await navBtn.isVisible())) await page.locator('button[aria-label*="enu"]').first().click().catch(() => {});
    await navBtn.click();
    // Reject with a reason.
    await page.getByRole('button', { name: 'Reject', exact: true }).first().click();
    await page.locator('#irj').fill('Not in the Lenches');
    await page.locator('form').getByRole('button', { name: 'Reject' }).click();
    await page.waitForTimeout(300);
    const p = posts.find((x) => x.path === '/admin/api/action');
    assert.deepEqual([p.kind, p.id, p.action, p.reason], ['pending', 'm9-1', 'reject', 'Not in the Lenches'], `${name}: reject posts the reason`);
    // Previous submissions.
    await page.getByRole('button', { name: 'Previous submissions' }).click();
    await page.locator('.hi-card').first().waitFor();
    const quiz = page.locator('.hi-card', { hasText: 'Charity quiz' });
    assert.ok(await quiz.getByText('Events page').count(), `${name}: website window`);
    assert.ok(await quiz.getByText(/showing now/).count(), `${name}: showing now`);
    assert.ok(await quiz.getByText(/Fri 16 Oct, Fri 23 Oct/).count(), `${name}: newsletter issues`);
    assert.ok(await quiz.getByText(/Your changes: title/).count(), `${name}: edits`);
    assert.ok(await page.locator('.hi-card', { hasText: 'Double glazing' }).getByText('Commercial advert').count(), `${name}: reject reason`);
    assert.ok(await page.locator('.hi-card', { hasText: 'Road closure' }).getByText(/Roads page/).count(), `${name}: roads`);
    assert.equal(await page.locator('.hi-card').count(), 25, `${name}: 25 at a time`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `history-${name}.png`), fullPage: false });
    await page.getByRole('button', { name: /Show older/ }).click();
    assert.equal(await page.locator('.hi-card').count(), 34, `${name}: show older`);
    await page.locator('[aria-label=Outcome]').getByRole('button', { name: 'Rejected' }).click();
    assert.equal(await page.locator('.hi-card').count(), 1, `${name}: rejected filter`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${name}: no sideways scroll (${overflow}px)`);
    await page.close();
  }
  console.log('ui-history: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
