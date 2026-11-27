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

// Every site, for the panel's switcher: [{ id, name, colour, analytics, url }], the default first.
// analytics: the site's pages carry the Cloudflare Web Analytics beacon (site.json
// cfAnalyticsToken, added at launch), so there are visitor counts to show (4c-2).
export const siteIds = () => [DEFAULT_SITE, ...Object.keys(SITES).filter((s) => s !== DEFAULT_SITE)];
export const hasAnalytics = (s) => Boolean(String(siteConfig(s).cfAnalyticsToken || '').trim());
export const siteList = () => siteIds()
  .map((id) => ({ id, name: String(SITES[id].name || id), colour: siteColour(id), analytics: hasAnalytics(id), url: String(SITES[id].url || '').replace(/\/+$/, '') }));

// The Worker's env for one site's request: SHEET_ID is that site's Sheet (the Lenches keeps
// wrangler.toml's SHEET_ID, so nothing changes for it), SITE its name (core.js dispatch adds it
// to every client_payload) and SITE_URL its address (Summary's coming-up list). Everything
// else (secrets, bindings) is read through to the real env.
export function siteEnv(env, s) {
  const site = siteName(s);
  const cfg = SITES[site];
  // The default site keeps the real env's SHEET_ID (wrangler.toml), never one a siteEnv for
  // another site put in front of it (27 Nov 2026: Harvington's Inbound links read its own Replies
  // as the Lenches', so a request sent from the Lenches for both was missed).
  const base = env.__realEnv || env;
  const sheet = site === DEFAULT_SITE ? String(base.SHEET_ID || cfg.sheetId || '') : String(cfg.sheetId || '');
  const over = { SHEET_ID: sheet, SITE: site, SITE_HOST: String(cfg.domain || ''), __realEnv: base };
  if (site !== DEFAULT_SITE) over.SITE_URL = String(cfg.url || '');
  return Object.assign(Object.create(env), over);
}

// The public forms (/s sign-up, /f Suggest an update, /r Recommend, /sg Suggest a listing;
// Harvington stage 7, 16 Nov): the site a form was posted from is the one whose address
// matches the request's Origin (or, failing that, its Referer). Anything else is the default
// site, whose own origin check then refuses a stranger as before.
// A site's www address counts as the site (22 Nov 2026).
const originOf = (u) => { try { const x = new URL(String(u || '')); x.hostname = x.hostname.replace(/^www\./, ''); return x.origin; } catch { return ''; } };
export function siteFromRequest(request) {
  const from = originOf(request.headers.get('origin')) || originOf(request.headers.get('referer'));
  if (!from) return DEFAULT_SITE;
  return siteIds().find((id) => originOf(SITES[id].url) === from) || DEFAULT_SITE;
}

// The env for a public form or its signed link: the default site keeps the real env exactly;
// another site gets siteEnv (its Sheet, address and dispatch site).
export const publicEnv = (env, s) => (knownSite(s) && s !== DEFAULT_SITE ? siteEnv(env, s) : env);

// Wording a public page or message uses for the site env is serving: "the Lenches website",
// its address, domain and newsletter name (from its site.json).
export function siteWords(env) {
  const c = siteConfig(env && env.SITE);
  return {
    website: `the ${String(c.name || '').replace(/^the\s+/i, '')} website`,
    email: String(c.email || ''),
    domain: String(c.domain || ''),
    newsletter: String(c.newsletterName || ''),
  };
}

// Every site's own email domain (sign-ups from them are refused).
export const ownDomains = () => siteIds().map((id) => String(SITES[id].domain || '').toLowerCase()).filter(Boolean);
