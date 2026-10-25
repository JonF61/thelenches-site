// worker/test/ui-feedback.check.mjs
// Browser check of the panel's Feedback screen (ui/client.js) against a mock API, on desktop
// and phone sizes: the status-strip chip and count, the Waiting / Reply drafts / Approved,
// awaiting build / Postponed sections, the page link, rating and commentary, and what each
// button posts (Approve, Reject, Postpone with its date, Add note with the stale-check
// value, Mark implemented, Send, Edit, Skip).
// Saves screenshots (SHOTS=dir). Needs Playwright (not a site dependency):
// Run: node worker/test/ui-feedback.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-feedback: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const fb = (id, state, extra) => ({
  _row: 2, id, _state: state, received: '2026-10-24 19:12', type: 'correction', page_url: 'https://thelenches.org.uk/halls/',
  page_title: 'Village halls', message: 'The Church Lench hall phone number is out of date. It is now 01386 111111.',
  email: '', rating: '', commentary: '', status: 'new', notes: '', reply_draft: '', reply_sent: '', ...extra,
});
function stateData() {
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: { Feedback: 9 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
    photoFolders: [], photosRoot: 'r', today: '2026-10-25', toDelete: [],
    feedback: { headers: [], rows: [
      fb('fb-1', 'waiting', { _row: 2, rating: '4', commentary: 'Useful fix, two minutes to make; check the number with the hall first.', email: 'reader@example.org' }),
      fb('fb-2', 'waiting', { _row: 3, type: 'other', page_title: 'Home', page_url: 'https://thelenches.org.uk/', message: 'Lovely site, thank you.' }),
      fb('fb-3', 'waiting', { _row: 4, type: 'update', rating: '2', commentary: 'Nice idea but a lot of work for few readers.', message: 'Could you add bus times?', email: 'bus@example.org' }),
      fb('fb-4', 'approved', { _row: 5, status: 'approved', rating: '5', commentary: 'Quick win.', notes: '2026-10-24 20:01 Ask Sue for the new times', email: 'x@example.org' }),
      fb('fb-5', 'reply', { _row: 6, status: 'implemented', rating: '4', email: 'r@example.org',
        reply_draft: 'Hi there,\n\nThanks for letting us know. We\'ve changed the number to 01386 111111.\nhttps://thelenches.org.uk/halls/\n\nBest wishes,\nHolly\nLenches website assistant' }),
      fb('fb-6', 'postponed', { _row: 7, status: 'postponed until 2026-11-20', type: 'update', message: 'Add the Christmas lights switch-on' }),
      fb('fb-7', 'reply', { _row: 8, status: 'rejected', email: 'back@example.org', message: 'Add more photos of the hall',
        conversation: '[2026-10-25 17:40] Holly:\nHi there,\n\nThanks for the suggestion. We won\'t be adding more photos this time.\n\n[2026-10-26 09:12] Reader:\nFair enough, could you add the hall\'s booking link instead?',
        reply_draft: 'Hi there,\n\nThanks for getting back to us. We\'ll take a look at the booking link.\n\nBest wishes,\nHolly\nLenches website assistant' }),
      fb('fb-8', 'done', { _row: 9, status: 'implemented', decided: '2026-10-20 10:00', implemented: '2026-10-21 09:00', reply_sent: '2026-10-21 09:30',
        message: 'The bin day is wrong for Atch Lench', reply_draft: 'Hi there,\n\nThanks, we have fixed the bin day.\n\nBest wishes,\nHolly' }),
      fb('fb-9', 'done', { _row: 10, status: 'rejected', decided: '2026-10-19 10:00', message: 'Please list my business' }),
    ] },
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
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : {};
  posts.push({ path: url.pathname, ...b });
  if (url.pathname === '/admin/api/feedback-note') return send({ ok: true, value: `${b.expected ? `${b.expected}\n` : ''}2026-10-25 12:00 ${b.note}` });
  return send({ ok: true, message: 'Done. It takes a minute or two to show in the Sheet.' });
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    posts.length = 0;
    const page = await browser.newPage({ viewport });
    page.on('dialog', (d) => d.accept());
    await page.goto(`${base}/admin`);
    const chip = page.locator('button.chip', { hasText: 'Feedback' });
    await chip.waitFor();
    assert.match(await chip.innerText(), /3 waiting · 2 replies/);
    const navN = page.locator('nav.side button', { hasText: 'Feedback' }).locator('.n');
    assert.equal(await navN.innerText(), '5', 'waiting plus reply drafts');
    assert.match(await navN.getAttribute('class'), /attn/);
    await chip.click();
    const text = await page.locator('.main').textContent();
    for (const s of ['Waiting (3)', 'Reply drafts (2)', 'Approved, awaiting build (1)', 'Postponed (1)', 'History (2)']) assert.ok(text.includes(s), s);
    assert.ok(!text.includes('bin day is wrong'), 'history hidden until shown');
    // They replied: first among the drafts, with the conversation and Close, no reply.
    const back = page.locator('.main .card', { hasText: 'booking link instead' });
    assert.ok(await back.getByText('They replied').isVisible());
    assert.ok(await back.getByText('We sent').first().isVisible());
    assert.ok(await back.getByRole('button', { name: 'Close, no reply' }).isVisible());
    assert.ok(text.indexOf('booking link instead') < text.indexOf('changed the number'), 'they-replied first');
    assert.ok(!text.includes('Christmas lights'), 'postponed hidden until shown');
    // Highest rating first, unrated last.
    const titles = await page.locator('.main .card h2').allInnerTexts();
    assert.deepEqual(titles.slice(0, 3), ['Village halls', 'Village halls', 'Home']);
    assert.ok(text.indexOf('Rating 4/5') < text.indexOf('Rating 2/5'));
    assert.equal(await page.locator('.main .card h2 a').first().getAttribute('href'), 'https://thelenches.org.uk/halls/');
    assert.ok(text.includes('Claude: Useful fix'));
    await page.getByRole('button', { name: 'Show history' }).click();
    assert.ok((await page.locator('.main').textContent()).includes('bin day is wrong'));
    assert.ok(await page.locator('.main .card', { hasText: 'bin day is wrong' }).getByText('Reply sent', { exact: true }).isVisible());
    await page.fill('input[type=search]', 'business');
    await page.waitForFunction(() => !document.querySelector('.main').textContent.includes('bin day is wrong'));
    assert.ok((await page.locator('.main').textContent()).includes('Please list my business'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `feedback-${name}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Hide history' }).click();

    const card = (n) => page.locator('.main .card').nth(n);
    await card(0).getByRole('button', { name: 'Add note' }).click();
    await page.fill('#fbn', 'Rang the hall');
    await page.getByRole('button', { name: 'Add note' }).last().click();
    await page.waitForFunction(() => document.body.innerText.includes('Rang the hall'));
    await card(0).getByRole('button', { name: 'Postpone' }).click();
    await page.fill('#fbd', '2026-11-08');
    await page.locator('.overlay button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('.overlay'));
    await page.locator('.main .card', { hasText: 'Lovely site' }).getByRole('button', { name: 'Approve' }).click();
    await page.locator('.main .card', { hasText: 'bus times' }).getByRole('button', { name: 'Reject' }).click();
    await page.fill('#fbr', 'Too much upkeep');
    await page.locator('.overlay button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('.overlay'));
    await page.locator('.main .card', { hasText: 'Ask Sue' }).getByRole('button', { name: 'Mark implemented' }).click();
    const reply = page.locator('.main .card', { hasText: 'Reply draft to r@example.org' });
    await reply.getByRole('button', { name: 'Edit' }).click();
    await page.fill('#fbe', 'Hi there,\n\nAll fixed now.');
    await page.locator('.overlay button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('.overlay'));

    const actions = posts.filter((p) => p.path === '/admin/api/action').map((p) => [p.kind, p.id, p.action, p.date || p.body || p.reason || '']);
    assert.deepEqual(actions, [
      ['feedback', 'fb-1', 'postpone', '2026-11-08'],
      ['feedback', 'fb-2', 'approve', ''],
      ['feedback', 'fb-3', 'reject', 'Too much upkeep'],
      ['feedback', 'fb-4', 'done', ''],
      ['feedback', 'fb-5', 'edit', 'Hi there,\n\nAll fixed now.'],
    ]);
    const note = posts.find((p) => p.path === '/admin/api/feedback-note');
    assert.deepEqual([note.id, note.expected, note.note], ['fb-1', '', 'Rang the hall']);
    assert.match(await page.locator('nav.side').innerText(), /Feedback\s*1/, 'the reader who wrote back still waits');
    await page.close();
  }
  console.log('ui-feedback: all checks passed');
} finally {
  await browser.close();
  server.close();
}
