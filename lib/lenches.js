// Is an item in one of the five Lenches (Church, Rous, Ab/Abbots, Atch, Sheriffs)?
// Used by the site's inLenches filter (Events badge); the newsletter can reuse it later.
// Harvington, Abbots Morton, Lenchwick, Evesham etc. count as the wider area.
// Order of evidence:
//   1. "lenches": true/false on a whatson.json item (hand override)
//   2. "village" (written by scripts/publish from the Pending village column)
//   3. otherwise the title and body text
'use strict';

const PLACE = /\b(?:church|rous|ab|abbots|atch|sheriffs)\s+lench\b|\bthe\s+lenches\b|\blenches\s+club\b/i;

function inLenches(item) {
  if (!item) return false;
  if (typeof item.lenches === 'boolean') return item.lenches;
  const village = String(item.village || '').trim();
  if (village) return PLACE.test(village) || /^(?:the\s+)?lenches$/i.test(village);
  return PLACE.test(`${item.title || ''} ${item.body || ''}`);
}

module.exports = { inLenches };
