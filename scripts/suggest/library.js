// scripts/suggest/library.js
// Free picture library: Pexels (pexels.com/api) if the PEXELS_API_KEY secret is set, else
// Pixabay (pixabay.com/api/docs) if PIXABAY_API_KEY is (26 Oct: Pexels access still paused).
// Searched by event type and kind of place only, built from the fixed word lists below, so
// no name from the email (a person, a band, a speaker) can ever reach a search. An event of
// no recognised type gets no search.
// Both ask for a link to them wherever results are shown (the panel strip does this, by the
// photo page's host) and a photographer credit where possible: "Photo by <name> on Pexels" /
// "Image by <name> from Pixabay", linked to the photo's page. Images are downloaded and
// served from our own site, as both licences allow (Pixabay forbids hotlinking anyway).
'use strict';

const API = 'https://api.pexels.com/v1/search';
const LICENCE = 'https://www.pexels.com/license/';
const PIXABAY_API = 'https://pixabay.com/api/';
const PIXABAY_LICENCE = 'https://pixabay.com/service/license-summary/';

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

// Which library this run uses: { provider: 'pexels' | 'pixabay', name, key }, or null (none).
function librarySource(env = process.env) {
  const pexels = String(env.PEXELS_API_KEY || '').trim();
  if (pexels) return { provider: 'pexels', name: 'Pexels', key: pexels };
  const pixabay = String(env.PIXABAY_API_KEY || '').trim();
  if (pixabay) return { provider: 'pixabay', name: 'Pixabay', key: pixabay };
  return null;
}

const cleanName = (v, fallback) => String(v || fallback).replace(/[<>@]/g, '').slice(0, 80);

// Library search: up to n landscape photos, as candidates
// { url, page, credit, short, creditUrl, licence, alt, text }. [] if no key or query.
async function searchLibrary(query, { provider = 'pexels', key = provider === 'pixabay' ? process.env.PIXABAY_API_KEY : process.env.PEXELS_API_KEY, n = 4 } = {}) {
  if (!key || !query) return [];
  if (provider === 'pixabay') return searchPixabay(query, key, n);
  const url = `${API}?${new URLSearchParams({ query, per_page: String(n), orientation: 'landscape', locale: 'en-GB' })}`;
  const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const data = await res.json();
  return (data.photos || []).filter((p) => p && p.src && (p.src.large || p.src.original)).map((p) => {
    const by = cleanName(p.photographer, 'a Pexels photographer');
    return {
      url: p.src.large || p.src.original,
      page: String(p.url || ''),
      credit: `Photo by ${by} on Pexels`,
      short: `${by} / Pexels`,
      creditUrl: String(p.url || ''),
      licence: LICENCE,
      alt: String(p.alt || '').slice(0, 125),
      text: String(p.alt || '').slice(0, 125),
    };
  });
}

// Pixabay: photos only, landscape, safe search on. Its tags (no alt text) go to the image
// check as context only; alt is left for Jon.
async function searchPixabay(query, key, n) {
  const params = new URLSearchParams({
    key, q: query, image_type: 'photo', orientation: 'horizontal', safesearch: 'true', lang: 'en', per_page: String(Math.max(3, n)),
  });
  const res = await fetch(`${PIXABAY_API}?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || []).filter((p) => p && /^https:\/\//.test(String(p.largeImageURL || ''))).slice(0, n).map((p) => {
    const by = cleanName(p.user, 'a Pixabay contributor');
    return {
      url: String(p.largeImageURL),
      page: String(p.pageURL || ''),
      credit: `Image by ${by} from Pixabay`,
      short: `${by} / Pixabay`,
      creditUrl: String(p.pageURL || ''),
      licence: PIXABAY_LICENCE,
      alt: '',
      text: String(p.tags || '').slice(0, 125),
    };
  });
}

module.exports = { libraryQuery, searchLibrary, librarySource, VOCAB, LICENCE, PIXABAY_LICENCE };
