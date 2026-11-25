#!/usr/bin/env node
// Preview screenshots for Jon (CLAUDE.md "Preview before merge"). Run from the repo root.
//
//   node .claude/skills/preview/shot.js site --site lenches --pages /notices/,/living-here/planning/ \
//        --out <scratch>/preview --label after [--selector '.notice'] [--no-build] [--build-dir <dir>]
//   node .claude/skills/preview/shot.js newsletter --site harvington --out <scratch>/preview --label after \
//        [--today 2026-11-25] [--sheet]
//
// site:       builds that site with Eleventy into a scratch folder (unless --no-build), serves it on
//             localhost and screenshots each page at desktop (1280) and phone (390) width; --selector
//             shoots just the first matching element (the changed part), else the whole page.
// newsletter: renders the next issue LIVE from this working copy (never the frozen snapshot, which is
//             the point: you are previewing code or data that isn't built yet), with hand-written items
//             and data files; --sheet adds this site's live Pending rows through k.py (needs KRYTEN_TOKEN).
//             Shot at 600 (email width) and 390. Also writes the .html and .txt beside the pictures.
// Pictures are named <label>-<site>-<page>-<width>.png, so a "before" and "after" run sit side by side.
// Screenshots are at deviceScaleFactor 1 (they are for checking); use --scale 2 for ones Jon keeps.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const site = opt('site', 'lenches');
const out = path.resolve(opt('out', 'preview'));
const label = opt('label', 'after');
const scale = Number(opt('scale', 1));
if (!['site', 'newsletter'].includes(mode)) { console.error('First argument: site or newsletter'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const slug = (p) => (p.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let f = path.join(dir, p);
      if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function shoot(urlOrHtml, name, widths, selector) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const files = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale });
      if (urlOrHtml.startsWith('http')) await page.goto(urlOrHtml, { waitUntil: 'networkidle' }).catch(() => page.goto(urlOrHtml));
      else await page.setContent(urlOrHtml, { waitUntil: 'networkidle' }).catch(() => {});
      const file = path.join(out, `${label}-${site}-${name}-${width}.png`);
      const el = selector ? await page.$(selector) : null;
      if (selector && !el) console.warn(`  ${name} @${width}: no element matches ${selector}; shooting the whole page`);
      if (el) await el.screenshot({ path: file }); else await page.screenshot({ path: file, fullPage: true });
      files.push(file);
      await page.close();
    }
  } finally { await browser.close(); }
  return files;
}

async function siteMode() {
  const pages = String(opt('pages', '/')).split(',').map((p) => p.trim()).filter(Boolean);
  const dir = path.resolve(opt('build-dir', path.join(out, `build-${label}-${site}`)));
  if (!opt('no-build', false)) {
    console.log(`Building ${site} into ${dir}…`);
    const r = spawnSync('npx', ['@11ty/eleventy', '--quiet', `--output=${dir}`], { env: { ...process.env, SITE: site }, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { console.error('Eleventy build failed'); process.exit(1); }
  }
  const srv = await serve(dir);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of pages) {
      const files = await shoot(base + p, slug(p), [1280, 390], opt('selector', ''));
      console.log(`${p}: ${files.join(' ')}`);
    }
  } finally { srv.close(); }
}

async function newsletterMode() {
  process.env.SITE = site; // lib/site.js reads it when first required
  const root = process.cwd();
  const req = (p) => require(path.join(root, p));
  const { buildDraft } = req('scripts/newsletter/draft.js');
  const { loadWhatson, imageFile } = req('lib/whatson.js');
  const { SITE_REL, siteConfig } = req('lib/site.js');
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return null; } };
  const url = String(siteConfig().url || '').replace(/\/$/, '');
  const jpegFor = (webpUrl) => {
    if (!webpUrl || !String(webpUrl).startsWith('/')) return '';
    const rel = String(webpUrl).replace(/\.webp$/, '.jpg');
    return imageFile(rel) ? `${url}${rel}` : '';
  };
  let pending = [];
  if (opt('sheet', false)) {
    const raw = execFileSync('python3', ['.claude/skills/sheet-access/k.py', 'read', 'Pending', '--json', '--site', site], { encoding: 'utf8', maxBuffer: 64 << 20 });
    pending = JSON.parse(raw);
    console.log(`Pending rows from the ${site} Sheet: ${pending.length}`);
  }
  const today = opt('today', new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now()));
  const { meta, html } = buildDraft({
    today, pending, issues: [], settings: {}, sources: [], jpegFor, whatson: loadWhatson(),
    bins: readJson(`${SITE_REL}/_data/bins.json`), siteupdates: readJson(`${SITE_REL}/_data/siteupdates.json`),
    onthisday: readJson(`${SITE_REL}/_data/onthisday.json`), cartoons: readJson(`${SITE_REL}/_data/cartoons.json`),
    wherelenches: readJson(`${SITE_REL}/_data/wherelenches.json`), planning: readJson(`${SITE_REL}/_data/planning.json`),
    photos: readJson(`${SITE_REL}/_data/photos.json`),
  });
  const base = path.join(out, `${label}-${site}-newsletter`);
  fs.writeFileSync(`${base}.html`, html);
  console.log(`Issue ${meta.issue_date}: ${meta.items} items (${meta.events} events, ${meta.notices} notices). HTML: ${base}.html`);
  const files = await shoot(html, 'newsletter', [600, 390], opt('selector', ''));
  console.log(`Screenshots: ${files.join(' ')}`);
}

(mode === 'site' ? siteMode() : newsletterMode()).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
