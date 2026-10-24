// lib/places.js
// Places with their own folder under Lenches Photos: the five Lenches, the villages
// near them and the nearby towns. Used by scripts/photos/meaning.js (is this top-level
// folder a village?) and scripts/eventimages (which folder an event's image goes in).
// Each entry is [name, ...variants]; a variant means the same place as the first name.
// Matching ignores case and hyphens ("Bidford on Avon" = "Bidford-on-Avon").
'use strict';

const LENCHES = [
  ['Church Lench'], ['Rous Lench'], ['Ab Lench', 'Abbots Lench', "Abbot's Lench"], ['Atch Lench'],
  ['Sheriffs Lench', "Sheriff's Lench"],
];
const NEAR = [
  ['Harvington'], ['Norton'], ['Lenchwick'], ['Abbots Morton', "Abbot's Morton"], ['Radford'], ['Inkberrow'],
  ['Bishampton'], ['Fladbury'], ['Cropthorne'], ['Charlton'], ['Wyre Piddle'], ['Throckmorton'], ['North Piddle'],
  ['Upton Snodsbury'], ['Flyford Flavell'], ['Naunton Beauchamp'], ['Dormston'], ['Kington'], ['Dunnington'],
  ['Iron Cross'], ['Salford Priors'], ['Abbots Salford'], ['Cleeve Prior'],
  ['The Littletons', 'North Littleton', 'Middle Littleton', 'South Littleton'], ['Offenham'], ['Badsey'],
  ['Aldington'], ['Bretforton'], ['Wickhamford'], ['Honeybourne'], ['Hinton on the Green'], ['Sedgeberrow'],
  ['Ashton under Hill'], ['Elmley Castle'], ['Childswickham'], ['Pebworth'], ['Bidford-on-Avon', 'Bidford'],
  ['Marlcliff'], ['Hampton'], ['Bengeworth'], ['Chadbury'], ['Wood Norton'],
];
const TOWNS = [
  ['Evesham'], ['Pershore'], ['Broadway'], ['Alcester'], ['Redditch'], ['Studley'], ['Droitwich Spa', 'Droitwich'],
  ['Worcester'], ['Stratford-upon-Avon', 'Stratford on Avon', 'Stratford'], ['Chipping Campden'], ['Tewkesbury'],
  ['Cheltenham'], ['Bromsgrove'], ['Malvern', 'Great Malvern'], ['Upton-upon-Severn'],
];
const GROUPS = [...LENCHES, ...NEAR, ...TOWNS];

// Lower case, curly apostrophes straight, hyphens and runs of spaces as one space.
const placeKey = (s) => String(s ?? '').toLowerCase().replace(/’/g, "'").replace(/[-\s]+/g, ' ').trim();

const PLACES = GROUPS.map((g) => g[0]);
const BY_KEY = new Map();
for (const g of GROUPS) for (const v of g) BY_KEY.set(placeKey(v), g[0]);

// The place's name for an exact folder or title-tail name, or '' if it is not a place.
const placeName = (s) => BY_KEY.get(placeKey(s)) || '';
const isLench = (s) => LENCHES.some((g) => g[0] === placeName(s));

// Every variant as a whole-word pattern, longest first so "Wood Norton" wins over "Norton"
// and "Bidford-on-Avon" over "Bidford" where both fit.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VARIANTS = [...BY_KEY.keys()].sort((a, b) => b.length - a.length);
const ANY = new RegExp(`(?<![\\w'])(?:${VARIANTS.map((v) => esc(v).replace(/ /g, '[-\\s]+').replace(/'/g, "['’]")).join('|')})(?![\\w'])`, 'gi');

// Places named anywhere in text, in list order (the Lenches first, then villages, then towns).
function placesIn(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(ANY)) found.add(placeName(m[0]));
  return PLACES.filter((p) => found.has(p));
}

module.exports = { PLACES, placeKey, placeName, placesIn, isLench };
