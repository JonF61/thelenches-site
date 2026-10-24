// scripts/suggest/own.js
// Own photos for an event with no image: approved Lenches Photos images (src/_data/photos.json,
// i.e. already published) that match the event's venue, village or subject. Photos made for
// one particular event (target event:<key>) are offered only for that event. Among equal
// matches, photos with no identifiable people come first (people from the Photos tab).
'use strict';

const { placeName, placesIn } = require('../../lib/places');

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const low = (s) => String(s ?? '').toLowerCase();

// Venue words: a match in both the event and the photo (alt text or folder) counts.
const VENUES = [
  ['village hall', /\b(village\s+)?hall\b/],
  ['church', /\b(church|chapel|churchyard|lychgate|st\.?\s+\w+'?s?)\b/],
  ['pub', /\b(pub|inn|tavern|arms)\b/],
  ['club', /\bclub\b/],
  ['school', /\bschool\b/],
  ['green', /\b(village\s+green|playing\s+field|recreation\s+ground)\b/],
  ['garden', /\bgardens?\b/],
];
const GENERIC = new Set(['events', 'general', 'misc', 'other', 'photos']);
const STOP = new Set(['about', 'after', 'their', 'there', 'these', 'which', 'with', 'from', 'night', 'evening',
  'morning', 'event', 'events', 'lench', 'lenches', 'village', 'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'tickets', 'local', 'great', 'every']);
const PEOPLE_RANK = { none: 0, distant: 1, '': 2, unknown: 2, identifiable: 3, children: 4 };

const words = (s) => new Set(low(s).split(/[^a-z]+/).filter((w) => w.length >= 5 && !STOP.has(w)));

// The event's main place: its village column, else the first place named in the text.
function eventPlace(ev) {
  return placeName(ev.village) || placesIn(`${ev.title || ''} ${ev.summary || ''} ${ev.village || ''}`)[0] || '';
}

function eventTargets(p) {
  return (p.targets || []).map(String).filter((t) => t.startsWith('event:')).map((t) => squash(t.slice(6))).filter(Boolean);
}

// Score one photo against the event, or 0 if it doesn't match.
function score(ev, p, place) {
  const title = squash(ev.title);
  const text = low(`${ev.title || ''} ${ev.summary || ''}`);
  const keys = eventTargets(p);
  let s = 0;
  if (keys.length) {
    if (!keys.some((k) => title.includes(k))) return 0; // made for another event
    s += 10;
  }
  const photoPlace = placeName(p.village);
  if (place && photoPlace === place) s += 3;
  // A photo of another place (Rous Lench's hall) never stands in for this one (Alcester's).
  else if (!keys.length && place && photoPlace) return 0;
  const about = low(`${p.alt || ''} ${p.subject || ''}`);
  if (VENUES.some(([, re]) => re.test(text) && re.test(about))) s += 3;
  const subj = low(p.subject).split('/').map((x) => x.trim()).filter((x) => x && !GENERIC.has(x));
  if (subj.some((x) => text.includes(x))) s += 2;
  const t = words(ev.title);
  let overlap = 0;
  for (const w of words(p.alt)) if (t.has(w)) overlap += 1;
  s += Math.min(overlap, 2);
  return s >= 3 ? s : 0;
}

// Up to max own photos for the event, best first: [{ photo, score, people }].
// photos: photos.json; people: Map slug -> Photos tab people value.
function ownMatches(ev, photos, people = new Map(), max = 2) {
  const place = eventPlace(ev);
  return (photos || [])
    .filter((p) => p && p.src && /^\/images\/photos\/[a-z0-9-]+\.webp$/.test(p.src))
    .map((p) => ({ photo: p, score: score(ev, p, place), people: low(people.get(p.slug)).trim() }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score
      || (PEOPLE_RANK[a.people] ?? 2) - (PEOPLE_RANK[b.people] ?? 2)
      || a.photo.slug.localeCompare(b.photo.slug))
    .slice(0, max);
}

module.exports = { ownMatches, eventPlace, score };
