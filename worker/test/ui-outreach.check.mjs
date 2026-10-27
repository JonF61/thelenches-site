// worker/test/ui-outreach.check.mjs
// Browser check of the panel's menu (order, labels, each page's reminder line) and Contacts > Outreach view (ui/client.js) against a mock API,
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
  sent: [{ reply_id: 'out-1', to: 'george@example.org', name: 'George', type: 'outreach', subject: 'Your EP release?', body: 'Hi George,\n\nAny news on the EP?', sent_at: '2026-10-26 09:40' }],
  held: [e('sam@example.org', { name: 'Sam Brown', why: 'No email since 2026-06-01', held: 'snoozed until 2027-01-26', next_nudge: '2027-01-26' })],
});
const contacts = () => ({ headers: [], rows: [] });
function stateData() {
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: { Contacts: 11 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
    replies: { headers: [], rows: [{ reply_id: 'm9-answer', message_id: 'msg123abc', to: 'clerk@example.org', type: 'answer', status: 'awaiting', subject: 'Re: Hall hire',
      body: 'Hi there,\n\nThanks for asking.\n\nThe hall can be booked through the website.\n\nBest wishes,\nHolly\nLenches website assistant', created_at: '2026-10-26 10:17' },
      { reply_id: 'm8-own', message_id: 'msg123abc', to: 'clerk@example.org', type: 'own', status: 'awaiting', subject: 'Re: Your feed', body: '',
        notes: 'Your own thread: reply in Gmail, then tap Done.', created_at: '2026-10-26 10:20' }] },
    photoFolders: [], photosRoot: 'r', today: '2026-10-26', toDelete: [], feedback: { headers: [], rows: [] },
    sent: [
      { reply_id: 'out-1', to: 'george@example.org', type: 'outreach', subject: 'Your EP release?', body: 'Hi George,\n\nAny news on the EP?', sent_at: '2026-10-26 09:40' },
      { reply_id: 'm1-ack', to: 'ann@example.org', type: 'ack', subject: 'Re: Quiz night', body: 'Hi Ann,\n\nThanks for sending "Quiz night".', sent_at: '2026-10-25 18:02' },
    ],
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
  if (url.pathname === '/admin/api/mail-text') {
    assert.equal(url.searchParams.get('m'), 'msg123abc');
    return send({ from: 'Clerk <clerk@example.org>', subject: 'Hall hire', date: 'Mon, 26 Oct 2026 09:00:00 +0000',
      text: 'Dear website team,\n\nHow do I book the hall for a parish meeting?\nIt would be for about forty people on a weekday evening.\n\nRegards,\nThe Clerk',
      more: '--\nClerk to Example Parish Council\n\nOn 25-10-2026, The Team wrote:\n> Dear Clerk' });
  }
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
    // Menu order and labels, and each page's reminder line (agreed 26 Oct).
    const menu = (await page.locator('nav.side button').allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
    assert.deepEqual(menu, ['Submissions', 'Replies', 'Owed', 'Feedback', 'Holly lessons', 'Contacts', 'Photos', 'Health', 'Activity']);
    assert.match(await page.locator('.intro').innerText(), /^Events and notices sent in by email/);
    for (const [label, start] of [['Owed', /^Emails that got an automatic holding reply/], ['Health', /^The daily diagnostic/], ['Photos', /^Photos in the Lenches Photos folders/]]) {
      await page.locator('nav.side button', { hasText: label }).click();
      assert.match(await page.locator('.intro').innerText(), start, label);
    }
    await page.locator('nav.side button', { hasText: 'Contacts' }).click();
    assert.match(await page.locator('.intro').innerText(), /^Everyone who sends in/);
    await page.getByRole('button', { name: 'Outreach' }).click();
    const main = page.locator('.main');
    await main.getByText('Seasonal due (1)').waitFor();
    const text = await main.innerText();
    for (const want of [/Gone quiet \(1\)/i, /Leads to chase \(1\)/i, /Held back \(1\)/i, /1 of 5 drafts used this week/,
      /Last year: 8 Nov 2025 Quiz night/, /held back: snoozed until 26 Jan 2027/, /never goes by itself/]) assert.match(text, want);
    assert.equal(await main.getByRole('button', { name: 'Draft nudge' }).count(), 3, 'not on held-back rows');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `outreach-${name}.png`), fullPage: true });

    // Sent nudges: folded, then opened; a row opens to the text as it went.
    await main.getByRole('button', { name: 'Show sent' }).click();
    await main.getByText('Your EP release?').click();
    await main.getByText('Any news on the EP?').waitFor();
    assert.match(await main.innerText(), /To George \(george@example\.org\) · sent/);

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
    // Replies screen: their email on the left, Holly's reply on the right (desktop); on a phone,
    // their email folded above the reply in one card.
    await page.locator('nav.side button', { hasText: 'Replies' }).click();
    const draftCard = page.locator('.list .card', { hasText: 'Re: Hall hire' });
    await draftCard.getByText('How do I book the hall').waitFor({ state: 'attached' });
    if (name === 'desktop') {
      await draftCard.click();
      const sel = page.locator('.list .card.sel');
      await sel.getByText('Regards,').waitFor();
      assert.ok(await sel.locator('.their > .text').evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'selected card shows their whole email');
      assert.doesNotMatch(await sel.innerText(), /book the hall through the website/, 'draft not in the left card');
      assert.doesNotMatch(await sel.innerText(), /Clerk to Example Parish Council/, 'signature folded');
      await sel.getByText('Show the rest (signature and earlier emails)').click();
      await sel.getByText('> Dear Clerk').waitFor();
      assert.match(await sel.innerText(), /Clerk to Example Parish Council/);
      const detail = page.locator('.detail');
      assert.match(await detail.innerText(), /HOLLY'S REPLY[\s\S]*The hall can be booked through the website/i);
      assert.doesNotMatch(await detail.innerText(), /How do I book the hall/);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `replies-two-columns-${name}.png`), fullPage: true });
    } else {
      await draftCard.getByText('Their email').click();
      assert.match(await draftCard.innerText(), /How do I book the hall[\s\S]*HOLLY'S REPLY[\s\S]*booked through the website/i);
    }

    // Your own thread: no draft, Reply in Gmail and Done only.
    const ownCard = name === 'desktop' ? page.locator('.list .card', { hasText: 'Re: Your feed' }) : page.locator('.card', { hasText: 'Re: Your feed' });
    if (name === 'desktop') await ownCard.click();
    const ownBox = name === 'desktop' ? page.locator('.detail .card') : ownCard;
    await ownBox.getByRole('link', { name: 'Reply in Gmail' }).waitFor();
    assert.equal(await ownBox.getByRole('button', { name: 'Approve' }).count(), 0);
    assert.equal(await ownBox.getByRole('link', { name: 'Reply in Gmail' }).getAttribute('href'), 'https://mail.google.com/mail/u/0/#all/msg123abc');
    await ownBox.getByRole('button', { name: 'Done' }).click();
    await page.locator('.toast').waitFor();
    assert.deepEqual(posts.pop(), { path: '/admin/api/action', kind: 'reply', id: 'm8-own', action: 'reject' });

    // Replies screen: Sent history of every type, searchable.
    await page.locator('nav.side button', { hasText: 'Replies' }).click();
    await page.getByRole('button', { name: 'Show sent' }).click();
    await page.getByText('Re: Quiz night').waitFor();
    await page.getByText('Re: Quiz night').click();
    const body = page.locator('.sent details[open] .text');
    assert.match(await body.innerText(), /Thanks for sending "Quiz night"\./);
    assert.ok(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'whole email shown, not clipped to 2 lines');
    assert.match(await page.locator('.main').innerText(), /SENT \(2\)|Sent \(2\)/);
    await page.fill('input[aria-label="Search sent"]', 'quiz');
    assert.equal(await page.locator('.sent details').count(), 1);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `replies-sent-${name}.png`), fullPage: true });
    await page.close();
  }
  console.log('ui-outreach: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
