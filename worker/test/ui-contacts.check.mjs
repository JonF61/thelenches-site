// worker/test/ui-contacts.check.mjs
// Browser check of the panel's Contacts screen (ui/client.js) against a mock API, on desktop
// and phone sizes: the list (newest contact first, search, status / village / organisation
// filters, "Quiet a year"), Delete from the list (confirm, then gone), a contact page, and what
// each Save posts (the value the page loaded as expected, profile_source shown as manual after a
// profile save, the status dropdown, an own status, ignore after a confirm).
// Saves screenshots (SHOTS=dir). Needs Playwright (not a site dependency):
// Run: node worker/test/ui-contacts.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-contacts: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const c = (email, extra) => ({
  _row: 2, email, name: '', organisation: '', village: '', role: '', profile: '', contributions: '', contribution_count: '0',
  first_contact: '', last_contact: '', message_count: '1', status: 'lead', notes: '', profile_source: 'auto', ...extra,
});
// As the server sends them (contacts.js contactRows): newest last contact first.
const contacts = () => ({ headers: [], rows: [
  c('jane@example.org', { _row: 3, name: 'Jane Smith', organisation: 'Lenches Club', village: 'Church Lench', role: 'Secretary',
    profile: 'Sends monthly quiz-night flyers as PDF, usually a fortnight ahead. Friendly and quick to reply.',
    contributions: '2026-10-21 Quiz night (event, published); 2026-09-02 Harvest supper (event, published)', contribution_count: '7',
    first_contact: '2026-03-04', last_contact: '2026-10-21', message_count: '12', status: 'contributor' }),
  c('bob@example.org', { _row: 5, name: 'Bob Jones', village: 'Rous Lench', first_contact: '2026-10-03', last_contact: '2026-10-03' }),
  c('vip@example.org', { _row: 6, name: 'Val Price', village: 'Church Lench', first_contact: '2025-01-10', last_contact: '2025-02-02', status: 'key contact', profile_source: 'manual' }),
  c('ann@example.org', { _row: 2, name: 'Ann Brown', organisation: 'Ab Lench PCC', village: 'Ab Lench', contribution_count: '3', message_count: '5',
    first_contact: '2024-01-10', last_contact: '2025-08-02', status: 'dormant' }),
] });
function stateData() {
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: { Contacts: 11 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
    photoFolders: [], photosRoot: 'r', today: '2026-10-25', toDelete: [], feedback: { headers: [], rows: [] },
  };
}

const posts = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/contacts') return send(contacts());
  if (url.pathname === '/admin/api/contact-messages') return send({ max: 25, messages: [
    { id: 'm3', at: '2026-11-01T09:00:00Z', who: 'them', subject: 'Re: Quiz night', text: 'Lovely, thank you!' },
    { id: 'm2', at: '2026-10-31T10:00:00Z', who: 'holly', subject: 'Re: Quiz night', text: "Hi Jane,\n\nThanks, your quiz night is on its way to the website and Thursday's newsletter." },
    { id: 'm1', at: '2026-10-31T09:12:00Z', who: 'them', subject: 'Quiz night', text: 'Hi, our quiz night is on 21 November at 7.30pm in the hall. Flyer attached.' },
    // Nine older ones: twelve in all, so the card shows ten and "Show older (2 more)".
    ...Array.from({ length: 9 }, (_, i) => ({ id: 'o' + i, at: `2026-10-${String(20 - i).padStart(2, '0')}T09:00:00Z`, who: 'them', subject: 'Older ' + i, text: 'Older message ' + i })),
  ] });
  let body = '';
  for await (const ch of req) body += ch;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  if (url.pathname === '/admin/api/contactmail') return send({ ok: true, message: 'Draft requested. Holly emails you the draft.' });
  if (url.pathname === '/admin/api/contact-delete') return send({ ok: true, message: 'Deleted from Contacts. Their newsletter subscription is unchanged.' });
  if (b.field === 'village') return send({ ok: false, error: 'Changed in the Sheet since you loaded the page', current: 'Atch Lench' }, 'application/json', 409);
  const profile = ['name', 'organisation', 'village', 'role', 'profile'].includes(b.field);
  return send({ ok: true, value: String(b.value).trim(), profileSource: profile ? 'manual' : undefined, message: 'Saved.' });
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
    await page.locator('nav.side button', { hasText: 'Contacts' }).click();
    await page.locator('.crow').first().waitFor();
    const names = () => page.locator('.crow b').allInnerTexts();
    assert.deepEqual(await names(), ['Jane Smith', 'Bob Jones', 'Val Price', 'Ann Brown'], 'newest contact first');
    assert.match(await page.locator('.main').innerText(), /4 people/);
    assert.match(await page.locator('.crow').first().innerText(), /Secretary · Church Lench · last 21 Oct 2026 · 7 items, 12 emails/);
    assert.match(await page.locator('.crow').first().innerText(), /Contributor/);
    assert.equal(await page.locator('.crow', { hasText: 'Quiet a year' }).count(), 2, 'Val and Ann');
    await page.fill('input[type=search]', 'quiz');
    assert.deepEqual(await names(), ['Jane Smith']);
    await page.fill('input[type=search]', '');
    await page.selectOption('#cf-village', 'Church Lench');
    assert.deepEqual(await names(), ['Jane Smith', 'Val Price']);
    await page.selectOption('#cf-status', 'key contact');
    assert.deepEqual(await names(), ['Val Price']);
    await page.selectOption('#cf-status', '');
    await page.selectOption('#cf-village', '');
    await page.selectOption('#cf-org', 'Ab Lench PCC');
    assert.deepEqual(await names(), ['Ann Brown']);
    await page.selectOption('#cf-org', '');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `contacts-list-${name}.png`), fullPage: true });

    // Delete from the list: confirm, posted with the status loaded, gone from the list.
    await page.locator('.crow', { hasText: 'Bob Jones' }).getByRole('button', { name: 'Delete' }).click();
    await page.locator('.toast', { hasText: 'Deleted from Contacts' }).waitFor();
    assert.match(dialogs.pop(), /Delete Bob Jones from Contacts\?[\s\S]*newsletter subscription is not affected/);
    assert.deepEqual(await names(), ['Jane Smith', 'Val Price', 'Ann Brown']);

    // Contact page.
    await page.locator('.crow', { hasText: 'Jane Smith' }).locator('.crow-open').click();
    const main = page.locator('.main');
    await main.getByText('Contributions (7)').waitFor();
    let text = await main.innerText();
    assert.match(text, /First contact 4 Mar 2026 · last 21 Oct 2026 · 12 emails · 7 items/);
    assert.match(text, /written by Claude \(auto\)/);
    assert.match(text, /Harvest supper/);
    assert.match(text, /and 5 older/);
    assert.equal(await page.locator('#c-role').inputValue(), 'Secretary');
    assert.equal(await main.locator('a[href^="mailto:"]').count(), 0, 'no email link');
    // Messages: newest first, who wrote each, just the words.
    await main.locator('.msgs .msg').first().waitFor();
    assert.deepEqual((await main.locator('.msgs .msg-h b').allInnerTexts()).slice(0, 3), ['Them', 'Holly', 'Them']);
    assert.match(await main.locator('.msgs .msg').nth(1).innerText(), /Sat 31 Oct 2026, 10:00 · Re: Quiz night[\s\S]*on its way to the website/);
    // Holly's text is shown whole, not clipped to its first two lines ("Hi Jane," and a blank).
    assert.ok(await main.locator('.msgs .msg.holly .text').evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'Holly text not clipped');
    // Ten at a time.
    assert.equal(await main.locator('.msgs .msg').count(), 10);
    await main.getByRole('button', { name: 'Show older (2 more)' }).click();
    assert.equal(await main.locator('.msgs .msg').count(), 12);
    await main.getByRole('button', { name: 'Show fewer' }).click();
    assert.equal(await main.locator('.msgs .msg').count(), 10);
    // Empty profile and notes: small boxes; village is a dropdown.
    assert.equal(await page.locator('#c-notes').getAttribute('rows'), '2');
    assert.equal(await page.locator('#c-village').evaluate((el) => el.tagName), 'SELECT');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `contacts-page-${name}.png`), fullPage: true });
    await page.fill('#c-role', 'Chair');
    await page.locator('form.cfield', { has: page.locator('#c-role') }).getByRole('button', { name: 'Save' }).click();
    await main.getByText('edited by you (manual)').waitFor();
    assert.equal(await page.locator('#c-role').inputValue(), 'Chair');
    await page.fill('#c-notes', 'Call after 6');
    await page.locator('form.cfield', { has: page.locator('#c-notes') }).getByRole('button', { name: 'Save' }).click();
    await page.locator('.toast', { hasText: 'Notes saved' }).waitFor();
    // Draft email: a short brief is refused in the page; a real one is posted, box cleared.
    await page.fill('#cmail-brief', 'hi');
    await page.getByRole('button', { name: 'Draft email' }).click();
    await page.locator('.toast', { hasText: 'at least 10 characters' }).waitFor();
    await page.fill('#cmail-brief', 'Tell her the quiz is listed on the site.');
    await page.getByRole('button', { name: 'Draft email' }).click();
    await page.locator('.toast', { hasText: 'Draft requested' }).waitFor();
    assert.equal(await page.locator('#cmail-brief').inputValue(), '');
    assert.deepEqual(posts.filter((p) => p.path === '/admin/api/contactmail').map((p) => [p.email, p.brief]),
      [['jane@example.org', 'Tell her the quiz is listed on the site.']]);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `contacts-mail-${name}.png`), fullPage: true });
    // Stale village: refused, the page shows the Sheet's value.
    await page.selectOption('#c-village', 'Rous Lench');
    await page.locator('form.cfield', { has: page.locator('#c-village') }).getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelector('#c-village').value === 'Atch Lench');
    assert.match(await page.locator('.toast').innerText(), /changed in the Sheet.*Atch Lench.*Not saved/);
    // Status: the dropdown; an own value refused if it is in the list; then a real one.
    assert.equal(await page.locator('#c-status').inputValue(), 'contributor');
    await page.selectOption('#c-status', 'organiser');
    await page.locator('form.cfield', { has: page.locator('#c-status') }).getByRole('button', { name: 'Save' }).click();
    await page.locator('.toast', { hasText: 'Status saved' }).waitFor();
    assert.equal(await page.locator('#c-status').inputValue(), 'organiser');
    await page.selectOption('#c-status', 'own');
    await page.fill('#c-status-own', 'Lead');
    await page.locator('form.cfield', { has: page.locator('#c-status') }).getByRole('button', { name: 'Save' }).click();
    assert.match(await page.locator('.toast').innerText(), /in the list/);
    await page.fill('#c-status-own', 'Key contact');
    await page.locator('form.cfield', { has: page.locator('#c-status') }).getByRole('button', { name: 'Save' }).click();
    await page.locator('.toast', { hasText: 'Status saved' }).waitFor();
    assert.equal(await page.locator('#c-status').inputValue(), 'own');
    assert.equal(await page.locator('#c-status-own').inputValue(), 'Key contact');
    // Ignore: confirm, then back on the list without them.
    await page.selectOption('#c-status', 'ignore');
    await page.locator('form.cfield', { has: page.locator('#c-status') }).getByRole('button', { name: 'Save' }).click();
    await page.locator('.crow').first().waitFor();
    assert.match(dialogs.pop(), /clears the row/);
    assert.deepEqual(await names(), ['Val Price', 'Ann Brown']);

    assert.deepEqual(posts.filter((p) => p.path === '/admin/api/contact-delete').map((p) => [p.email, p.expected]), [['bob@example.org', 'lead']]);
    const sent = posts.filter((p) => p.path === '/admin/api/contact').map((p) => [p.email, p.field, p.expected, p.value]);
    assert.deepEqual(sent, [
      ['jane@example.org', 'role', 'Secretary', 'Chair'],
      ['jane@example.org', 'notes', '', 'Call after 6'],
      ['jane@example.org', 'village', 'Church Lench', 'Rous Lench'],
      ['jane@example.org', 'status', 'contributor', 'organiser'],
      ['jane@example.org', 'status', 'organiser', 'Key contact'],
      ['jane@example.org', 'status', 'Key contact', 'ignore'],
    ]);
    await page.close();
  }
  console.log('ui-contacts: all checks passed');
} finally {
  await browser.close();
  server.close();
}
