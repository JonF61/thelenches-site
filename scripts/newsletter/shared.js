// The Pending rows a site's newsletter chooses from (17 Nov, Jon: the Harvington issue left out
// the Lenches' emailed items, posters and all, that its Events page shows). As publish does for
// the website (scripts/publish main): this site's live rows for it plus every other site's live
// rows for it (lib/site.js itemSites, the Pending `sites` cell), read-only. The other site's copy
// comes first, so this site's own copy of the same title and date wins in select(). Another
// site's rows carry `_site` (google.js readOtherTable) and lose their
// newsletter_count / flyer_count: those count that site's issues, and this site's own Issues
// tally (select.js `shown` / `imaged`) counts its own. An unreadable Sheet only leaves its items
// out, with a warning.
const { SITE, otherSites, itemSites, siteConfigFor } = require('../../lib/site.js');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const LIVE = new Set(['approved', 'auto']);
const forUs = (r) => itemSites(r.sites).includes(SITE);

async function sharedPending(g, own) {
  const others = [];
  for (const s of otherSites()) {
    if (!str(siteConfigFor(s).sheetId)) continue;
    try {
      const rows = await g.readOtherTable(s, 'Pending');
      for (const r of rows) {
        if (!LIVE.has(str(r.status).toLowerCase()) || !str(r.title) || !forUs(r)) continue;
        others.push({ ...r, _site: s, newsletter_count: '', flyer_count: '' });
      }
    } catch (err) {
      console.warn(`${s} Pending unreadable, its items left out of this issue: ${(err && err.message) || err}`);
    }
  }
  return [...others, ...(own || []).filter(forUs)];
}

module.exports = { sharedPending };
