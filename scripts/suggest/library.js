// scripts/suggest/library.js
// Free picture library: Pexels (pexels.com/api). Searched by event type and kind of place
// only, built from the fixed word lists below, so no name from the email (a person, a
// band, a speaker) can ever reach a search. An event of no recognised type gets no search.
// Pexels asks for a link to Pexels wherever its results are shown (the panel strip does
// this) and a photographer credit where possible: "Photo by <name> on Pexels", linked to
// the photo's Pexels page. Images are downloaded and served from our own site, as the
// Pexels licence allows (pexels.com/license). Key: the PEXELS_API_KEY GitHub secret.
'use strict';

const API = 'https://api.pexels.com/v1/search';
const LICENCE = 'https://www.pexels.com/license/';

// [pattern in the event's title or text, search words]. First match wins.
const TYPES = [
  [/\bbonfire|fireworks?\b/, 'fireworks night'],
  [/\bhalloween\b/, 'halloween pumpkins'],
  [/\b(christmas|carols?|nativity|advent)\b/, 'christmas decorations'],
  [/\beaster\b/, 'easter eggs'],
  [/\bremembrance|armistice\b/, 'remembrance poppies'],
  [/\bharvest\b/, 'harvest festival'],
  [/\bquiz\b/, 'quiz night'],
  [/\bbingo\b/, 'bingo cards'],
  [/\b(ceilidh|barn dance|dancing|dance)\b/, 'barn dance'],
  [/\b(concert|choir|recital|orchestra|gig|live music|band|jazz|folk)\b/, 'live music'],
  [/\b(theatre|pantomime|panto|play|drama|musical)\b/, 'theatre stage'],
  [/\b(film|cinema|movie|screening)\b/, 'cinema'],
  [/\b(beer|cider|ale|wine tasting|wine)\b/, 'beer festival'],
  [/\b(fete|fête|gala|fun day)\b/, 'village fete'],
  [/\bcraft\b/, 'craft fair'],
  [/\b(farmers'? market|market)\b/, 'farmers market'],
  [/\b(car boot|jumble|rummage|table top)\b/, 'car boot sale'],
  [/\b(plant sale|open gardens?|flower show|gardening)\b/, 'english garden flowers'],
  [/\b(book sale|book club|books?)\b/, 'old books'],
  [/\b(coffee morning|cream tea|tea party|cake)\b/, 'coffee and cake'],
  [/\b(supper|dinner|lunch|barbecue|bbq|meal|breakfast)\b/, 'community dinner'],
  [/\b(walk|ramble|hike)\b/, 'countryside walk'],
  [/\b(cycle|cycling|bike ride)\b/, 'country cycling'],
  [/\b(run|fun run|5k|10k)\b/, 'running race'],
  [/\b(yoga|pilates)\b/, 'yoga class'],
  [/\b(fitness|exercise|keep fit)\b/, 'fitness class'],
  [/\bcricket\b/, 'village cricket'],
  [/\b(football|rugby)\b/, 'grassroots football'],
  [/\b(dog show|dogs?)\b/, 'dog show'],
  [/\b(art|exhibition|painting)\b/, 'art exhibition'],
  [/\b(litter pick|clean ?up)\b/, 'litter pick'],
  [/\b(talk|lecture|history)\b/, 'lecture'],
  [/\b(service|evensong|mass|worship)\b/, 'english country church'],
];
// Kind of place, added to the search where it fits.
const VENUES = [
  [/\bvillage hall\b/, 'village hall'],
  [/\b(church|chapel|churchyard)\b/, 'english church'],
  [/\b(pub|inn|tavern)\b/, 'english pub'],
];
const VOCAB = new Set([...TYPES, ...VENUES].flatMap(([, q]) => q.split(' ')));

// The search words for an event, or '' (no search). Only VOCAB words ever appear.
function libraryQuery(ev) {
  const text = String(`${ev.title || ''} ${ev.summary || ''}`).toLowerCase();
  const type = TYPES.find(([re]) => re.test(text));
  if (!type) return '';
  const venue = VENUES.find(([re]) => re.test(text));
  const q = venue && !type[1].includes(venue[1].split(' ').pop()) ? `${type[1]} ${venue[1]}` : type[1];
  return q.split(' ').filter((w) => VOCAB.has(w)).join(' ');
}

// Pexels search: up to n landscape photos, as candidates. [] if no key or query.
async function searchLibrary(query, { key = process.env.PEXELS_API_KEY, n = 4 } = {}) {
  if (!key || !query) return [];
  const url = `${API}?${new URLSearchParams({ query, per_page: String(n), orientation: 'landscape', locale: 'en-GB' })}`;
  const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const data = await res.json();
  return (data.photos || []).filter((p) => p && p.src && (p.src.large || p.src.original)).map((p) => ({
    url: p.src.large || p.src.original,
    page: String(p.url || ''),
    credit: `Photo by ${String(p.photographer || 'a Pexels photographer').replace(/[<>@]/g, '').slice(0, 80)} on Pexels`,
    creditUrl: String(p.url || ''),
    licence: LICENCE,
    alt: String(p.alt || '').slice(0, 125),
  }));
}

module.exports = { libraryQuery, searchLibrary, VOCAB, LICENCE };
