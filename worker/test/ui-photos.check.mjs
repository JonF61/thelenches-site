// worker/test/ui-photos.check.mjs
// Browser check of the admin panel's Photos list (ui/client.js) against a mock API, on
// desktop and phone sizes: after approve, Reject (into To delete), Undo, Move to… and
// Reload, the middle list keeps its scroll position and selection, and a selected photo
// that has gone gives way to the next one down. Also saves screenshots of the To delete
// view and the Past events filter (SHOTS=dir). Needs Playwright (not a site dependency):
// Run: node worker/test/ui-photos.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-photos: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

/* ------------------------------------------------------------ mock API -- */

const ROOT = 'rootFolder0001';
const folders = [
  { id: 'fGeneral', parent: ROOT, names: ['General'] },
  { id: 'fRous', parent: ROOT, names: ['Rous Lench'] },
  { id: 'fRousCh', parent: 'fRous', names: ['Rous Lench', 'Churches'] },
  { id: 'fRejected', parent: ROOT, names: ['Rejected'] },
];
function stateData() {
  const rows = [];
  for (let i = 1; i <= 40; i += 1) {
    const n = String(i).padStart(2, '0');
    rows.push({
      _row: i + 1, drive_id: `photoGeneral${n}`, path: 'General', village: '', subject: '', filename: `General photo ${n}.jpg`,
      status: 'new', people: 'none', alt_text: `Alt ${n}`, description: '', target: '', published_at: i === 7 ? '2026-10-01T05:00:00Z' : '',
      slug: i === 7 ? 'general-photo-07' : '', _waiting: true, _pages: i === 7 ? [{ label: 'Home page', url: 'https://thelenches.org.uk/' }] : [],
      _organiser: i <= 4 ? { event: `2026-10-0${i}|Harvest supper ${i}`, source_page: 'https://example.org/event', credit: 'Village hall', end: `2026-10-0${i}` }
        : i === 5 ? { event: '2026-10-20|Beer festival', source_page: '', credit: '', end: '2026-10-30' } : null,
    });
  }
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: ['id', 'people_ok'], rows: [] }, replies: { headers: [], rows: [] }, owed: [],
    photos: { headers: ['drive_id', 'status'], rows },
    photoFolders: folders, photosRoot: ROOT, today: '2026-10-24',
    toDelete: [
      { id: 'binnedDup0001', name: 'IMG_3113 (1).jpg', folderId: 'fBin', inside: '', from: { id: 'fGeneral', path: 'General', source: 'recorded' },
        movedAt: '2026-10-22T19:04:00Z', movedBy: 'panel', prevStatus: 'new' },
      { id: 'binnedChurch1', name: 'St Peter west door.jpg', folderId: 'fBin', inside: '', from: { id: 'fRousCh', path: 'Rous Lench / Churches', source: 'sheet' },
        movedAt: '2026-10-21', movedBy: 'run', prevStatus: '' },
      { id: 'binnedStray01', name: 'stray.pdf', folderId: 'fBin', inside: '', from: { error: 'Where it came from is not known: move it in Drive' }, movedAt: '', movedBy: '', prevStatus: '' },
    ],
  };
}
// Rows for the To delete files (the state lists every Photos row still in Drive).
function withBinRows(d) {
  d.photos.rows.push(
    { _row: 60, drive_id: 'binnedDup0001', path: 'General', filename: 'IMG_3113 (1).jpg', status: 'rejected', _waiting: false, _pages: [] },
    { _row: 61, drive_id: 'binnedChurch1', path: 'Rous Lench / Churches', filename: 'St Peter west door.jpg', status: 'rejected', published_at: '2026-09-02T05:41:00Z',
      slug: 'rous-lench-st-peter', _waiting: false, _pages: [{ label: 'Churches: St Peter', url: 'https://thelenches.org.uk/churches/#photo-rous-lench-st-peter' }] },
  );
  return d;
}

const posts = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname.startsWith('/admin/img/')) return send(PNG, 'image/png');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(withBinRows(stateData()));
  if (url.pathname === '/admin/api/photo-tidy') {
    return send({ ok: true, files: [
      { id: 'shot1', name: 'Screen Shot 2021-06-11 at 15.12.50.png', folderId: 'fRejected', path: 'Rejected', reason: 'In a Rejected folder', status: 'rejected', published: false, hasRow: true },
      { id: 'shot2', name: 'Screen Shot 2021-06-11 at 15.12.43.png', folderId: 'fRejected', path: 'Rejected', reason: 'In a Rejected folder', status: 'rejected', published: false, hasRow: true },
    ] });
  }
  if (url.pathname === '/admin/api/photo-file' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    return send({ ok: true, file: { id, name: `${id}.jpg`, folderId: 'fGeneral', folder: 'Lenches Photos / General', toDelete: false, published: false },
      folders: [{ id: ROOT, path: 'Lenches Photos' }, { id: 'fGeneral', path: 'Lenches Photos / General' }] });
  }
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  if (url.pathname === '/admin/api/action') return send({ ok: true, value: 'approved', message: 'Marked approved.' });
  if (url.pathname === '/admin/api/photo-file') {
    if (b.op === 'discard') return send({ ok: true, folderId: 'fBin', message: 'Moved to To delete and marked rejected.' });
    if (b.op === 'restore') return send({ ok: true, folderId: 'fGeneral', folder: 'Lenches Photos / General', status: 'new', message: 'Restored to General. Photos status back to new.' });
    if (b.op === 'move') {
      const f = folders.find((x) => x.id === b.to);
      return send({ ok: true, folderId: b.to, folder: `Lenches Photos / ${f.names.join(' / ')}` });
    }
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* -------------------------------------------------------------- checks -- */

const browser = await chromium.launch();
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };

async function open(viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${BASE}/admin`);
  await page.getByRole('button', { name: /^Photos/ }).click();
  return page;
}
// Where the list is: its scroll (desktop: the list pane; phone: the window) and the first
// card in view with its screen position.
const listTop = (page, wide) => page.evaluate((w) => {
  const l = document.querySelector('.main > .list');
  const top = w ? l.getBoundingClientRect().top : 0;
  const c = [...l.children].find((x) => x.getAttribute('data-key') && x.getBoundingClientRect().bottom > top + 1);
  const cards = {};
  for (const x of l.children) if (x.getAttribute('data-key')) cards[x.getAttribute('data-key')] = x.getBoundingClientRect().top;
  return { y: w ? l.scrollTop : window.scrollY, key: c && c.getAttribute('data-key'), top: c ? c.getBoundingClientRect().top : 0, cards };
}, wide);
const halfway = (page, wide) => page.evaluate((w) => {
  const l = document.querySelector('.main > .list');
  if (w) { l.scrollTop = (l.scrollHeight - l.clientHeight) / 2; return l.scrollTop; }
  window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) / 2);
  return window.scrollY;
}, wide);
// Kept = the card that was first in view is still where it was on screen (so a bar or a
// card gone above doesn't shift what you see); if that card itself went, the scroll is unchanged.
function near(after, before, what) {
  if (typeof before === 'number') before = { y: before, key: null };
  const at = before.key && after.cards[before.key];
  if (at !== undefined && before.key) assert.ok(Math.abs(at - before.top) <= 2, `${what}: ${before.key} moved from ${before.top} to ${at}`);
  else assert.ok(Math.abs(after.y - before.y) <= 2, `${what}: scroll ${after.y} should stay at ${before.y}`);
  assert.ok(after.y > 100, `${what}: not back at the top`);
}
const firstInView = (page, wide) => page.evaluate((w) => {
  const l = document.querySelector('.main > .list');
  const top = w ? l.getBoundingClientRect().top : 0;
  const c = [...l.children].find((x) => x.getAttribute('data-key') && x.getBoundingClientRect().bottom > top + 1);
  return c && c.getAttribute('data-key');
}, wide);

async function desktop() {
  const page = await open({ width: 1280, height: 800 });
  await page.locator('nav .tree [data-key="fGeneral"]').click();
  await page.locator('.list .card[data-key="photo:photoGeneral20"]').click();
  assert.ok(await halfway(page, true) > 200, 'list long enough to scroll');
  const y = await listTop(page, true);
  const anchor = await firstInView(page, true);

  // Approve (detail pane): position and selection kept; the unchanged cards are the same elements.
  await page.evaluate(() => { window.__mark = document.querySelector('.list .card[data-key="photo:photoGeneral30"]'); });
  await page.locator('.detail').getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction(() => document.querySelector('.list .card[data-key="photo:photoGeneral20"] .badge.info'));
  near(await listTop(page, true), y, 'after Approve');
  assert.equal(await firstInView(page, true), anchor);
  assert.equal(await page.evaluate(() => document.querySelector('.list .card[data-key="photo:photoGeneral30"]') === window.__mark), true, 'unchanged row updated in place, not redrawn');
  assert.equal(await page.locator('.list .card.sel').getAttribute('data-key'), 'photo:photoGeneral20');

  // Reject (into To delete): it leaves the folder view; the next one down is selected; position kept.
  const before = await listTop(page, true);
  await page.locator('.detail').getByRole('button', { name: 'Reject' }).click();
  await page.locator('.ask').getByRole('button', { name: 'Reject' }).click();
  await page.waitForFunction(() => !document.querySelector('.list [data-key="photo:photoGeneral20"]'));
  near(await listTop(page, true), before, 'after Reject');
  assert.equal(await page.locator('.list .card.sel').getAttribute('data-key'), 'photo:photoGeneral21', 'next one down selected');
  assert.equal(posts.at(-1).op, 'discard');

  // Undo (Restore): back in the list, position kept.
  await page.locator('.undo').getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => document.querySelector('.list [data-key="photo:photoGeneral20"]'));
  assert.equal(posts.at(-1).op, 'restore');
  near(await listTop(page, true), before, 'after Undo');

  // Move to… via the tick boxes (Rous Lench): gone from General, position kept, folders still open.
  await page.locator('nav .tree [data-key="fRous"] .tw').click();
  await page.locator('.list .card[data-key="photo:photoGeneral24"] .pick input').check();
  await page.locator('#pickbar').getByRole('button', { name: 'Move to…' }).click();
  const keepY = await listTop(page, true); // ticking may scroll the box into view
  await page.locator('.overlay .tree [data-key="fRousCh"]').click();
  await page.waitForFunction(() => !document.querySelector('.list [data-key="photo:photoGeneral24"]'));
  near(await listTop(page, true), keepY, 'after Move to…');
  assert.ok(await page.locator('nav .tree [data-key="fRousCh"]').isVisible(), 'expanded folder stays open');

  // Drag onto To delete: confirm, then gone; position kept.
  await page.locator('.list .card[data-key="photo:photoGeneral26"]').dragTo(page.locator('nav .tree [data-key="bin"]'));
  const dragY = await listTop(page, true);
  await page.locator('.ask').getByRole('button', { name: 'Move to To delete' }).click();
  await page.waitForFunction(() => !document.querySelector('.list [data-key="photo:photoGeneral26"]'));
  near(await listTop(page, true), dragY, 'after drag to To delete');

  // Reload: fresh state from the server, position and selection kept.
  const reloadY = await listTop(page, true);
  const sel = await page.locator('.list .card.sel').getAttribute('data-key');
  await page.locator('header').getByRole('button', { name: 'Reload' }).click();
  await page.waitForTimeout(400);
  near(await listTop(page, true), reloadY, 'after Reload');
  assert.equal(await page.locator('.list .card.sel').getAttribute('data-key'), sel);

  // Past events: organisers' images whose event ended before today (not the ongoing festival).
  await page.locator('nav .tree [data-key="past"]').click();
  const past = await page.locator('.list .card[data-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  assert.deepEqual(past, ['photo:photoGeneral01', 'photo:photoGeneral02', 'photo:photoGeneral03', 'photo:photoGeneral04']);
  await shot(page, 'past-events-desktop.png');
  await page.getByRole('button', { name: 'Move all 4 shown to To delete' }).click();
  assert.ok(await page.locator('.ask').isVisible(), 'always a confirm');
  await page.locator('.ask').getByRole('button', { name: 'Cancel' }).click();

  // To delete view.
  await page.locator('nav .tree [data-key="bin"]').click();
  await page.locator('.list .card[data-key="bin:binnedChurch1"]').click();
  await shot(page, 'to-delete-desktop.png');
  assert.ok(await page.locator('.detail').getByText('Still ON THE WEBSITE').isVisible());
  assert.ok(await page.locator('.detail').getByText('From: Rous Lench / Churches (from the Photos tab)').isVisible());
  await page.locator('.list .card[data-key="bin:binnedStray01"]').click();
  assert.ok(await page.locator('.detail').getByRole('button', { name: 'Restore' }).isDisabled());
  await page.getByRole('button', { name: /One-off tidy/ }).click();
  await page.locator('.overlay').getByText('Nothing has moved yet').waitFor();
  await shot(page, 'tidy-desktop.png');
  await page.close();
}

async function phone() {
  const page = await open({ width: 390, height: 844 });
  await page.locator('select[aria-label="Photo folder"]').selectOption('General');
  assert.ok(await halfway(page, false) > 200);
  const card = page.locator('.list > [data-key]').nth(Number(await page.evaluate(() => {
    const cs = [...document.querySelectorAll('.list > [data-key]')];
    return cs.findIndex((c) => c.getBoundingClientRect().top > 0);
  })));
  // Measured once the button is on screen (a click first scrolls it into view).
  const approve = card.getByRole('button', { name: 'Approve' });
  await approve.scrollIntoViewIfNeeded();
  const y = await listTop(page, false);
  await approve.click();
  await page.waitForTimeout(300);
  near(await listTop(page, false), y, 'phone: after Approve');
  const bin = card.getByRole('button', { name: 'Move to To delete' });
  await bin.scrollIntoViewIfNeeded();
  const y2 = await listTop(page, false);
  await bin.click();
  await page.locator('.ask').getByRole('button', { name: 'Move to To delete' }).click();
  await page.waitForTimeout(300);
  near(await listTop(page, false), y2, 'phone: after Move to To delete');

  await page.locator('select[aria-label="Photo folder"]').selectOption(':past');
  await shot(page, 'past-events-phone.png');
  await page.locator('select[aria-label="Photo folder"]').selectOption(':bin');
  await shot(page, 'to-delete-phone.png');
  await page.close();
}

try {
  await desktop();
  await phone();
  console.log('ui-photos: all passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
