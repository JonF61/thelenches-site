// worker/test/ui-orgs.check.mjs
// Browser check of Contacts > Organisations (ui/client.js) against a mock API built from the
// real contacts.json list, on desktop and phone sizes: the sections, Draft check and Draft
// chaser (post the slug; list reloads), Done / Snooze 3 months / Never (next_check writes with
// the value loaded as expected), Clear on a held one, and the daily cap hiding Draft.
// Saves screenshots (SHOTS=dir). Needs Playwright (not a site dependency):
// Run: node worker/test/ui-orgs.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';
import { orgEntries, listingEntries, orgLists } from '../src/admin/orgoutreach.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-orgs: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const data = Object.fromEntries(['contacts', 'council', 'schools', 'health', 'transport']
  .map((n) => [n, JSON.parse(fs.readFileSync(new URL(`../../src/_data/${n}.json`, import.meta.url)))]));
const ORGS = orgEntries(data);
const LISTINGS = listingEntries(Object.fromEntries(['trades', 'eat'].map((n) => [n, JSON.parse(fs.readFileSync(new URL(`../../src/_data/${n}.json`, import.meta.url)))])));
const TODAY = '2026-10-27';
const email = (id) => ORGS.find((o) => o.id === id).email;
const sent = (id, day, kind = 'check') => ({ reply_id: `r-${id}-${kind}`, type: 'outreach', to: email(id), status: 'sent',
  policy_codes: `org_${kind}_${id}`, created_at: `${day} 09:00`, sent_at: `${day} 09:05` });
let replies;
let orgRows;
function reset() {
  replies = [sent('tennis', '2026-10-01'), sent('cricket', '2026-10-20'), sent('walking', '2026-08-01'), sent('walking', '2026-09-01', 'chase'),
    sent('preschool', '2026-10-01'), { reply_id: 'm1-ack', message_id: 'm1', to: email('preschool'), type: 'ack', status: 'sent', created_at: '2026-10-05 10:00' },
    { ...sent('orchard', TODAY), status: 'awaiting' }];
  orgRows = [{ id: 'grey-gable', next_check: '2027-01-27' }, { id: 'eat-boot-inn', email: 'info@thebootinn.com', email_source: 'website' },
    { id: 'trade-cannins', email: 'info@cannins.co.uk', next_check: '2027-10-20', confirmed: '2026-10-20' }];
}
const view = (count = 1) => ({ ...orgLists([...ORGS, ...LISTINGS], { replies, contacts: [], orgRows, hasTab: true, today: TODAY, recent: new Set(['rous-lench-hall']) }), count });

let count = 1;
const posts = [];
let loads = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') {
    return send({ email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null, health: [],
      watchdog: { open: false }, googleAccount: 'sa@example', pending: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
      replies: { headers: [], rows: [] }, photoFolders: [], photosRoot: 'r', today: TODAY, toDelete: [], feedback: { headers: [], rows: [] }, sent: [] });
  }
  if (url.pathname === '/admin/api/contacts') return send({ headers: [], rows: [] });
  if (url.pathname === '/admin/api/orgs') { loads += 1; return send(view(count)); }
  let body = '';
  for await (const ch of req) body += ch;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  if (url.pathname === '/admin/api/orgcheck') return send({ ok: true, message: 'Check requested. Holly emails you the draft to approve in a minute or two.' });
  return send({ ok: true, value: String(b.value) });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    reset();
    count = 1;
    posts.length = 0;
    const page = await browser.newPage({ viewport });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${base}/admin`);
    await page.locator('nav.side button', { hasText: 'Contacts' }).click();
    await page.getByRole('button', { name: 'Organisations' }).click();
    const main = page.locator('.main');
    await main.getByText(/^Due a check \(\d+\)$/).waitFor();
    const text = await main.innerText();
    for (const want of [/Chaser due \(1\)/i, /Replied \(1\)/i, /Draft waiting \(1\)/i, /Waiting for a reply \(1\)/i, /No reply \(1\)/i,
      /Done, snoozed or never \(1\)/i, /In regular contact \(1\)/i, /Emailed us in the last 3 months/, /No email \(10\)/i, /1 of 10 drafts used today/, /never goes by itself/,
      /Health & emergencies/, /High St, Inkberrow WR7 4BW · 01386 793007/]) assert.match(text, want);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `orgs-${name}.png`), fullPage: true });

    const before = loads;
    await page.locator('.crow', { hasText: 'The Lenches Club' }).getByRole('button', { name: 'Draft check' }).click();
    await page.locator('.toast', { hasText: 'Check requested' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/orgcheck', id: 'lenches-club' });
    await page.locator('.crow', { hasText: 'The Lenches Club' }).getByText(/Check requested at \d+:\d\d\. Holly is drafting it/).waitFor();
    assert.equal(await page.locator('.crow', { hasText: 'The Lenches Club' }).getByRole('button', { name: 'Draft check' }).count(), 0, 'no second Draft check');
    await page.locator('.crow', { hasText: 'Lenches Tennis Club' }).getByRole('button', { name: 'Draft chaser' }).click();
    await page.locator('.toast', { hasText: 'requested' }).last().waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/orgcheck', id: 'tennis' });
    assert.ok(loads > before, 'list reloaded');

    await main.getByText(/^Replied \(1\)$/).waitFor();
    await page.locator('.crow', { hasText: 'The Lenches Pre-school' }).getByRole('button', { name: 'Done' }).click();
    await page.locator('.toast', { hasText: 'next due in a year' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/orgnext', id: 'preschool', expected: '', value: '2027-10-27', confirm: true, expected_confirmed: '' });

    await page.locator('.crow', { hasText: 'Lenches Cricket Club' }).getByRole('button', { name: 'Never' }).click();
    await page.locator('.toast', { hasText: 'Never: Lenches Cricket Club' }).waitFor();
    assert.match(dialogs.pop(), /Never check Lenches Cricket Club\?/);
    assert.equal(posts.pop().value, 'never');

    await page.locator('.crow', { hasText: 'Church Lench Village Hall' }).getByRole('button', { name: 'Snooze 3 months' }).click();
    await page.locator('.toast', { hasText: 'Snoozed for 3 months' }).waitFor();
    assert.equal(posts.pop().value, '2027-01-27');

    await page.locator('.crow', { hasText: 'Grey Gable Surgery' }).getByRole('button', { name: 'Clear' }).click();
    await page.locator('.toast', { hasText: 'Cleared' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/orgnext', id: 'grey-gable', expected: '2027-01-27', value: '' });
    assert.equal(await page.locator('.crow', { hasText: 'Rous Lench Village Hall' }).getByRole('button').count(), 0, 'no buttons when in regular contact');
    assert.equal(await page.locator('.crow', { hasText: 'The Lenches Amphitheatre' }).getByRole('button').count(), 0, 'no buttons without an email');

    // Other addresses: saved as typed, stale-checked against what loaded.
    const club = page.locator('.crow', { hasText: 'Lenches Tennis Club' });
    await club.getByText('Other addresses').click();
    await club.locator('textarea').fill('sec@example.org, chair@example.org');
    await club.getByRole('button', { name: 'Save addresses' }).click();
    await page.locator('.toast', { hasText: 'Saved: other addresses' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/orgemails', id: 'tennis', expected: '', value: 'sec@example.org, chair@example.org' });
    if (SHOTS && name === 'desktop') {
      await page.locator('.crow', { hasText: 'Lenches Cricket Club' }).getByText('Other addresses').click();
      await page.locator('.crow', { hasText: 'Lenches Cricket Club' }).screenshot({ path: path.join(SHOTS, 'orgs-emails.png') });
    }

    // Listings (5 Nov): their own list; a found address shows, Add an email saves one.
    await main.getByRole('button', { name: 'Commercial Listings' }).click();
    await main.getByText(/Every Local trades and Where to eat entry/).waitFor();
    const ltext = await main.innerText();
    assert.match(ltext, /Boot Inn\s+·\s+Where to eat/);
    assert.match(ltext, /info@thebootinn\.com · Not checked yet/);
    assert.match(ltext, /B Tomes & Son/);
    assert.match(ltext, /Confirmed 20 Oct 2026 · next check 20 Oct 2027|Confirmed .*20.* · next check .*2027/);
    assert.doesNotMatch(ltext, /Lenches Tennis Club/, 'organisations not in the Listings list');
    assert.equal(await page.locator('.crow', { hasText: 'B Tomes & Son' }).getByText('Add an email').count(), 0, 'own address: no box');
    const boot = page.locator('.crow', { hasText: 'Boot Inn' });
    await boot.getByText('Email (found on their website)').waitFor();
    const mysuru = page.locator('.crow', { hasText: 'Mysuru' });
    await mysuru.getByText('Add an email').click();
    await mysuru.locator('input[type=email]').fill('hello@mysuru.co.uk');
    await mysuru.getByRole('button', { name: 'Save email' }).click();
    await page.locator('.toast', { hasText: 'Saved: email for' }).waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/listingemail', id: 'eat-mysuru', expected: '', expected_source: '', value: 'hello@mysuru.co.uk' });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `orgs-listings-${name}.png`), fullPage: true });
    await main.getByRole('button', { name: 'Groups and services' }).click();

    // Daily cap: Draft goes, Done stays.
    count = 10;
    await page.getByRole('button', { name: 'All contacts' }).click();
    await page.getByRole('button', { name: 'Organisations' }).click();
    await main.getByText(/drafts are used/).waitFor();
    assert.equal(await main.getByRole('button', { name: /^Draft (check|chaser)$/ }).count(), 0);
    assert.ok(await main.getByRole('button', { name: 'Done' }).count() > 0);
    await page.close();
    console.log(`ui-orgs ${name}: ok`);
  }
} finally {
  await browser.close();
  server.close();
}
