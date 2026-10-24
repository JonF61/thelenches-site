// scripts/photos/meaning.js
// What a photo's folder path under "Lenches Photos" means for the site (village and
// subject in the Photos tab and photos.json; the slug, fixed at first publish, starts
// with them). Folders come from Drive and are never listed in code; only the test for
// "is this top-level folder a place" needs names:
//   <Place>/<Subject>/file      village Place, subject Subject  ("Rous Lench/Churches")
//   General/<Subject>/file      no village, subject Subject     ("General/Events")
//   <Anything else>/.../file    no village, subject = that folder's name
//                               ("Amphitheatre/x.jpg", "Lenches Club/Quiz/x.jpg")
// so a new top-level folder made in Drive publishes as a subject, never as a made-up village.
// Any "Rejected" folder on the way = never use.
'use strict';

const low = (v) => String(v ?? '').trim().toLowerCase();

// The five Lenches (Ab Lench also as Abbots Lench), as lib/lenches.js.
const LENCH = /^(?:church|rous|ab|abbots|atch|sheriffs)\s+lench$/i;
// Nearby places with their own folder: the event-image places (scripts/eventimages) plus
// Bishampton, which already has one. Add a name here to make a new place folder a village.
const PLACES = ['Harvington', 'Abbots Morton', 'Lenchwick', 'Radford', 'Evesham', 'Pershore', 'Inkberrow', 'Bishampton'];

const isPlace = (name) => LENCH.test(String(name || '').trim()) || PLACES.some((p) => low(p) === low(name));

function meaning(segs) {
  const rejected = segs.some((s) => low(s) === 'rejected');
  const parts = segs.filter((s) => low(s) !== 'rejected');
  const top = parts[0] || '';
  let village = '';
  let subject = parts[1] || '';
  if (top && low(top) !== 'general') {
    if (isPlace(top)) village = top;
    else subject = top;
  }
  return { rejected, village, subject, path: segs.join(' / ') };
}

module.exports = { meaning, isPlace };
