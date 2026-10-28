// worker/test/ui-draft.check.mjs
// Browser check of the panel's Newsletter draft screen (ui/client.js, admin/draft.js) against
// a mock API, on desktop and phone sizes: the menu entry, the top bar's Newsletter chip and
// its Draft link, the draft (a real render from scripts/newsletter/draft.js) in its frame,
// and Refresh showing the newer draft. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-draft.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';
import { draftMeta, draftHtml, draftPage } from '../src/admin/draft.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-draft: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const { buildDraft, draftRows } = require('../../scripts/newsletter/draft.js');
const { loadWhatson } = require('../../lib/whatson.js');
const data = (f) => require(`../../src/_data/${f}`);

const draft = buildDraft({
  today: '2026-10-28', settings: {}, sources: [], jpegFor: () => '', whatson: loadWhatson({ today: '2026-10-28' }),
  bins: data('bins.json'), siteupdates: data('siteupdates.json'), onthisday: data('onthisday.json'),
  pending: [
    { id: 'a', title: 'Hall quiz night results', body: 'Well done to every team, and thanks to all who came.', category: 'notice', status: 'approved', received: '2026-10-26 10:00', decided_at: '2026-10-26 11:00' },
    { id: 'b', title: 'Too late notice', body: 'x', category: 'notice', status: 'approved', received: '2026-10-28 19:00', decided_at: '2026-10-28 19:30' },
  ],
  issues: [{ issue_id: '2026-10-22', issue_date: '2026-10-22', status: 'sent', item_keys: '', image_keys: '' }],
});
let rows = draftRows(draft.meta, draft.html, '2026-10-28T12:00:00.000Z');
let refreshed = 0;

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false },
  newsletter: { _row: 5, issue_id: '2026-10-22', issue_date: '2026-10-22', status: 'sent', sent_at: '2026-10-22T08:00:00Z' },
  draft: draftMeta(rows),
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-10-28', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/summary') return send({ error: 'not in this check' }, 'application/json', 500);
  if (url.pathname === '/admin/api/draft') return send({ meta: draftMeta(rows) });
  if (url.pathname === '/admin/api/draft-refresh' && req.method === 'POST') {
    refreshed += 1;
    rows = draftRows({ ...draft.meta, items: draft.meta.items + 1, notices: draft.meta.notices + 1 }, draft.html, '2026-10-28T13:05:00.000Z');
    return send({ ok: true, message: 'Refreshing: the new draft shows in a minute or two.' });
  }
  if (url.pathname === '/admin/draft') {
    const r = draftPage(await draftHtml(rows));
    res.writeHead(200, Object.fromEntries(r.headers));
    return res.end(await r.text());
  }
  return send({ error: 'nf' }, 'application/json', 404);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    rows = draftRows(draft.meta, draft.html, '2026-10-28T12:00:00.000Z');
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    await page.goto(`${base}/admin`);
    const menu = (await page.locator('nav.side button').allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
    assert.deepEqual(menu.slice(0, 4), ['Summary', 'Newsletter draft', 'Newsletter stats', 'Submissions']);
    // The top bar: Newsletter chip with its Draft link; no Feedback chip.
    const chip = page.locator('.top .chip', { hasText: 'Newsletter' });
    assert.match(await chip.innerText(), /2026-10-22 · sent[\s\S]*Draft Thu 29 Oct/);
    assert.equal(await page.locator('.top .chip', { hasText: 'Feedback' }).count(), 0);
    await chip.locator('button', { hasText: 'Draft' }).click();
    const main = page.locator('.main');
    await main.locator('iframe.draft-frame').waitFor();
    const text = await main.innerText();
    assert.match(text, /^The next newsletter as it would be built now/m);
    assert.match(text, /Draft for Thu 29 Oct/);
    assert.match(text, /1 held as late, for next week/);
    assert.match(text, /Live draft: changes as items are approved/);
    const frame = page.frameLocator('iframe.draft-frame');
    await frame.locator('text=Hall quiz night results').first().waitFor();
    assert.equal(await frame.locator('text=Too late notice').count(), 0);
    await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `draft-${name}.png`), fullPage: false });
    // Refresh: shows the newer draft once it appears.
    const before = refreshed;
    await main.locator('button', { hasText: 'Refresh' }).click();
    await main.locator('button', { hasText: 'Refreshing…' }).waitFor();
    assert.equal(refreshed, before + 1);
    await page.clock.runFor(16000);
    await main.locator('.meta', { hasText: String(draft.meta.items + 1) + ' item' }).waitFor();
    assert.match(await main.locator('iframe.draft-frame').getAttribute('src'), /13%3A05/);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-draft: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
