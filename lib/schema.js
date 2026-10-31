// schema.org structured data (JSON-LD) for search engines: the site and its villages on the
// home page, and one Event per upcoming event on the Events page (Google's event listings).
// Times come from the body text as for "Add to calendar" (lib/ics.js), else all-day dates;
// the venue is the part of the title after " — ", the locality the first place named.
// endDate is always set (Search Console warning, 31 Oct 2026): the end date, end time or same day.
'use strict';

const { startTime, locationOf } = require('./ics.js');
const { placesIn } = require('./places.js');

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

// One schema.org Event. opts: { siteUrl, id (page anchor), image (url or null) }.
function eventSchema(e, { siteUrl, id, image }) {
  const multi = e.endDate && e.endDate !== e.date;
  const time = multi ? null : startTime(e.body);
  const venue = locationOf(e.title);
  const locality = placesIn(`${e.title} ${e.body || ''}`)[0] || 'The Lenches';
  const out = {
    '@type': 'Event',
    name: e.title,
    startDate: time ? stamp(e.date, time.start) : e.date,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: venue || locality,
      address: { '@type': 'PostalAddress', addressLocality: locality, addressRegion: 'Worcestershire', addressCountry: 'GB' },
    },
    description: String(e.body || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    url: `${siteUrl}/events/#${id}`,
  };
  // Google asks for endDate on every event: a start time with no end gets one hour (as the
  // calendar file does, lib/ics.js); an all-day event ends on its own day.
  if (multi) out.endDate = e.endDate;
  else if (time) out.endDate = stamp(e.date, time.end != null ? time.end : Math.min(time.start + 60, 24 * 60 - 1));
  else out.endDate = e.date;
  if (image) out.image = [abs(image, siteUrl)];
  return out;
}

// The site and the area it covers (no person named: anonymity rule).
function siteSchema(site) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${site.url}/#website`, name: 'The Lenches', alternateName: 'The Lenches Website', url: `${site.url}/`, inLanguage: 'en-GB', description: site.description, publisher: { '@id': `${site.url}/#org` } },
      {
        '@type': 'Organization', '@id': `${site.url}/#org`, name: 'The Lenches Website and Newsletter', url: `${site.url}/`,
        areaServed: ['Church Lench', 'Rous Lench', 'Ab Lench', 'Atch Lench', 'Sheriffs Lench'].map((name) => ({
          '@type': 'Place', name, address: { '@type': 'PostalAddress', addressLocality: name, addressRegion: 'Worcestershire', addressCountry: 'GB' },
        })),
      },
    ],
  };
}

// JSON for a <script type="application/ld+json"> block: "<" escaped so text can't close the tag.
const ldJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

module.exports = { eventSchema, siteSchema, ldJson, ukOffset };
