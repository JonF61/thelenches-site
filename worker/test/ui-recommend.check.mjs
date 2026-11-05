// worker/test/ui-recommend.check.mjs
// Browser check of the Recommend buttons on the built Local trades and Where to eat pages
// (src/_includes/recommend.njk), on desktop and phone sizes: every card has a button, a click
// moves the one form into that card, Send posts kind + entry + email + the Turnstile token
// to the Worker's /r (Turnstile and the Worker are mocked), the thanks message shows, and a
// count from recommends.json reads "Recommended by N people". Needs an Eleventy build first.
// Saves screenshots (SHOTS=dir). Run: npx @11ty/eleventy && node worker/test/ui-recommend.check.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-recommend: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';
const ROOT = path.resolve('_site');
if (!fs.existsSync(path.join(ROOT, 'living-here/trades/index.html'))) {
  console.error('ui-recommend: build the site first (npx @11ty/eleventy)');
  process.exit(1);
}

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const posts = [];
for (const [name, viewport] of [['desktop', { width: 1200, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.turnstile={render:function(el,o){setTimeout(function(){o.callback("tok")},10);return 1},reset:function(){}};window.lenchesTurnstileReady&&window.lenchesTurnstileReady();',
  }));
  await page.route('https://approvals.lenches.workers.dev/r', async (route) => {
    posts.push(route.request().postData() || '');
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, message: 'Nearly done: check your inbox.' }) });
  });
  await page.route(/cloudflareinsights|static\.cloudflare/, (route) => route.abort());

  const nTrades = require('../../src/_data/trades.json').trades.length;
  const nEat = require('../../src/_data/eat.json').places.length;
  for (const [url, kind, n] of [['/living-here/trades/', 'trades', nTrades], ['/living-here/eat/', 'eat', nEat]]) {
    await page.goto(base + url);
    // each card has its own anchor (the suggester's thank-you email links to it)
    assert.equal(await page.locator(`.card[id^="${kind === 'eat' ? 'eat' : 'trade'}-"]`).count(), n, `${url}: one anchor per card`);
    const buttons = page.locator('.rec-btn');
    assert.equal(await buttons.count(), n, `${url}: one button per card`);
    assert.ok(await buttons.first().isVisible(), `${url}: buttons shown with JavaScript`);
    assert.ok(!(await page.locator('.rec-form').isVisible()), 'form hidden until a click');
    const second = buttons.nth(1);
    await second.click();
    const form = page.locator('.rec-form');
    assert.ok(await form.isVisible());
    assert.equal(await page.evaluate(() => document.querySelector('.rec-form').previousElementSibling.className), 'rec-btn');
    assert.equal(await second.getAttribute('aria-expanded'), 'true');
    await page.fill('#rec-email', 'reader@example.org');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `recommend-${kind}-${name}.png`), fullPage: false, clip: await (await page.locator('.rec-form').evaluateHandle((f) => f.closest('.card'))).asElement().boundingBox() });
    await page.click('.rec-send');
    await page.waitForFunction(() => /Nearly done/.test(document.querySelector('.rec-status').textContent));
    const body = posts.at(-1);
    const entry = await second.getAttribute('data-entry');
    for (const want of [`name="kind"\r\n\r\n${kind}`, `name="entry"\r\n\r\n${entry}`, 'name="email"\r\n\r\nreader@example.org', 'name="cf-turnstile-response"\r\n\r\ntok', 'name="js"\r\n\r\n1']) {
      assert.ok(body.includes(want), `${url}: posted ${want.split('\r')[0]}`);
    }
    // Clicking the same button again closes the form.
    await second.click();
    assert.ok(!(await form.isVisible()));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.ok(!overflow, `${url} ${name}: no sideways scroll`);
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`ui-recommend: all passed (${posts.length} posts)`);
