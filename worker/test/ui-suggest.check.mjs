// worker/test/ui-suggest.check.mjs
// Browser check of the Queue card's "Suggested images" strip (ui/client.js) against a mock
// API, on desktop and phone sizes: the three labels, credits and the Pexels link, Choose on
// a people-flagged image held until "People OK" is ticked, Choose and "None of these" posting
// the stale-check value, and no image loaded from outside (thumbnails are data: JPEGs).
// Saves screenshots (SHOTS=dir). Needs Playwright (not a site dependency):
// Run: node worker/test/ui-suggest.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-suggest: Playwright not installed here, skipped');
  process.exit(0);
}
const sharp = require('sharp');
const SHOTS = process.env.SHOTS || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Thumbnails as the run makes them: small JPEG data: addresses.
async function thumb(file, tint) {
  const img = file ? sharp(path.join(ROOT, 'src', 'images', 'photos', file))
    : sharp({ create: { width: 640, height: 400, channels: 3, background: tint } });
  const jpg = await img.resize({ width: 240, height: 240, fit: 'inside' }).jpeg({ quality: 62 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}
const T = {
  hall: await thumb('rous-lench-img-3110.webp'),
  poster: await thumb(null, '#2f5d50'),
  pexels: await thumb(null, '#c9a227'),
};

/* ------------------------------------------------------------ mock API -- */

const HEADERS = ['id', 'title', 'summary', 'event_date', 'village', 'category', 'status', 'people_in_image', 'people_ok',
  'image_part_id', 'image_url', 'image_choice', 'message_id', 'source'];
function stateData() {
  const row = (id, title, extra) => ({
    _row: 2, id, title, summary: 'Teams of up to six. Bring your own drinks; nibbles provided.', event_date: '2026-11-14', event_time: '7.30pm',
    village: 'Rous Lench', category: 'event', status: 'pending', people_in_image: 'FALSE', people_ok: '', image_part_id: '', image_url: '',
    image_choice: '', message_id: 'rss:none', source: 'Gmail', ...extra,
  });
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: HEADERS, rows: [
      row('m1-1', 'Quiz night — Rous Lench Village Hall', { _suggest: [
        { id: 'm1-1#1', source: 'own', rank: '1', caption: '', credit: '', page: '', licence: '', people: 'none', thumb: T.hall, alt: 'Rous Lench Village Hall sign', status: '' },
        { id: 'm1-1#2', source: 'organiser', rank: '2', caption: 'Image: Rous Lench Village Hall', credit: 'Rous Lench Village Hall', page: 'https://hall.example.org/quiz', licence: '', people: 'none', thumb: T.poster, alt: '', status: '' },
        { id: 'm1-1#3', source: 'library', rank: '3', caption: 'Photo by Ann Lee on Pexels', credit: 'Ann Lee / Pexels', page: 'https://www.pexels.com/photo/1/', licence: 'https://www.pexels.com/license/', people: 'unknown', thumb: T.pexels, alt: 'People at a quiz', status: '' },
      ] }),
      { ...row('m2-1', 'Christmas fair — Atch Lench', { _suggest: [] }), _row: 3, village: 'Atch Lench' },
    ] },
    replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] }, photoFolders: [], photosRoot: 'r', today: '2026-10-24', toDelete: [],
  };
}

const posts = [];
let refuse = false;
const outside = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  if (url.pathname === '/admin/api/edit') return send({ ok: true, value: b.value });
  if (url.pathname === '/admin/api/suggest') {
    if (refuse) return send({ ok: false, error: 'Changed in the Sheet since you loaded the page', current: 'm1-1#1' }, 'application/json', 409);
    return send({ ok: true, value: b.sid, message: 'Chosen. It becomes the image when you approve the item.' });
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* -------------------------------------------------------------- checks -- */

const browser = await chromium.launch();
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: false }); } };

async function check(viewport, tag) {
  posts.length = 0;
  refuse = false;
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => { throw e; });
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:')) outside.push(r.url()); });
  await page.goto(`${BASE}/admin`);
  const strip = page.locator('section.suggest').first();
  await strip.waitFor();
  await strip.scrollIntoViewIfNeeded();
  const labels = await strip.locator('.sg-src').allTextContents();
  assert.deepEqual(labels, ['Own photo', "Organiser's site", 'Library'], tag);
  assert.equal(await strip.locator('img').count(), 3);
  assert.ok((await strip.textContent()).includes('Image: Rous Lench Village Hall'));
  assert.ok((await strip.textContent()).includes('Photo by Ann Lee on Pexels'));
  assert.equal(await strip.getByRole('link', { name: 'Photos provided by Pexels' }).count(), 1);
  assert.equal(await strip.getByText('May show people', { exact: true }).count(), 1);
  const lib = strip.locator('figure.sg').nth(2).getByRole('button', { name: 'Choose' });
  assert.ok(await lib.isDisabled(), 'flagged image: Choose waits for People OK');
  const noSquash = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.ok(noSquash, `${tag}: no sideways scrolling`);
  await strip.screenshot({ path: SHOTS ? path.join(SHOTS, `suggest-${tag}-strip.png`) : undefined }).catch(() => {});
  await shot(page, `suggest-${tag}.png`);

  // Choose the organiser's image.
  await strip.locator('figure.sg').nth(1).getByRole('button', { name: 'Choose' }).click();
  await page.locator('figure.sg.chosen').first().waitFor();
  assert.deepEqual(posts.filter((p) => p.path === '/admin/api/suggest').map(({ id, sid, expected }) => ({ id, sid, expected })),
    [{ id: 'm1-1', sid: 'm1-1#2', expected: '' }]);
  const chosen = page.locator('section.suggest').first().locator('figure.sg.chosen');
  assert.equal(await chosen.locator('.sg-src').textContent(), "Organiser's site");
  assert.equal(await chosen.getByRole('button').textContent(), 'Chosen');
  await page.locator('section.suggest').first().scrollIntoViewIfNeeded();
  await shot(page, `suggest-${tag}-chosen.png`);

  // People OK, then Choose the library image; the expected value is the current choice.
  await page.locator('section.suggest').first().getByRole('checkbox').check();
  await page.waitForFunction(() => {
    const b = document.querySelectorAll('section.suggest')[0].querySelectorAll('figure.sg')[2].querySelector('button');
    return b && !b.disabled;
  });
  await page.locator('section.suggest').first().locator('figure.sg').nth(2).getByRole('button', { name: 'Choose' }).click();
  await page.waitForFunction(() => document.querySelectorAll('section.suggest')[0].querySelectorAll('figure.sg')[2].classList.contains('chosen'));
  assert.deepEqual(posts.filter((p) => p.path === '/admin/api/suggest').at(-1), { path: '/admin/api/suggest', id: 'm1-1', sid: 'm1-1#3', expected: 'm1-1#2' });
  // Unticking People OK with the flagged image chosen blocks Approve again.
  await page.locator('section.suggest').first().getByRole('checkbox').uncheck();
  await page.waitForFunction(() => {
    const card = document.querySelectorAll('section.suggest')[0].closest('.card');
    const b = [...card.querySelectorAll('button')].find((x) => x.textContent === 'Approve');
    return b && b.disabled;
  });
  await page.locator('section.suggest').first().getByRole('checkbox').check();
  await page.waitForFunction(() => {
    const card = document.querySelectorAll('section.suggest')[0].closest('.card');
    const b = [...card.querySelectorAll('button')].find((x) => x.textContent === 'Approve');
    return b && !b.disabled;
  });

  // None of these; then a stale refusal shows the Sheet's value.
  await page.locator('section.suggest').first().getByRole('button', { name: 'None of these' }).click();
  await page.locator('section.suggest').first().getByRole('button', { name: 'No image chosen' }).waitFor();
  refuse = true;
  await page.locator('section.suggest').first().locator('figure.sg').nth(0).getByRole('button', { name: 'Choose' }).click();
  await page.locator('.toast.bad').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('section.suggest')[0].querySelectorAll('figure.sg')[0].classList.contains('chosen'));

  // An event the run found nothing for says so.
  if (tag === 'phone') {
    const empty = page.locator('section.suggest').nth(1);
    await empty.scrollIntoViewIfNeeded();
    assert.ok((await empty.textContent()).includes('None found for this event.'));
  }
  await page.close();
}

try {
  await check({ width: 1280, height: 900 }, 'desktop');
  await check({ width: 390, height: 844 }, 'phone');
  assert.deepEqual(outside, [], 'nothing loaded from outside');
  console.log('ui-suggest: all checks passed');
} finally {
  await browser.close();
  server.close();
}
