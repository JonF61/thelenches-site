// schema.org structured data (JSON-LD) for search engines: the site and its villages on the
// home page, and one Event per upcoming event on the Events page (Google's event listings).
// Times come from the body text as for "Add to calendar" (lib/ics.js), else all-day dates;
// the venue is the part of the title after " — ", the locality the first place named.
// endDate is always set (Search Console warning, 31 Oct 2026): the end date, end time or same day.
'use strict';

const { startTime, locationOf } = require('./ics.js');
const { placesIn } = require('./places.js');
const { venueOf, priceOf } = require('./eventpage.js');

const pad = (n) => String(n).padStart(2, '0');

// UK offset ("+00:00" or "+01:00") on a given date at a given minute after midnight.
function ukOffset(iso, minutes) {
  const t = new Date(`${iso}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00Z`);
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' })
    .formatToParts(t).find((p) => p.type === 'timeZoneName').value;
  return name === 'BST' ? '+01:00' : '+00:00';
}
const stamp = (iso, min) => `${iso}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00${ukOffset(iso, min)}`;

const abs = (url, siteUrl) => (/^https?:\/\//.test(url) ? url : siteUrl + (url.startsWith('/') ? '' : '/') + url);

// One schema.org Event. opts: { siteUrl, url (the event's own page, or its Events-page anchor),
// id (the anchor, when no url is given), image (url or null) }.
// SEO step 3 (26 Nov 2026): a venue in lib/venues.json gives the street address and postcode; offers
// only when the text gives a £ price or says it's free (lib/eventpage.js priceOf); organizer only from
// an event's own "organiser" field (a group, never a person).
function eventSchema(e, { siteUrl, url, id, image, area = 'The Lenches' }) {
  const multi = e.endDate && e.endDate !== e.date;
  const time = multi ? null : startTime(e.body);
  const known = venueOf(e);
  const venue = locationOf(e.title);
  const locality = (known && known.locality) || placesIn(`${e.title} ${e.body || ''}`)[0] || area;
  const address = { '@type': 'PostalAddress' };
  if (known && known.street) address.streetAddress = known.street;
  Object.assign(address, { addressLocality: locality, addressRegion: 'Worcestershire' });
  if (known && known.postcode) address.postalCode = known.postcode;
  address.addressCountry = 'GB';
  const page = url || `${siteUrl}/events/#${id}`;
  const out = {
    '@type': 'Event',
    name: e.title,
    startDate: time ? stamp(e.date, time.start) : e.date,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: venue || locality,
      address,
    },
    description: String(e.body || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    url: page,
  };
  // Google asks for endDate on every event: a start time with no end gets one hour (as the
  // calendar file does, lib/ics.js); an all-day event ends on its own day.
  if (multi) out.endDate = e.endDate;
  else if (time) out.endDate = stamp(e.date, time.end != null ? time.end : Math.min(time.start + 60, 24 * 60 - 1));
  else out.endDate = e.date;
  if (image) out.image = [abs(image, siteUrl)];
  const cost = priceOf(e);
  if (cost) {
    const link = e.link && /^https?:\/\//.test(String(e.link.url || '')) ? e.link.url : page;
    out.offers = { '@type': 'Offer', price: cost.price, priceCurrency: 'GBP', url: link, availability: 'https://schema.org/InStock' };
  }
  const org = String(e.organiser || '').trim();
  if (org) out.organizer = { '@type': 'Organization', name: org };
  return out;
}

// The site and the area it covers (no person named: anonymity rule). Names from site.json
// (name, brand) and its places from areaServed (Harvington stage 7b; the Lenches unchanged).
const LENCHES_AREA = ['Church Lench', 'Rous Lench', 'Ab Lench', 'Atch Lench', 'Sheriffs Lench'];
function siteSchema(site) {
  const name = site.name || 'The Lenches';
  const brand = `${site.brand || name} Website`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${site.url}/#website`, name, alternateName: brand, url: `${site.url}/`, inLanguage: 'en-GB', description: site.description, publisher: { '@id': `${site.url}/#org` } },
      {
        '@type': 'Organization', '@id': `${site.url}/#org`, name: `${brand} and Newsletter`, url: `${site.url}/`,
        areaServed: (site.areaServed || LENCHES_AREA).map((name) => ({
          '@type': 'Place', name, address: { '@type': 'PostalAddress', addressLocality: name, addressRegion: 'Worcestershire', addressCountry: 'GB' },
        })),
      },
    ],
  };
}

// JSON for a <script type="application/ld+json"> block: "<" escaped so text can't close the tag.
const ldJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

module.exports = { eventSchema, siteSchema, ldJson, ukOffset };
