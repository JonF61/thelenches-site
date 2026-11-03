// lib/listings.js
// Stable ids for the Local trades (src/_data/trades.json "trades") and Where to eat
// (src/_data/eat.json "places") entries, used by the Recommend buttons (worker/src/recommend.js,
// scripts/recommend). An entry's "id" is set once, from a slug of its name, and never changes,
// so renaming an entry keeps its recommendations. New entries get one from listingId().
'use strict';

const KINDS = {
  trades: { file: 'trades.json', list: 'trades', page: '/living-here/trades/', label: 'Local trades' },
  eat: { file: 'eat.json', list: 'places', page: '/living-here/eat/', label: 'Where to eat' },
};

// "B Tomes & Son" -> "b-tomes-son"; "Café Rouge" -> "cafe-rouge".
function listingId(name, taken = []) {
  const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'entry';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

module.exports = { KINDS, listingId };
