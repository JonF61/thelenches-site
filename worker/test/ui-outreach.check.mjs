// worker/test/ui-outreach.check.mjs
// Browser check of the panel's Contacts > Outreach view (ui/client.js) against a mock API,
// on desktop and phone sizes: the sections, Draft nudge (posts the email; list reloads),
// Snooze 3 months and Never nudge (next_nudge writes with the value loaded as expected),
// Clear on a held-back contact, and the weekly cap hiding Draft nudge.
// Saves screenshots (SHOTS=dir). Needs Playwright (not a site dependency):
// Run: node worker/test/ui-outreach.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-outreach: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const e = (email, extra) => ({ email, id: 'c0123456789abcdef', name: '', organisation: '', village: '', role: '', status: 'contributor',
  last_contact: '', next_nudge: '', kind: 'quiet', why: '', held: '', ...extra });
let week = 1;
const outreach = () => ({
  today: '2026-10-26', hasNextNudge: true, week, cap: 5,
  seasonal: [e('jane@example.org', { name: 'Jane Smith', organisation: 'Lenches Club', status: 'organiser', kind: 'seasonal',
    why: 'Last year: 2025-11-08 Quiz night', last_contact: '2025-11-08' })],
  quiet: [e('tom@example.org', { name: 'Tom Green', village: 'Rous Lench', why: 'No email since 2026-05-14', last_contact: '2026-05-14' })],
  lead: [e('wi@example.org', { name: 'Ab Lench WI', status: 'lead', kind: 'lead', why: 'First wrote 2026-09-02; nothing sent yet', last_contact: '2026-09-02' })],
  held: [e('sam@example.org', { name: 'Sam Brown', why: 'No email since 2026-06-01', held: 'snoozed until 2027-01-26', next_nudge: '2027-01-26' })],
});
const contacts = () => ({ headers: [], rows: [] });
function stateData() {
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: { Contacts: 11 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
    photoFolders: [], photosRoot: 'r', today: '2026-10-26', toDelete: [], feedback: { headers: [], rows: [] },
  };
}

const posts = [];
let loads = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/contacts') return send(contacts());
  if (url.pathname === '/admin/api/outreach') { loads += 1; return send(outreach()); }
  let body = '';
  for await (const ch of req) body += ch;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  if (url.pathname === '/admin/api/nudge') return send({ ok: true, message: 'Draft requested. Holly emails you the draft to approve in a minute or two.' });
  return send({ ok: true, value: String(b.value), message: 'Saved.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    posts.length = 0;
    week = 1;
    const page = await browser.newPage({ viewport });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${base}/admin`);
    await page.locator('nav.side button', { hasText: 'Contacts' }).click();
    await page.getByRole('button', { name: 'Outreach' }).click();
    const main = page.locator('.main');
    await main.getByText('Seasonal due (1)').waitFor();
    const text = await main.innerText();
    for (const want of [/Gone quiet \(1\)/i, /Leads to chase \(1\)/i, /Held back \(1\)/i, /1 of 5 drafts used this week/,
      /Last year: 8 Nov 2025 Quiz night/, /held back: snoozed until 26 Jan 2027/, /never goes by itself/]) assert.match(text, want);
    assert.equal(await main.getByRole('button', { name: 'Draft nudge' }).count(), 3, 'not on held-back rows');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `outreach-${name}.png`), fullPage: true });

    const before = loads;
    await page.locator('.crow', { hasText: 'Jane Smith' }).getByRole('button', { name: 'Draft nudge' }).click();
    await page.locator('.toast', { hasText: 'Draft requested' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/nudge', email: 'jane@example.org' });
    await page.waitForFunction(() => document.querySelectorAll('.crow').length === 4);
    assert.ok(loads > before, 'list reloaded');

    await page.locator('.crow', { hasText: 'Tom Green' }).getByRole('button', { name: 'Snooze 3 months' }).click();
    await page.locator('.toast', { hasText: 'Snoozed for 3 months' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/contact', email: 'tom@example.org', field: 'next_nudge', expected: '', value: '2027-01-26' });

    await main.getByText('Leads to chase (1)').waitFor();
    await page.locator('.crow', { hasText: 'Ab Lench WI' }).getByRole('button', { name: 'Never nudge' }).click();
    await page.locator('.toast', { hasText: 'Never nudge: Ab Lench WI' }).waitFor();
    assert.match(dialogs.pop(), /Never nudge Ab Lench WI\?/);
    assert.equal(posts.pop().value, 'never');

    await main.getByText('Held back (1)').waitFor();
    await page.locator('.crow', { hasText: 'Sam Brown' }).getByRole('button', { name: 'Clear' }).click();
    await page.locator('.toast', { hasText: 'Cleared' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/contact', email: 'sam@example.org', field: 'next_nudge', expected: '2027-01-26', value: '' });

    // Weekly cap: Draft nudge goes, Snooze stays.
    week = 5;
    await page.getByRole('button', { name: 'All contacts' }).click();
    await page.getByRole('button', { name: 'Outreach' }).click();
    await main.getByText("This week's 5 drafts are used").waitFor();
    assert.equal(await main.getByRole('button', { name: 'Draft nudge' }).count(), 0);
    assert.equal(await main.getByRole('button', { name: 'Snooze 3 months' }).count(), 3);
    await page.close();
  }
  console.log('ui-outreach: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
