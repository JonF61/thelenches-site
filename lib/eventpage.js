// A page per event (SEO step 1, 26 Nov 2026; plan agreed with Jon): /events/<date>-<title slug>/.
// Switched on per site by site.json "eventPages": true (the Lenches first; Harvington after), so a
// site without it keeps its Events-page anchors everywhere. Pure helpers shared by .eleventy.js,
// src/_data/eventPages.js, lib/schema.js, lib/anchors.js and the newsletter.
//   eventSlug    the page's slug (the same as a hand-written file name without .json, for most)
//   placeLine    "Church Lench Village Hall, Church Lench · about 5 miles north of Evesham"
//   timeText     "7.30pm" / "10am to 4pm" from the body, as the calendar links read it
//   priceOf      { price } when the text gives a £ price or says it is free, else null
//   venueOf      the venues.json entry for the title's venue, or null
'use strict';

const { default: slugify } = require('@sindresorhus/slugify');
const { startTime, locationOf } = require('./ics.js');
const { placesIn, isLench } = require('./places.js');
const VENUES = require('./venues.json').venues;

const slug = (s) => slugify(String(s), { decamelize: false });
const day = (v) => String(v || '').slice(0, 10);

// Kept this many days after an event ends, with a "This event has finished" box; then the page
// goes and its address falls to the 404 page, which sends /events/<anything>/ back to /events/.
const KEEP_PAST_DAYS = 30;

const SLUGS = new Map();
function eventSlug(e) {
  const k = `${day(e && e.date)}-${(e && e.title) || ''}`;
  if (!SLUGS.has(k)) SLUGS.set(k, slug(k));
  return SLUGS.get(k);
}
const eventPath = (e) => `/events/${eventSlug(e)}/`;

// Venue names compared without case, apostrophes ("St James' / St James's"), "the" or punctuation.
const venueKey = (s) => String(s || '').toLowerCase().replace(/[’']s\b/g, '').replace(/[’']/g, '')
  .replace(/&/g, ' and ').replace(/\bthe\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const BY_KEY = new Map();
for (const v of VENUES) for (const n of [v.name, ...(v.aliases || [])]) BY_KEY.set(venueKey(n), v);
function venueOf(e) {
  const where = locationOf(String((e && e.title) || ''));
  return (where && BY_KEY.get(venueKey(where))) || null;
}

// Straight-line miles from Evesham town centre, rounded (checked 26 Nov 2026 from each village's
// map position): the five Lenches are named with their distance, other places "X, near Evesham".
const LENCH_MILES = { 'Church Lench': 5, 'Rous Lench': 6, 'Ab Lench': 5, 'Atch Lench': 4, 'Sheriffs Lench': 4 };
// Towns are named as they are (the plan names only these three in titles, but any town in the text
// is a town, never "near Evesham").
const TOWNS = new Set(['Evesham', 'Pershore', 'Alcester', 'Broadway', 'Redditch', 'Studley', 'Droitwich Spa', 'Worcester',
  'Stratford-upon-Avon', 'Chipping Campden', 'Tewkesbury', 'Cheltenham', 'Bromsgrove', 'Malvern', 'Upton-upon-Severn']);

// The place the event is in: the venue's village, else the first place named in title then body.
const PLACE_CACHE = new Map();
function placeOf(e) {
  const v = venueOf(e);
  if (v && v.locality) return v.locality;
  const k = `${(e && e.title) || ''}\n${(e && e.body) || ''}`;
  if (!PLACE_CACHE.has(k)) PLACE_CACHE.set(k, placesIn(String((e && e.title) || ''))[0] || placesIn(String((e && e.body) || ''))[0] || '');
  return PLACE_CACHE.get(k);
}

function whereWords(place) {
  if (!place) return '';
  if (LENCH_MILES[place]) return `${place}, about ${LENCH_MILES[place]} miles north of Evesham`;
  if (TOWNS.has(place)) return place;
  return `${place}, near Evesham`;
}

// "Venue, Place, about N miles north of Evesham": the venue only when the title names one that is
// not just the place itself.
function placeLine(e) {
  const place = placeOf(e);
  const venue = locationOf(String((e && e.title) || ''));
  const where = whereWords(place);
  if (venue && place && venue.toLowerCase().includes(place.toLowerCase())) {
    // "St James's Church, Harvington" already names the place: keep the distance words only.
    const tail = where.slice(place.length).replace(/^,\s*/, '');
    return tail ? `${venue}, ${tail}` : venue;
  }
  return [venue, where].filter(Boolean).join(', ');
}

const clock = (min) => {
  const h = Math.floor(min / 60); const m = min % 60;
  if (h === 12 && m === 0) return 'noon';
  const h12 = h % 12 || 12;
  return `${h12}${m ? `.${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};
// The time as the calendar links read it ('' for multi-day or no clear time).
function timeText(e) {
  if (!e || (e.endDate && day(e.endDate) !== day(e.date))) return '';
  const t = startTime(e.body);
  if (!t) return '';
  return t.end != null ? `${clock(t.start)} to ${clock(t.end)}` : clock(t.start);
}

// A price only when the text gives one: the first "£n" amount, or 0 when it says entry is free.
// Never a guess: "free parking", "gluten free" and the like don't count.
const FREE = /\b(?:entry|admission|entrance)\s+(?:is\s+)?free\b|\bfree\s+(?:entry|admission|event|of\s+charge|to\s+attend)\b|\bno\s+charge\b|\bit'?s\s+free\b|\bis\s+free\b/i;
// A £ amount counts only as the price of going: "£45 per person", "tickets £10", "entry £3",
// "it costs £45", "£5 on the door". A raffle prize, a bingo book or a table price never does.
const BEFORE = /\b(?:tickets?(?:\s+(?:are|cost|costs|at|priced\s+at))?|entry(?:\s+is)?|admission(?:\s+is)?|entrance(?:\s+is)?|costs?|price(?:\s+is)?|adults?)\s*:?\s*$/i;
const AFTER = /^\s*(?:per\s+(?:person|head|adult|child|ticket)|pp\b|a\s+(?:head|ticket|person)|each\b|on\s+the\s+door|entry\b|admission\b|for\s+adults)/i;
function priceOf(e) {
  const text = `${(e && e.title) || ''}. ${(e && e.body) || ''}`;
  for (const m of text.matchAll(/£\s?(\d{1,4}(?:\.\d{2})?)/g)) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 25);
    if (BEFORE.test(before) || AFTER.test(after)) return { price: m[1] };
  }
  if (!/£\s?\d/.test(text) && FREE.test(text)) return { price: '0' };
  return null;
}

// The events a page can exist for, today: upcoming ones plus those ended within KEEP_PAST_DAYS,
// one per slug (the list's first copy wins, as on the Events page).
function pageEvents(events, today) {
  const from = new Date(`${today}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - KEEP_PAST_DAYS);
  const cutoff = from.toISOString().slice(0, 10);
  const seen = new Set();
  return (events || [])
    .filter((e) => e && e.title && /^\d{4}-\d{2}-\d{2}$/.test(day(e.date)))
    .filter((e) => (day(e.endDate) || day(e.date)) >= cutoff)
    .filter((e) => { const s = eventSlug(e); return !seen.has(s) && seen.add(s); })
    .sort((a, b) => day(a.date).localeCompare(day(b.date)) || String(a.title).localeCompare(String(b.title)));
}

const isPast = (e, today) => (day(e.endDate) || day(e.date)) < today;

// Up to n other upcoming events, nearest in date first, Lenches ones before others on the same day.
function moreEvents(e, events, today, n = 3) {
  const me = eventSlug(e);
  return (events || [])
    .filter((x) => x && x.title && eventSlug(x) !== me && !isPast(x, today) && day(x.date) >= today)
    .sort((a, b) => day(a.date).localeCompare(day(b.date))
      || Number(isLench(placeOf(b)) || false) - Number(isLench(placeOf(a)) || false)
      || String(a.title).localeCompare(String(b.title)))
    .slice(0, n);
}

module.exports = { KEEP_PAST_DAYS, eventSlug, eventPath, venueOf, placeOf, placeLine, timeText, priceOf, pageEvents, isPast, moreEvents, venueKey };
