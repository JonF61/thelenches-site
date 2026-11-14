// worker/test/ui-listingsuggest.check.mjs
// Browser check of Suggest a tradesperson / somewhere to eat, on desktop and phone sizes:
//  1. the built Local trades and Where to eat pages (needs an Eleventy build): the form at the
//     foot with the approved labels and note, no "Tell us" line, Send suggestion posts every
//     field plus the Turnstile token to the Worker's /sg (both mocked), the thanks shows, and
//     no sideways scroll;
//  2. the panel's Suggestions screen (ui/client.js) against a mock API: the menu count, the
//     card (what was suggested, the why, "Already listed?", what Approve adds), and what
//     Approve, Edit (Save and approve) and Reject post; the Summary line.
// Saves screenshots (SHOTS=dir). Run: npx @11ty/eleventy && node worker/test/ui-listingsuggest.check.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';
import { panelRows } from '../src/admin/suggestions.mjs';
import tradesData from '../../src/_data/trades.json' with { type: 'json' };
import eatData from '../../src/_data/eat.json' with { type: 'json' };

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-listingsuggest: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const ROOT = path.resolve('_site');
if (!fs.existsSync(path.join(ROOT, 'living-here/trades/index.html'))) {
  console.error('ui-listingsuggest: build the site first (npx @11ty/eleventy)');
  process.exit(1);
}
const DATA = { trades: tradesData, eat: eatData };

const sheetRows = [
  { _row: 2, id: 'sg-20261103-aaaaaa', kind: 'trades', name: 'Smith Electrical', trade: 'electricians', contact: '07700 900123', area: 'Rous Lench',
    why: 'Rewired our cottage, tidy and on time.', email: 'hidden@example.org', key: 'k', status: 'confirmed', confirmed_at: '2026-11-03 14:12' },
  { _row: 3, id: 'sg-20261103-bbbbbb', kind: 'eat', name: 'Anchor Inn', trade: 'pub', contact: 'theanchor.co.uk', area: 'Wyre Piddle',
    why: '', email: 'x@example.org', key: 'k2', status: 'confirmed', confirmed_at: '2026-11-03 15:00' },
  { _row: 4, id: 'sg-20261103-cccccc', kind: 'eat', name: 'Not yet', trade: 'cafe', contact: '01386 000000', area: '', email: 'y@example.org', status: 'sent' },
];
function stateData() {
  return {
    email: 'admin@example.org', sheetId: 'sheet', gids: { 'Listing suggestions': 12 }, holiday: { value: 'FALSE', on: false }, newsletter: null,
    health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
    pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
    photoFolders: [], photosRoot: 'r', today: '2026-11-03', toDelete: [], feedback: { headers: [], rows: [] },
    listingSuggestions: panelRows({ headers: [], rows: sheetRows }, DATA),
    listingOptions: { trades: [...new Set(tradesData.trades.map((t) => t.trade))].sort(), eat: eatData.areas },
  };
}

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const posts = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname.startsWith('/admin/api/')) {
    if (req.method === 'GET') return send({ error: 'not mocked' }, 'application/json', 500);
    let body = '';
    for await (const c of req) body += c;
    posts.push({ path: url.pathname, ...(body ? JSON.parse(body) : {}) });
    return send({ ok: true, message: 'Done. It takes a minute or two to show in the Sheet.' });
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const formPosts = [];
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    // 1. The public forms.
    const page = await browser.newPage({ viewport });
    await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({
      contentType: 'text/javascript',
      body: 'window.turnstile={render:function(el,o){setTimeout(function(){o.callback("tok")},10);return 1},reset:function(){}};window.lenchesTurnstileReady&&window.lenchesTurnstileReady();',
    }));
    await page.route('https://approvals.lenches.workers.dev/sg', async (route) => {
      formPosts.push(route.request().postData() || '');
      await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, message: 'Nearly done: check your inbox.' }) });
    });
    await page.route(/cloudflareinsights|static\.cloudflare/, (route) => route.abort());
    for (const [url, kind, heading, tradeLabel] of [
      ['/living-here/trades/', 'trades', 'Suggest a tradesperson', 'Trade *'],
      ['/living-here/eat/', 'eat', 'Suggest somewhere to eat', 'Type, e.g. pub, café *'],
    ]) {
      await page.goto(base + url);
      const form = page.locator('.sg-form');
      assert.equal(await page.locator('.sg h2').innerText(), heading);
      assert.ok(!(await page.locator('main').innerText()).includes('Tell us'), `${url}: no Tell us line`);
      const labels = await form.locator('label').allInnerTexts();
      for (const want of ['Their name *', tradeLabel, 'Phone or website *', 'Area or village', 'Why you’d recommend them (optional, only we see this)', 'Your email *']) {
        assert.ok(labels.includes(want), `${url}: label ${want}`);
      }
      assert.equal(await form.locator('.sg-note').innerText(), 'We’ll email you a link to confirm. You can send up to 10 suggestions a day. We check every suggestion before it goes on the page.');
      assert.equal(await form.locator('.sg-send').innerText(), 'Send suggestion');
      await page.fill('#sg-name', 'Smith Electrical');
      await page.fill('#sg-trade', kind === 'eat' ? 'pub' : 'electricians');
      await page.fill('#sg-contact', '07700 900123');
      await page.fill('#sg-area', 'Rous Lench');
      await page.fill('#sg-why', 'Tidy work');
      await page.fill('#sg-email', 'reader@example.org');
      if (SHOTS) await page.locator('.sg').screenshot({ path: path.join(SHOTS, `suggest-form-${kind}-${name}.png`) });
      await page.click('.sg-send');
      await page.waitForFunction(() => /Nearly done/.test(document.querySelector('.sg-status').textContent));
      const body = formPosts.at(-1);
      for (const want of [`name="kind"\r\n\r\n${kind}`, 'name="name"\r\n\r\nSmith Electrical', 'name="contact"\r\n\r\n07700 900123', 'name="area"\r\n\r\nRous Lench',
        'name="why"\r\n\r\nTidy work', 'name="email"\r\n\r\nreader@example.org', 'name="cf-turnstile-response"\r\n\r\ntok', 'name="js"\r\n\r\n1', 'name="website"\r\n\r\n\r\n']) {
        assert.ok(body.includes(want), `${url}: posted ${want.split('\r')[0]}`);
      }
      assert.equal(await page.inputValue('#sg-name'), '', 'boxes cleared after sending');
      assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${url} ${name}: no sideways scroll`);
    }
    await page.close();

    // 2. The panel.
    posts.length = 0;
    const panel = await browser.newPage({ viewport });
    panel.on('dialog', (d) => d.accept());
    await panel.goto(`${base}/admin`);
    await panel.locator('nav.side button', { hasText: 'Suggestions' }).waitFor();
    assert.ok((await panel.locator('.main').textContent()).includes('Suggestions (2)'), 'Summary line');
    assert.equal(await panel.locator('nav.side button', { hasText: 'Suggestions' }).locator('.n').innerText(), '2');
    await panel.locator('nav.side button', { hasText: 'Suggestions' }).click();
    const text = await panel.locator('.main').textContent();
    assert.ok(text.includes('Waiting (2)'));
    assert.ok(!text.includes('Not yet'), 'unconfirmed rows not shown');
    assert.ok(!text.includes('example.org'), 'no address on the page');
    const smith = panel.locator('.main .card', { hasText: 'Smith Electrical' });
    assert.ok((await smith.innerText()).includes('Rewired our cottage'));
    assert.ok((await smith.innerText()).includes('Suggestion · Local trades'));
    const anchor = panel.locator('.main .card', { hasText: 'Anchor Inn' });
    assert.ok((await anchor.innerText()).includes('Already listed? Similar name: "The Anchor Inn"'));
    assert.ok((await anchor.innerText()).includes('Nearby villages'), 'area worked out');
    if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `suggestions-panel-${name}.png`), fullPage: true });

    await smith.getByRole('button', { name: 'Edit' }).click();
    await panel.locator('.overlay #sg-name').waitFor();
    assert.equal(await panel.inputValue('.overlay #sg-name'), 'Smith Electrical');
    assert.equal(await panel.inputValue('.overlay #sg-trade'), 'Electricians');
    await panel.fill('.overlay #sg-what', 'Rewiring and fuse boards');
    await panel.fill('.overlay #sg-wurl', 'smithelectrical.co.uk');
    if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, `suggestions-edit-${name}.png`) });
    await panel.getByRole('button', { name: 'Save and approve' }).click();
    await panel.waitForFunction(() => !document.querySelector('.overlay'));
    await anchor.getByRole('button', { name: 'Reject' }).click();
    await panel.fill('#sgr', 'Already listed');
    await panel.locator('.overlay button[type=submit]').click();
    await panel.waitForFunction(() => !document.querySelector('.overlay'));
    assert.ok((await panel.locator('.main').textContent()).includes('Nothing waiting.'));

    const acts = posts.filter((p) => p.path === '/admin/api/action');
    assert.deepEqual(acts.map((p) => [p.kind, p.id, p.action]), [
      ['suggestion', 'sg-20261103-aaaaaa', 'edit'], ['suggestion', 'sg-20261103-bbbbbb', 'reject']]);
    assert.equal(acts[0].fields.what, 'Rewiring and fuse boards');
    assert.equal(acts[0].fields.phone, '07700 900123');
    assert.deepEqual(acts[0].fields.website, { text: '', url: 'smithelectrical.co.uk' });
    assert.equal(acts[1].reason, 'Already listed');
    await panel.close();

    // Approve as shown (fresh page).
    posts.length = 0;
    const p2 = await browser.newPage({ viewport });
    p2.on('dialog', (d) => d.accept());
    await p2.goto(`${base}/admin`);
    await p2.locator('nav.side button', { hasText: 'Suggestions' }).click();
    await p2.locator('.main .card', { hasText: 'Smith Electrical' }).getByRole('button', { name: 'Approve' }).click();
    await p2.waitForFunction(() => document.querySelectorAll('.main .card.sg-card').length === 1);
    assert.deepEqual(posts.filter((p) => p.path === '/admin/api/action').map((p) => [p.kind, p.id, p.action]), [['suggestion', 'sg-20261103-aaaaaa', 'approve']]);
    assert.ok(!(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `panel ${name}: no sideways scroll`);
    await p2.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`ui-listingsuggest: all passed (${formPosts.length} form posts)`);
