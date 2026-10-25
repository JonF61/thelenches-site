// worker/test/ui-photo-names.check.mjs
// Browser check of the Photos rename box (ui/client.js) against a mock API: the New name
// box is pre-filled with the photos run's suggested_name (with its "Will be saved as"),
// and left empty when the name is fine ('-'), not yet checked, or renamed in Drive since
// the run; Rename with an empty box sends nothing. Saves a screenshot (SHOTS=dir).
// Needs Playwright (not a site dependency). Run: node worker/test/ui-photo-names.check.mjs
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
  console.log('ui-photo-names: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

const ROOT = 'rootFolder0001';
// drive_id: [Photos-tab filename, suggested_name, name in Drive now]
const PHOTOS = {
  suggested: ['IMG_1234.jpg', 'Church Lench in snow', 'IMG_1234.jpg'],
  fine: ['St Peter west door.jpg', '-', 'St Peter west door.jpg'],
  unchecked: ['PXL_20260101_101010.jpg', '', 'PXL_20260101_101010.jpg'],
  renamed: ['WhatsApp Image 2026-01-01.jpg', 'Bonfire night', 'Bonfire on the green.jpg'],
};
function stateData() {
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [],
    photos: { headers: ['drive_id', 'status'], rows: Object.entries(PHOTOS).map(([id, [filename, suggested_name]], i) => ({
      _row: i + 2, drive_id: id, path: 'General', village: '', subject: '', filename, suggested_name,
      status: 'new', people: 'none', alt_text: 'Alt', _waiting: true, _pages: [], _organiser: null,
    })) },
    photoFolders: [{ id: 'fGeneral', parent: ROOT, names: ['General'] }], photosRoot: ROOT, today: '2026-10-25', toDelete: [],
  };
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
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/photo-name') return send({ ok: true, name: `${url.searchParams.get('name')}.jpg`, wanted: '', numbered: false });
  if (url.pathname === '/admin/api/photo-file' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    return send({ ok: true, file: { id, name: PHOTOS[id][2], folderId: 'fGeneral', folder: 'Lenches Photos / General', toDelete: false, published: false },
      folders: [{ id: ROOT, path: 'Lenches Photos' }, { id: 'fGeneral', path: 'Lenches Photos / General' }] });
  }
  let body = '';
  for await (const c of req) body += c;
  posts.push({ path: url.pathname, ...(body ? JSON.parse(body) : {}) });
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => { throw e; });
  await page.goto(`${BASE}/admin`);
  await page.getByRole('button', { name: /^Photos/ }).click();

  async function select(id) {
    await page.locator(`[data-key="photo:${id}"]`).click();
    const box = page.locator(`.detail #fn-${id}`);
    await box.waitFor();
    return box;
  }

  const sug = await select('suggested');
  assert.equal(await sug.inputValue(), 'Church Lench in snow');
  await page.locator('.detail').getByText('Will be saved as Church Lench in snow.jpg').waitFor();
  assert.ok(await page.locator('.detail').getByText('Suggested from the picture').isVisible());
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await sug.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'photo-name-suggested.png') }); }

  for (const id of ['fine', 'unchecked', 'renamed']) {
    const box = await select(id);
    assert.equal(await box.inputValue(), '', `${id}: empty`);
    assert.equal(await box.getAttribute('placeholder'), 'Type a new name');
    assert.equal(await page.locator('.detail').getByText('Suggested from the picture').count(), 0, `${id}: no suggestion note`);
  }
  await page.locator('.detail').getByRole('button', { name: 'Rename' }).click();
  await page.getByText('Type a new name first').waitFor();
  assert.equal(posts.filter((p) => p.op === 'rename').length, 0, 'empty box: nothing renamed');
  console.log('ui-photo-names: all passed');
} finally {
  await browser.close();
  server.close();
}
