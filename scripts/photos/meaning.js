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

// The places with their own folder (the Lenches, nearby villages and towns) are listed in
// lib/places.js; a variant name (Abbots Lench) gives the place's first name (Ab Lench).
const { placeName } = require('../../lib/places');

const isPlace = (name) => Boolean(placeName(name));

function meaning(segs) {
  const rejected = segs.some((s) => low(s) === 'rejected');
  const parts = segs.filter((s) => low(s) !== 'rejected');
  const top = parts[0] || '';
  let village = '';
  let subject = parts[1] || '';
  if (top && low(top) !== 'general') {
    if (isPlace(top)) village = placeName(top);
    else subject = top;
  }
  return { rejected, village, subject, path: segs.join(' / ') };
}

module.exports = { meaning, isPlace };
