// The sites this Worker serves (Harvington stage 2, 16 Nov 2026). One repo, shared code; each
// site's content and config live in sites/<site>/ (its _data/site.json is the config). Until
// the panel's site switcher (stage 4), everything here is for the default site, the Lenches.
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
