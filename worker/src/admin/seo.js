// SEO screen (SEO step 7, 26 Nov 2026): the shown site's build report, seo-report.json, written by
// .eleventy.js with lib/seo.js (code-only checks against the search phrases in its _data/seo.json).
// Read-only. A site without seo.json has no report (404): { none: true }.
const FILE = 'seo-report.json';

export async function seoReportFile(env) {
  const site = String(env.SITE_URL || 'https://thelenches.org.uk/');
  try {
    const r = await fetch(`${site.endsWith('/') ? site : `${site}/`}${FILE}`, { cf: { cacheTtl: 300 } });
    if (r.status === 404) return { none: true };
    if (!r.ok) return { error: `${FILE}: HTTP ${r.status}` };
    const j = await r.json();
    if (!j || !Array.isArray(j.pages)) return { error: `${FILE}: unreadable` };
    return j;
  } catch (e) {
    return { error: `${FILE}: ${e.message}` };
  }
}
