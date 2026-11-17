// The place label on a News page card (src/_includes/pages/notices.njk).
// With no `places` (the Lenches) it is the item's village, as before. A site that sets
// `localPlaces` (Harvington, 17 Nov 2026, Jon) labels only its own places: the village
// when it names one of them, else the first of them named in the title, then the body;
// another community's label (e.g. "Lenches", "Church Lench") is left off. A hand-written
// item's optional `place` sets that site's label outright ("" = none); the Lenches ignores it.
'use strict';

function placeLabel(item, places) {
  if (!item) return '';
  const village = String(item.village || '').trim();
  if (!Array.isArray(places) || !places.length) return village;
  if (typeof item.place === 'string') return item.place.trim();
  const words = places.map((p) => ({ name: p, re: new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));
  if (village && words.some((w) => w.re.test(village))) return village;
  for (const text of [item.title, item.body]) {
    const s = String(text || '');
    let best = null;
    for (const w of words) {
      const m = s.match(w.re);
      if (m && (best === null || m.index < best.index)) best = { index: m.index, name: w.name };
    }
    if (best) return best.name;
  }
  return '';
}

module.exports = { placeLabel };
