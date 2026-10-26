// worker/test/ui-lessons.check.mjs
// Browser check of the panel's Holly lessons screen (ui/client.js) against a mock API, on
// desktop and phone sizes: sections, Add, Edit (expected = text loaded), Delete (confirm,
// expected), and Approve / Reject of a suggestion. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-lessons.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-lessons: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const lessons = () => ({ headers: [], rows: [
  { _row: 4, id: 'L20261102-1', created_at: '2026-11-02 07:13', lesson: 'Keep replies to clerks formal.', evidence: 'a1', status: 'proposed', decided_at: '', notes: '' },
  { _row: 2, id: 'L20261026-1', created_at: '2026-10-26 13:43', lesson: 'Avoid naming a past month when recalling what someone said.', evidence: '', status: 'approved', decided_at: '2026-10-26 13:50', notes: '' },
  { _row: 3, id: 'L20261026-2', created_at: '2026-10-26 13:43', lesson: 'An old rule switched off.', evidence: '', status: 'rejected', decided_at: '', notes: '' },
] });
const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: { 'Holly lessons': 9 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});

const posts = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/lessons') return send(lessons());
  let body = '';
  for await (const ch of req) body += ch;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  return send({ ok: true, message: 'Done.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    posts.length = 0;
    const page = await browser.newPage({ viewport });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${base}/admin`);
    await page.locator('nav.side button', { hasText: 'Holly lessons' }).click();
    const main = page.locator('.main');
    await main.getByText('Keep replies to clerks formal.').waitFor();
    const text = await main.innerText();
    assert.match(text, /^Rules Holly follows in every draft/m);
    assert.match(text, /SUGGESTED \(1\)[\s\S]*IN USE \(1\)[\s\S]*NOT IN USE \(1\)/i);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `lessons-${name}.png`), fullPage: true });

    // Add.
    await page.fill('#lesson-new', 'Thank council clerks for their help.');
    await main.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.toast').waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/lesson', op: 'add', value: 'Thank council clerks for their help.' });

    // Approve a suggestion; Reject one.
    const sug = () => main.locator('.card', { hasText: 'Keep replies to clerks formal.' });
    await sug().getByRole('button', { name: 'Approve' }).click();
    await page.locator('.toast').waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/lesson', op: 'decide', id: 'L20261102-1', action: 'approve' });
    await sug().getByRole('button', { name: 'Reject' }).click();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(200);
    assert.equal(posts.pop().action, 'reject');
    assert.equal(await main.locator('.card', { hasText: 'Avoid naming a past month' }).getByRole('button', { name: 'Approve' }).count(), 0, 'no Approve on lessons in use');

    // Edit.
    const inUse = () => main.locator('.card', { hasText: 'Avoid naming a past month' });
    await inUse().getByRole('button', { name: 'Edit' }).click();
    await main.locator('textarea[aria-label="Lesson text"]').fill('Never name a past month when recalling what someone said.');
    await main.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(200);
    assert.deepEqual(posts.pop(), { path: '/admin/api/lesson', op: 'edit', id: 'L20261026-1',
      expected: 'Avoid naming a past month when recalling what someone said.', value: 'Never name a past month when recalling what someone said.' });

    // Delete.
    await main.locator('.card', { hasText: 'An old rule switched off.' }).getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(200);
    assert.match(dialogs.pop(), /Delete this lesson\?[\s\S]*An old rule switched off/);
    assert.deepEqual(posts.pop(), { path: '/admin/api/lesson', op: 'delete', id: 'L20261026-2', expected: 'An old rule switched off.' });
    await page.close();
  }
  console.log('ui-lessons: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
