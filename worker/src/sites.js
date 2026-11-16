// The sites this Worker serves (Harvington stage 2, 16 Nov 2026). One repo, shared code; each
// site's content and config live in sites/<site>/ (its _data/site.json is the config). Until
// the panel's site switcher (stage 4c), everything here was for the default site, the Lenches.
// Stage 4c-1 (16 Nov): the panel sends the site it is showing (header x-site, or ?site= for
// frames and new tabs) and siteEnv() points that request at the site's own Sheet.
import lenches from '../../sites/lenches/_data/site.json' with { type: 'json' };
import harvington from '../../sites/harvington/_data/site.json' with { type: 'json' };

export const SITES = { lenches, harvington };
export const DEFAULT_SITE = 'lenches';

// A known site's name, else the default.
export const siteName = (s) => (Object.prototype.hasOwnProperty.call(SITES, s) ? s : DEFAULT_SITE);
// The site's config (its site.json).
export const siteConfig = (s) => SITES[siteName(s)];
// The site's folder in the repo, for GitHub API paths: "sites/lenches".
export const siteRel = (s) => `sites/${siteName(s)}`;

// True only for a site this Worker serves (a request naming any other is refused).
export const knownSite = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(SITES, s);

// The colour the panel shows for a site: its palette's green, else the Lenches green (style.css).
const LENCHES_GREEN = '#3F5233';
export const siteColour = (s) => (siteConfig(s).palette && siteConfig(s).palette.green) || LENCHES_GREEN;

// Every site, for the panel's switcher: [{ id, name, colour }], the default first.
export const siteList = () => [DEFAULT_SITE, ...Object.keys(SITES).filter((s) => s !== DEFAULT_SITE)]
  .map((id) => ({ id, name: String(SITES[id].name || id), colour: siteColour(id) }));

// The Worker's env for one site's request: SHEET_ID is that site's Sheet (the Lenches keeps
// wrangler.toml's SHEET_ID, so nothing changes for it), SITE its name (core.js dispatch adds it
// to every client_payload) and SITE_URL its address (Summary's coming-up list). Everything
// else (secrets, bindings) is read through to the real env.
export function siteEnv(env, s) {
  const site = siteName(s);
  const cfg = SITES[site];
  const sheet = site === DEFAULT_SITE ? String(env.SHEET_ID || cfg.sheetId || '') : String(cfg.sheetId || '');
  const over = { SHEET_ID: sheet, SITE: site };
  if (site !== DEFAULT_SITE) over.SITE_URL = String(cfg.url || '');
  return Object.assign(Object.create(env), over);
}
