// worker/test/ui-pageedit.check.mjs
// Browser check of Edit page against the built site (_site; run the Eleventy build first):
// a local "site" serves _site, a local "worker" serves /admin/page, the editor files and
// /admin/api/page-save, with GitHub's contents API mocked from src/. Edits a Privacy
// paragraph, adds a link, saves, and checks the committed file. Then listing entries ("edit
// everything", 4 Nov): Local trades and Events entries are outlined with their label, a click opens
// the edit box with the entry's current values, Save and publish sends one entryedit decision
// (mocked) and the box shows Saving → Live ✓; official notices stay untouched. Saves screenshots (SHOTS=dir).
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
import { entryInfo, saveEntry } from '../src/admin/entryedit.js';

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
let entryChecks = 0;
const decisions = [];
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
    } else if (u.pathname === '/admin/api/entry') {
      const r = await entryInfo(env, u.searchParams.get('key'));
      res.writeHead(r.ok ? 200 : r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    } else if (u.pathname === '/admin/api/entry-save' && req.method === 'POST') {
      assert.equal(req.headers['x-csrf-token'], 'tok');
      let body = '';
      for await (const c of req) body += c;
      const r = await saveEntry(env, JSON.parse(body), {
        meta: { mode: 'frozen', status: 'tested', issue_date: '2026-11-05' },
        send: async (e, pl, reason, b) => { decisions.push({ pl, b }); return true; },
      });
      res.writeHead(r.ok ? 200 : r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    } else if (u.pathname === '/admin/api/entry-status') {
      entryChecks += 1;
      assert.match(u.searchParams.get('id'), /^ee[0-9a-f]{16}$/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: entryChecks > 2 ? 'live' : 'building', phase: entryChecks === 1 ? 'saving' : 'publishing' }));
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
// Listing entries on the Local trades and Events pages.
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const trades = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/_data/trades.json'), 'utf8')).trades;
  const t = trades.find((x) => x.id && x.what);
  await page.goto(`${ORIGIN}/admin/page?p=/living-here/trades/`);
  await page.waitForSelector('.le-bar');
  assert.ok(await page.locator('.le-entry').count() >= trades.length, 'every trade has outlined fields');
  assert.equal(await page.locator('.le-edit').count() > 0, true, 'the page\'s own wording is still editable');
  const card = page.locator(`[data-entry="t:${t.id}"]`);
  // Names stay Ask Kryten (greyed), the fields are outlined, the label shows on hover.
  assert.equal(await card.locator('h3.le-fixed').count(), 1);
  const does = card.locator('dd[data-field="what"]');
  await does.hover();
  assert.equal(await page.locator('.le-tag').textContent(), `Local trades: ${t.name} · click to edit`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'entryedit-outline.png') });
  await does.click();
  const form = page.locator('.le-entry-form');
  await form.waitFor();
  const box = form.locator('input.le-ef-in');
  await box.waitFor();
  assert.equal(await box.inputValue(), t.what);
  await box.fill(`${t.what} (also evenings)`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'entryedit-box.png') });
  await form.locator('button:has-text("Save and publish")').click();
  await form.locator('.le-new', { hasText: '(also evenings)' }).waitFor();
  await form.locator('button:text-is("Publish")').click();
  await form.locator('.le-ef-msg', { hasText: 'Saving the change' }).waitFor();
  await form.locator('.le-ef-note', { hasText: 'Test send it again' }).waitFor();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'entryedit-saving.png') });
  await form.locator('.le-ef-msg', { hasText: 'Live ✓' }).waitFor({ timeout: 30000 });
  assert.equal(await does.textContent(), `${t.what} (also evenings)`);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].pl.a, 'entryedit');
  assert.deepEqual(JSON.parse(decisions[0].b), { key: `t:${t.id}`, changes: [{ field: 'what', old: t.what, new: `${t.what} (also evenings)` }] });
  assert.match(await form.locator('.le-view').getAttribute('href'), /\/living-here\/trades\/\?v=/);
  // While a change is saving, the card isn't opened again; afterwards it is.
  await form.locator('button:has-text("Close")').click();
  assert.equal(await page.locator('.le-entry-form').count(), 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'entryedit-live.png') });

  // Events: a hand-written event's text (a textarea) and its link (words and address).
  await page.goto(`${ORIGIN}/admin/page?p=/events/`);
  await page.waitForSelector('.le-bar');
  const evCard = page.locator('[data-entry^="h:events/"]').filter({ has: page.locator('a[data-field="link"]') }).first();
  const key = await evCard.getAttribute('data-entry');
  const ev = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/items/events', key.slice('h:events/'.length)), 'utf8'));
  await evCard.locator('a[data-field="link"]').click();
  assert.match(page.url(), /\/admin\/page/);
  const lf = page.locator('.le-entry-form');
  await lf.locator('input.le-ef-in').first().waitFor();
  assert.deepEqual(await lf.locator('input.le-ef-in').evaluateAll((els) => els.map((e) => e.value)), [ev.link.text, ev.link.url]);
  await lf.locator('input.le-ef-in').nth(1).fill('javascript:alert(1)');
  await lf.locator('button:has-text("Save and publish")').click();
  await lf.locator('button:text-is("Publish")').click();
  await lf.locator('.le-ef-msg', { hasText: 'Links must start' }).waitFor();
  assert.equal(decisions.length, 1, 'a bad link is refused');
  await lf.locator('button:has-text("Back")').click();
  await lf.locator('button:has-text("Cancel")').click();
  await evCard.locator('p[data-field="body"]').first().click();
  const ta = page.locator('.le-entry-form textarea');
  await ta.waitFor();
  assert.equal(await ta.inputValue(), ev.body);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'entryedit-event.png') });
  await ctx.close();

  // Notices: official statements carry no entry tags (Ask Kryten).
  const nctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const np = await nctx.newPage();
  np.on('pageerror', (e) => errors.push(e.message));
  await np.goto(`${ORIGIN}/admin/page?p=/notices/`);
  await np.waitForSelector('.le-bar');
  assert.equal(await np.locator('.np-official [data-entry], .np-official.le-entry-card').count(), 0);
  assert.ok(await np.locator('.np-card.le-entry-card').count() > 0);
  await nctx.close();
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
