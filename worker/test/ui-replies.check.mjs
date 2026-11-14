// worker/test/ui-replies.check.mjs
// Browser check of a Replies card's "What to say" box (1 Nov), desktop and phone: a short
// brief is refused in the page; a real one posts a redraft whose instruction says to write
// the reply afresh from it. Needs Playwright (not a site dependency):
// Run: node worker/test/ui-replies.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-replies: Playwright not installed here, skipped');
  process.exit(0);
}

const state = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] },
  replies: { headers: [], rows: [{ _row: 5, reply_id: 'r1', to: 'sue@example.org', subject: 'Coffee morning', type: 'answer', status: 'awaiting',
    body: 'Hi Sue,\n\nThanks for asking.\n\nBest wishes,\nHolly', created_at: '2026-11-01 09:00' }] },
  owed: [], photos: { headers: [], rows: [] }, photoFolders: [], photosRoot: 'r', today: '2026-11-01', toDelete: [], sent: [],
  feedback: { headers: [], rows: [] },
});

const posts = [];
let redrafted = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') {
    const st = state();
    if (redrafted) st.replies.rows = [{ ...st.replies.rows[0], reply_id: 'r1-r1', body: 'Hi Sue,\n\nIt is on Saturday at 10am.\n\nBest wishes,\nHolly' }];
    return send(st);
  }
  if (url.pathname === '/admin/api/mail-text') return send({ from: 'Sue', date: '1 Nov', text: 'When is the coffee morning?' });
  if (req.method !== 'POST') return send({});
  let body = '';
  for await (const ch of req) body += ch;
  posts.push({ path: url.pathname, ...(body ? JSON.parse(body) : {}) });
  if (url.pathname === '/admin/api/action') redrafted = true;
  return send({ ok: true, message: 'Redraft requested.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
    posts.length = 0;
    redrafted = false;
    const page = await browser.newPage({ viewport });
    await page.goto(`${base}/admin`);
    await page.locator('nav.side button', { hasText: 'Replies' }).click();
    const box = page.locator('form.wts textarea').first();
    await box.waitFor();
    await box.fill('hi');
    await page.getByRole('button', { name: 'Write it this way' }).first().click();
    await page.locator('.toast', { hasText: 'Say what the reply should say' }).waitFor();
    await box.fill('Say it is on Saturday at 10am in the hall.');
    await page.getByRole('button', { name: 'Write it this way' }).first().click();
    await page.locator('.toast', { hasText: 'Redraft requested' }).waitFor();
    const sent = posts.filter((p) => p.path === '/admin/api/action');
    assert.deepEqual(sent.map((p) => [p.kind, p.id, p.action, p.reason]),
      [['reply', 'r1', 'redraft', 'Write the reply afresh, saying: Say it is on Saturday at 10am in the hall.']]);
    // The drafting bar, then Draft ready once the new draft is in the state (8s poll).
    await page.locator('.waitbar', { hasText: 'Holly is drafting: Coffee morning' }).waitFor();
    await page.locator('.toast', { hasText: 'Draft ready: Coffee morning' }).waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.waitbar').count(), 0);
    assert.match(await page.locator('.main').innerText(), /It is on Saturday at 10am/);
    await page.close();
  }
  console.log('ui-replies: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
