import { accessToken, SCOPES } from './google.js';
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

// ---- Search Console (SEO step 7 part 2, 26 Nov 2026) ------------------------------------------
// The last 28 days of Google search for the shown site: totals, top searches and figures per page,
// read with the panel's service account (a Restricted user of the property; webmasters.readonly).
// Google's figures run 2 to 3 days behind, so the window ends 3 days ago. The property is found in
// the account's site list (a Domain property "sc-domain:<domain>" or a URL-prefix one). Cached in
// memory for an hour: the figures change once a day. Search Console's API gives no links data.

const SC = 'https://www.googleapis.com/webmasters/v3';
const DAYS = 28;
const cache = new Map(); // site url -> { at, data }
export function resetConsoleCache() { cache.clear(); }

const ymd = (d) => d.toISOString().slice(0, 10);
function windowFor(now = new Date()) {
  const end = new Date(now.getTime() - 3 * 86400000);
  const start = new Date(end.getTime() - (DAYS - 1) * 86400000);
  return { startDate: ymd(start), endDate: ymd(end) };
}

// The account's property for this site's domain, or ''.
export function pickProperty(entries, siteUrl) {
  const host = String(siteUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const urls = (entries || []).map((e) => String(e.siteUrl || ''));
  return urls.find((u) => u === `sc-domain:${host}`)
    || urls.find((u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') === host) || '';
}

const num = (x) => Math.round((Number(x) || 0) * 10) / 10;
const rowOut = (r) => ({ key: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0, position: num(r.position) });

export async function searchConsole(env, { now = new Date() } = {}) {
  const site = String(env.SITE_URL || 'https://thelenches.org.uk/');
  const hit = cache.get(site);
  if (hit && Date.now() - hit.at < 3600000) return hit.data;
  let data;
  try {
    const token = await accessToken(env, SCOPES.searchConsole);
    const auth = { authorization: `Bearer ${token}` };
    const list = await fetch(`${SC}/sites`, { headers: auth });
    if (!list.ok) throw new Error(`site list: HTTP ${list.status}`);
    const property = pickProperty((await list.json()).siteEntry, site);
    if (!property) {
      data = { off: true, why: 'The panel’s Google account is not a user of this website’s Search Console property yet.' };
    } else {
      const win = windowFor(now);
      const query = async (body) => {
        const r = await fetch(`${SC}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...win, ...body }),
        });
        if (!r.ok) throw new Error(`search figures: HTTP ${r.status}`);
        return (await r.json()).rows || [];
      };
      const [total, queries, pages] = await Promise.all([
        query({}), query({ dimensions: ['query'], rowLimit: 20 }), query({ dimensions: ['page'], rowLimit: 500 }),
      ]);
      const t = total[0] || {};
      const origin = site.replace(/\/$/, '');
      data = {
        property, ...win,
        totals: { clicks: t.clicks || 0, impressions: t.impressions || 0, position: num(t.position) },
        queries: queries.map(rowOut),
        // Page figures keyed by path ("/events/"), as the build report keys its pages.
        pages: Object.fromEntries(pages.map(rowOut).map((p) => [p.key.startsWith(origin) ? p.key.slice(origin.length) || '/' : p.key, p])),
      };
    }
  } catch (e) {
    data = { error: `Search Console: ${e.message}` };
  }
  if (!data.error) cache.set(site, { at: Date.now(), data });
  return data;
}
