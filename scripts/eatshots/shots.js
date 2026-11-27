// Where to eat website pictures (27 Nov 2026, Jon): until a venue sends a photo, its card can show a
// picture of its own website's front page. Run by eat-shots.yml on a Kryten branch (never main):
// for each Where to eat entry on every site with a website that isn't Facebook, opens the page in
// Chromium, tries to close a cookie banner, takes a 1280x800 screenshot and saves an 800x500 JPEG to
// scripts/eatshots/candidates/<id>.jpg, plus the page's visible text to scripts/eatshots/text/<id>.txt
// (public website text, for Kryten to read the facts from). Kryten checks each picture before any
// is copied into a site's images. Optional EAT_IDS (comma separated) limits it to those entries.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'candidates');
const TXT = path.join(__dirname, 'text');
const ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|ok|got it|accept & close|continue)$/i;

function places() {
  const seen = new Map();
  for (const site of fs.readdirSync(path.join(ROOT, 'sites'))) {
    const f = path.join(ROOT, 'sites', site, '_data', 'eat.json');
    if (!fs.existsSync(f)) continue;
    for (const p of JSON.parse(fs.readFileSync(f, 'utf8')).places || []) {
      const url = p.website && p.website.url;
      if (!p.id || !url || /facebook\.com/i.test(url) || seen.has(p.id)) continue;
      seen.set(p.id, url);
    }
  }
  const only = (process.env.EAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...seen].filter(([id]) => !only.length || only.includes(id));
}

async function closeBanner(page) {
  for (const frame of page.frames()) {
    const buttons = await frame.$$('button, a[role=button], [role=button], input[type=button], input[type=submit]').catch(() => []);
    for (const b of buttons) {
      const t = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim();
      if (ACCEPT.test(t) && (await b.isVisible().catch(() => false))) {
        await b.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1200);
        return true;
      }
    }
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TXT, { recursive: true });
  const browser = await chromium.launch();
  let ok = 0;
  for (const [id, url] of places()) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-GB' });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => page.waitForTimeout(5000));
      await page.waitForTimeout(2500);
      const closed = await closeBanner(page);
      const png = await page.screenshot();
      await sharp(png).resize(800, 500).jpeg({ quality: 78, mozjpeg: true }).toFile(path.join(OUT, `${id}.jpg`));
      const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      fs.writeFileSync(path.join(TXT, `${id}.txt`), `${page.url()}\n\n${text}`);
      console.log(`${id}: done${closed ? ' (closed a cookie banner)' : ''}`);
      ok++;
    } catch (e) {
      console.log(`${id}: failed: ${String(e.message).slice(0, 120)}`);
    }
    await page.close();
  }
  await browser.close();
  console.log(`${ok} pictures saved.`);
})();
