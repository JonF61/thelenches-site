// SEO steps 1-3 (26 Nov 2026): a page per event, place wording, richer Event data (lib/eventpage.js,
// lib/schema.js, lib/venues.json). Run: node scripts/test-event-pages.js
'use strict';
const assert = require('assert');
const EP = require('../lib/eventpage.js');
const { eventSchema } = require('../lib/schema.js');

const ev = (title, body, date = '2026-12-05', extra = {}) => ({ title, body, date, ...extra });

// Slug and path: date then title, as the hand-written file names.
assert.strictEqual(EP.eventSlug(ev('Christmas Fayre — Church Lench Village Hall', '', '2026-11-28')), '2026-11-28-christmas-fayre-church-lench-village-hall');
assert.strictEqual(EP.eventPath(ev("Cameo Teas — St James's Church, Harvington", '', '2026-12-09')), '/events/2026-12-09-cameo-teas-st-jamess-church-harvington/');

// Venues: aliases, apostrophes and "the" ignored; unknown venue = null.
assert.strictEqual(EP.venueOf(ev("Concert — St James' Church, Harvington", '')).postcode, 'WR11 8NQ');
assert.strictEqual(EP.venueOf(ev('Quiz — Lenches Club', '')).postcode, 'WR11 4UQ');
assert.strictEqual(EP.venueOf(ev('Wreaths — The Vale Golf and Country Club', '')).postcode, 'WR10 2LZ');
assert.strictEqual(EP.venueOf(ev('Party — Somewhere Else', '')), null);
for (const v of require('../lib/venues.json').venues) assert.match(v.postcode, /^WR\d{1,2} \d[A-Z]{2}$/, v.name);

// Place line: a Lench with its distance, another village "near Evesham", a town by name.
assert.strictEqual(EP.placeLine(ev('Fayre — Church Lench Village Hall', '')), 'Church Lench Village Hall, about 5 miles north of Evesham');
assert.strictEqual(EP.placeLine(ev('Quiz — The Lenches Club', '')), 'The Lenches Club, Church Lench, about 5 miles north of Evesham');
assert.strictEqual(EP.placeLine(ev('Coffee — Norton Village Hall', '')), 'Norton Village Hall, near Evesham');
assert.strictEqual(EP.placeLine(ev('Comedy Club', 'At the Regal, Evesham.')), 'Evesham');
assert.strictEqual(EP.placeLine(ev('Carols — Rous Lench', '')), 'Rous Lench, about 6 miles north of Evesham');

// Time, from the body as the calendar links read it; none for multi-day events.
assert.strictEqual(EP.timeText(ev('x', 'From 7.30pm.')), '7.30pm');
assert.strictEqual(EP.timeText(ev('x', 'Coffee, 10am to noon.')), '10am to noon');
assert.strictEqual(EP.timeText(ev('x', '10am to 4pm both days.', '2026-12-05', { endDate: '2026-12-06' })), '');

// Price: only the price of going.
assert.deepStrictEqual(EP.priceOf(ev('x', 'Painting, £45 per person.')), { price: '45' });
assert.deepStrictEqual(EP.priceOf(ev('x', 'Tickets £9 for adults, £5 for children.')), { price: '9' });
assert.deepStrictEqual(EP.priceOf(ev('x', 'Santa party, £20 per child.')), { price: '20' });
assert.deepStrictEqual(EP.priceOf(ev('x', 'Games and stalls. Free entry.')), { price: '0' });
assert.strictEqual(EP.priceOf(ev('x', 'A raffle with a first prize of £100.')), null);
assert.strictEqual(EP.priceOf(ev('x', 'Free parking at the hall.')), null);
assert.strictEqual(EP.priceOf(ev('x', 'Gluten free cakes.')), null);

// Pages: upcoming plus 30 days past, one per slug; past = finished.
const list = EP.pageEvents([ev('Old', '', '2026-10-20'), ev('Recent', '', '2026-11-10'), ev('Soon', '', '2026-12-01'), ev('Soon', '', '2026-12-01')], '2026-11-26');
assert.deepStrictEqual(list.map((e) => e.title), ['Recent', 'Soon']);
assert.strictEqual(EP.isPast(list[0], '2026-11-26'), true);
assert.strictEqual(EP.isPast(ev('Multi', '', '2026-11-25', { endDate: '2026-11-27' }), '2026-11-26'), false);
const more = EP.moreEvents(list[1], [...list, ev('A', '', '2026-12-02'), ev('B', '', '2026-12-03'), ev('C', '', '2026-12-04')], '2026-11-26');
assert.deepStrictEqual(more.map((e) => e.title), ['A', 'B', 'C']);

// Schema: own page url, street address and postcode, offers only with a price, organiser only when set.
const s = eventSchema(ev('Wreaths — The Vale Golf & Country Club', 'Wreaths, 2pm-5pm, £50 per person.', '2026-12-06', { link: { text: 'Book', url: 'https://example.org/book' } }),
  { siteUrl: 'https://thelenches.org.uk', url: 'https://thelenches.org.uk/events/x/', image: null });
assert.strictEqual(s.url, 'https://thelenches.org.uk/events/x/');
assert.deepStrictEqual(s.location.address, { '@type': 'PostalAddress', streetAddress: 'Hill Furze Road', addressLocality: 'Bishampton', addressRegion: 'Worcestershire', postalCode: 'WR10 2LZ', addressCountry: 'GB' });
assert.strictEqual(s.offers.price, '50');
assert.strictEqual(s.offers.url, 'https://example.org/book');
assert.strictEqual(s.organizer, undefined);
const t = eventSchema(ev('Talk — Village Hut', 'A talk.', '2026-12-06', { organiser: 'Lenches Ladies' }), { siteUrl: 'https://thelenches.org.uk', id: 'ev-x', image: null });
assert.strictEqual(t.url, 'https://thelenches.org.uk/events/#ev-x');
assert.strictEqual(t.offers, undefined);
assert.deepStrictEqual(t.organizer, { '@type': 'Organization', name: 'Lenches Ladies' });
assert.strictEqual(t.location.address.postalCode, undefined);

// Links: the Lenches newsletter points at event pages (site.json eventPages).
const anchors = require('../lib/anchors.js');
const cfg = require('../lib/site.js').siteConfig();
const u = anchors.eventPageUrl(ev('Fayre — Church Lench Village Hall', '', '2026-11-28'));
if (cfg.eventPages === true) assert.strictEqual(u, `${cfg.url}/events/2026-11-28-fayre-church-lench-village-hall/`);
else assert.match(u, /\/events\/#ev-2026-11-28-/);
assert.match(anchors.anchorUrl('event', ev('Fayre', '', '2026-11-28')), /\/events\/#ev-2026-11-28-fayre$/);

console.log('event pages: all tests passed');
