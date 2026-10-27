// worker/test/ui-pageedit.check.mjs
// Browser check of Edit page against the built site (_site; run the Eleventy build first):
// a local "site" serves _site, a local "worker" serves /admin/page, the editor files and
// /admin/api/page-save, with GitHub's contents API mocked from src/. Edits a Privacy
// paragraph, adds a link, saves, and checks the committed file. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-pageedit.check.mjs
// and bundled as Wrangler does (keep-names), which is how the editor script really ships:
//   npx esbuild@0.25 worker/test/ui-pageedit.check.mjs --bundle --keep-names --platform=node \
//     --format=esm --external:playwright --outfile=worker/test/.bundled-check.mjs && node worker/test/.bundled-check.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { editorPage, savePage } from '../src/admin/pageedit.js';
import { PAGEEDIT_JS, PAGEEDIT_CSS } from '../src/admin/ui/pageedit.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-pageedit: Playwright not installed here, skipped');
  process.exit(0);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SITE_DIR = path.join(ROOT, '_site');
if (!fs.existsSync(path.join(SITE_DIR, 'privacy/index.html'))) {
  console.log('ui-pageedit: build the site first (npx @11ty/eleventy)');
  process.exit(1);
}
const SHOTS = process.env.SHOTS || '';

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const site = await listen((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(SITE_DIR, decodeURIComponent(u.pathname));
  if (f.endsWith('/')) f += 'index.html';
  if (!f.startsWith(SITE_DIR) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css' : f.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(fs.readFileSync(f));
});
const SITE = `http://127.0.0.1:${site.address().port}/`;

// GitHub contents API, mocked from the working tree; PUTs are recorded, not written.
const files = {};
const puts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const m = u.match(/^https:\/\/api\.github\.com\/repos\/o\/r\/contents\/([^?]+)/);
  if (!m) return realFetch(url, init);
  const p = m[1];
  if (!(p in files)) files[p] = fs.readFileSync(path.join(ROOT, p), 'utf8');
  if ((init.method || 'GET') === 'PUT') {
    const body = JSON.parse(init.body);
    assert.equal(body.branch, 'main');
    files[p] = Buffer.from(body.content, 'base64').toString('utf8');
    puts.push({ path: p, message: body.message, text: files[p] });
    return new Response(JSON.stringify({ content: {}, commit: { sha: 'a'.repeat(40), committer: { date: new Date().toISOString() } } }), { status: 200 });
  }
  return new Response(JSON.stringify({ content: Buffer.from(files[p]).toString('base64'), sha: 'sha1' }), { status: 200 });
};
const env = { REPO: 'o/r', DISPATCH_TOKEN: 't', SITE_URL: SITE };

let statusChecks = 0;
const worker = await listen(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const origin = `http://127.0.0.1:${worker.address().port}`;
  try {
    if (u.pathname === '/admin/page') {
      const pg = await editorPage(env, { page: u.searchParams.get('p'), origin, csrf: 'tok', version: 't' });
      res.writeHead(pg.status, { 'content-type': 'text/html', 'content-security-policy': pg.csp });
      res.end(pg.html);
    } else if (u.pathname === '/admin/pageedit.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(PAGEEDIT_JS);
    } else if (u.pathname === '/admin/pageedit.css') {
      res.writeHead(200, { 'content-type': 'text/css' }); res.end(PAGEEDIT_CSS);
    } else if (u.pathname === '/admin/api/build-status') {
      // Building on the first check, live on the next.
      assert.equal(u.searchParams.get('sha'), 'a'.repeat(40));
      statusChecks += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      assert.equal(u.searchParams.get('p'), '/privacy/');
      assert.equal(u.searchParams.get('text'), 'For the Lenches website and community mailing list. (updated)');
      res.end(JSON.stringify({ ok: true, state: statusChecks > 2 ? 'live' : 'building', phase: statusChecks === 2 ? 'publishing' : '' }));
    } else if (u.pathname === '/admin/api/page-save' && req.method === 'POST') {
      assert.equal(req.headers['x-csrf-token'], 'tok');
      assert.equal(req.headers.origin, origin);
      let body = '';
      for await (const c of req) body += c;
      const r = await savePage(env, JSON.parse(body));
      res.writeHead(r.ok ? 200 : r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    } else { res.writeHead(404); res.end(); }
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e)); }
});
const ORIGIN = `http://127.0.0.1:${worker.address().port}`;

const browser = await chromium.launch();
const errors = [];
for (const size of [{ width: 1200, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${ORIGIN}/admin/page?p=/privacy/`);
  await page.waitForSelector('.le-bar');
  const editable = await page.locator('.le-edit').count();
  const fixed = await page.locator('.le-fixed').count();
  assert.ok(editable >= 30, `editable blocks: ${editable}`);
  assert.ok(fixed >= 1, 'the template-built paragraph is greyed');
  // Links don't navigate in edit mode.
  await page.locator('[data-src] a').first().click();
  assert.match(page.url(), /\/admin\/page/);
  if (size.name === 'desktop') {
    const lead = page.locator('p.lead.le-edit');
    await lead.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter'); // ignored
    await page.keyboard.type(' (updated)');
    assert.equal(await page.locator('p.lead').count(), 1);
    // Link: select the word "website" in the lead and link it.
    await lead.evaluate((el) => {
      const t = el.firstChild;
      const i = t.data.indexOf('website');
      const r = document.createRange();
      r.setStart(t, i); r.setEnd(t, i + 'website'.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    page.once('dialog', (d) => d.accept('/contact/'));
    await page.click('.le-bar button:has-text("Link")');
    assert.equal(await page.locator('.le-count').textContent(), '1 change');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pageedit-editing.png') });
    await page.click('.le-bar button:has-text("Save")');
    await page.waitForSelector('.le-dlg[open]');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pageedit-confirm.png') });
    await page.click('.le-dlg button:has-text("Save and publish")');
    await page.locator('.le-bar', { hasText: 'Building the site…' }).waitFor();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pageedit-building.png') });
    await page.locator('.le-bar', { hasText: 'waiting for the page to update' }).waitFor({ timeout: 25000 });
    await page.locator('.le-bar', { hasText: 'Live ✓' }).waitFor({ timeout: 25000 });
    assert.equal(await page.locator('.le-view').getAttribute('href'), `${SITE}privacy/?v=aaaaaaa`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pageedit-saved.png') });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, 'src/privacy.njk');
    assert.match(puts[0].message, /^Page edit: privacy\.njk \(1 change/);
    assert.ok(puts[0].text.includes('<p class="lead">For the Lenches <a href="/contact/">website</a> and community mailing list. (updated)</p>'), 'lead saved');
    const before = fs.readFileSync(path.join(ROOT, 'src/privacy.njk'), 'utf8');
    assert.equal(puts[0].text.split('\n').length, before.split('\n').length, 'only that line changed');
    // A second save of the same old text is refused (stale).
    const again = await savePage(env, { path: 'src/privacy.njk', changes: [{ old: 'For the Lenches website and community mailing list.', new: 'x' }] });
    assert.equal(again.status, 409);
  } else if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, 'pageedit-phone.png') });
  }
  await ctx.close();
}
// Bad input is refused by the server whatever the page sends.
for (const bad of ['<script>x</script>', '<a href="javascript:alert(1)">x</a>', '{{ site.email }}', '<img src=x>', '<a onclick="x" href="/">x</a>', '']) {
  const r = await savePage(env, { path: 'src/privacy.njk', changes: [{ old: 'Name', new: bad }] });
  assert.equal(r.ok, false, `refused: ${bad}`);
}
// The h1 repeats the front matter title: still editable.
assert.ok((await savePage(env, { path: 'src/privacy.njk', changes: [{ old: 'Privacy Policy', new: 'Privacy policy' }] })).ok);
assert.equal((await savePage(env, { path: 'src/_includes/base.njk', changes: [] })).status, 400);
assert.equal((await savePage(env, { path: '../package.json', changes: [] })).status, 400);
await browser.close();
site.close();
worker.close();
assert.deepEqual(errors, []);
console.log('ui-pageedit: ok');
