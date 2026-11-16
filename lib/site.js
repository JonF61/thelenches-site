// Which site this run is for (Harvington stage 2, 16 Nov 2026). One repo serves two sites:
// shared code and layouts (src/_includes, src/style.css, src/_data/*.js, lib/, scripts/, worker/)
// and each site's own content in sites/<site>/ (pages, _data/*.json, items/, images/).
// The site comes from the SITE environment variable (workflows set it); default "lenches".
const path = require('path');

const SITES = ['lenches', 'harvington'];
const ROOT = path.join(__dirname, '..');

function siteName(env = process.env) {
  const s = String(env.SITE || '').trim().toLowerCase() || 'lenches';
  if (!SITES.includes(s)) throw new Error(`Unknown SITE "${s}" (expected one of ${SITES.join(', ')})`);
  return s;
}

const SITE = siteName();
// Repo-relative folder, with forward slashes (for git paths and the GitHub API): "sites/lenches".
const SITE_REL = `sites/${SITE}`;
// Absolute path inside the site's folder: siteDir('_data', 'eat.json').
const siteDir = (...parts) => path.join(ROOT, SITE_REL, ...parts);
// Repo-relative path inside the site's folder: siteRel('_data/eat.json') -> "sites/lenches/_data/eat.json".
const siteRel = (p = '') => (p ? `${SITE_REL}/${String(p).replace(/^\/+/, '')}` : SITE_REL);

let config;
// The site's config: its _data/site.json (also Eleventy's global `site`).
function siteConfig() {
  if (!config) config = require(siteDir('_data', 'site.json'));
  return config;
}

// One of the site's _data JSON files, or `fallback` if the site doesn't have it (yet).
function siteData(name, fallback = {}) {
  try { return require(siteDir('_data', `${name}.json`)); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return fallback; throw e; }
}

// The site's Google Sheet id (Harvington stage 4, 16 Nov 2026): SHEET_ID if a run sets it
// (tests do), else site.json's sheetId. The Lenches "Lenches Pipeline", Harvington "Harvington Pipeline".
function sheetId(env = process.env) {
  const id = String(env.SHEET_ID || siteConfig().sheetId || '').trim();
  if (!id) throw new Error(`No Sheet for site "${SITE}": set sheetId in ${SITE_REL}/_data/site.json`);
  return id;
}

// Another site's config (its site.json), by name: for cross-site reads (stage 4b).
function siteConfigFor(name) {
  if (!SITES.includes(name)) throw new Error(`Unknown site "${name}"`);
  return name === SITE ? siteConfig() : require(path.join(ROOT, 'sites', name, '_data', 'site.json'));
}
// A site's short name for notes and subjects: "Lenches", "Harvington".
const shortName = (name) => String(siteConfigFor(name).name || name).replace(/^the\s+/i, '');
// The other sites, in SITES order (the Lenches first).
const otherSites = () => SITES.filter((s) => s !== SITE);
// Which sites an item is for, from the Pending `sites` cell (Harvington stage 4b): blank or
// "both" = every site; else the names listed (comma or space separated), unknown names ignored.
function itemSites(cell) {
  const v = String(cell || '').trim().toLowerCase();
  if (!v || v === 'both' || v === 'all') return [...SITES];
  const list = SITES.filter((s) => v.split(/[\s,]+/).includes(s));
  return list.length ? list : [...SITES];
}

module.exports = { shortName, siteConfigFor, otherSites, itemSites, sheetId, siteData, SITES, SITE, SITE_REL, ROOT, siteName, siteDir, siteRel, siteConfig };
