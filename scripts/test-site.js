// Tests for the multi-site setting (lib/site.js, worker/src/sites.js, the Eleventy input; 16 Nov 2026).
// Run: node scripts/test-site.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const ok = (c, what) => { assert.ok(c, what); checks += 1; };

function fresh(env) {
  const saved = process.env.SITE;
  if (env === undefined) delete process.env.SITE; else process.env.SITE = env;
  delete require.cache[require.resolve('../lib/site.js')];
  try { return require('../lib/site.js'); } finally { if (saved === undefined) delete process.env.SITE; else process.env.SITE = saved; }
}

async function main() {
  const d = fresh(undefined);
  ok(d.SITE === 'lenches' && d.SITE_REL === 'sites/lenches', 'no SITE: the Lenches');
  ok(d.siteDir('_data', 'eat.json') === path.join(ROOT, 'sites/lenches/_data/eat.json'), 'siteDir');
  ok(d.siteRel('items/regulars.json') === 'sites/lenches/items/regulars.json', 'siteRel');
  ok(d.siteConfig().site === 'lenches' && d.siteConfig().email === 'website@thelenches.org.uk', 'Lenches config');
  ok(Array.isArray(d.siteData('nothing-here', [])), 'a missing data file gives the fallback');

  const h = fresh('Harvington');
  ok(h.SITE === 'harvington' && h.SITE_REL === 'sites/harvington', 'SITE=Harvington');
  const hc = h.siteConfig();
  ok(hc.email === 'website@harvingtonvillage.org.uk' && hc.gmailLabel === 'Harvington Website/2 Pipeline', 'Harvington address and label');
  ok(!hc.noindex && hc.skyline === 'spire' && hc.palette.vars.green === '#2D4A63', 'Harvington launched (stage 7b), spire, river blue');
  ok(fs.existsSync(h.siteDir('items', 'events')) && fs.existsSync(h.siteDir('items', 'notices')), 'Harvington content folders');
  assert.throws(() => fresh('elsewhere'), /Unknown SITE/); checks += 1;

  // Every site's config carries the multi-site keys.
  for (const s of d.SITES) {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites', s, '_data', 'site.json'), 'utf8'));
    for (const k of ['site', 'url', 'domain', 'name', 'email', 'gmailLabel', 'fromName', 'hollySignoff', 'newsletterName']) ok(c[k], `${s} site.json has ${k}`);
    ok(c.site === s, `${s} site.json names itself`);
  }

  // The Worker sees the same sites.
  const w = await import(path.join(ROOT, 'worker/src/sites.js'));
  ok(w.DEFAULT_SITE === 'lenches' && w.siteRel() === 'sites/lenches' && w.siteRel('harvington') === 'sites/harvington', 'Worker siteRel');
  ok(w.siteConfig('nope').site === 'lenches' && w.siteConfig('harvington').domain === 'harvingtonvillage.org.uk', 'Worker siteConfig');
  ok(d.SITES.join() === Object.keys(w.SITES).join(), 'same sites in lib/site.js and worker/src/sites.js');
  const pe = await import(path.join(ROOT, 'worker/src/admin/pageedit.js'));
  ok(pe.sourcePath('./sites/lenches/privacy.njk') === 'sites/lenches/privacy.njk', 'Edit page: a Lenches page');
  ok(pe.sourcePath('./sites/harvington/index.njk') === 'sites/harvington/index.njk', 'Edit page: a Harvington page');
  ok(!pe.sourcePath('./src/privacy.njk') && !pe.sourcePath('sites/lenches/_includes/base.njk') && !pe.sourcePath('sites/lenches/items/x.njk') && !pe.sourcePath('sites/other/x.njk'), 'Edit page: nothing else');

  // A Harvington build runs with empty content folders.
  const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'site-h-'));
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'eleventy'), ['--quiet', `--output=${out}`], { cwd: ROOT, env: { ...process.env, SITE: 'harvington' }, stdio: 'ignore' });
  ok(fs.existsSync(path.join(out, 'style.css')), 'Harvington build ran');
  const robots = fs.readFileSync(path.join(out, 'robots.txt'), 'utf8');
  ok(/Allow: \//.test(robots) && !/Disallow/.test(robots) && /Sitemap: https:\/\/harvingtonvillage\.org\.uk\/sitemap\.xml/.test(robots), 'Harvington robots.txt open, with its sitemap (launched, 7b)');
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  ok(!/noindex/.test(home) && /website@harvingtonvillage\.org\.uk/.test(home) && !/Lenches/.test(home.replace(/<section class="home-welcome">[\s\S]*?<\/section>/, '')), 'Home at /: indexed, its address, no Lenches wording outside the welcome note (schema too)');
  ok(/href="https:\/\/approvals\.lenches\.workers\.dev\/admin\?site=harvington" target="_blank"[^>]*>Team</.test(home) && /admin\/page\?p=%2F&amp;site=harvington" target="_blank"[^>]*>Edit page</.test(home), 'Home: Team and Edit page open the panel on Harvington, in a new tab');
  ok(/class="feedback"/.test(home), 'Home: Suggest an update form');
  ok(/class="home-welcome"/.test(home), 'Home: welcome note (17 Nov; its Lenches link removed by Jon in the editor)');
  ok(/--green:#2D4A63/.test(home) && /M491,52 L503,16/.test(home), 'Home: river blue and the spire');
  ok(/"name":"Harvington","alternateName":"The Harvington Website"/.test(home) && /"addressLocality":"Lenchwick"/.test(home), 'Home: its own site schema');
  ok(!fs.existsSync(path.join(out, 'preview')), 'no /preview/ any more');
  const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
  ok(/<loc>https:\/\/harvingtonvillage\.org\.uk\/<\/loc>/.test(sitemap) && /\/living-here\/trades\//.test(sitemap) && !/404|thelenches/.test(sitemap), 'Harvington sitemap');
  fs.rmSync(out, { recursive: true, force: true });

  // Shared layout from site.json (stage 6a): the name, the line under it and the title suffix.
  const cfg = (s) => require(path.join(ROOT, 'sites', s, '_data', 'site.json'));
  ok(cfg('lenches').brand === 'The Lenches' && cfg('lenches').brandLine === 'Church · Rous · Ab · Atch · Sheriffs' && cfg('lenches').titleName === 'The Lenches', 'Lenches header keys');
  ok(cfg('harvington').brand === 'The Harvington' && cfg('harvington').brandLine === 'including Norton and Lenchwick' && cfg('harvington').titleName === 'Harvington', 'Harvington header keys');
  ok(cfg('harvington').nav.length && cfg('harvington').footer.length, 'Harvington menu and footer');
  const base = fs.readFileSync(path.join(ROOT, 'src/_includes/base.njk'), 'utf8');
  ok(!/>The Lenches <span>|<strong>The Lenches Website|Church &middot; Rous/.test(base), 'base.njk: no fixed Lenches wording');

  console.log(`All site tests passed (${checks} checks).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
