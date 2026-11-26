// Links to an item's place on thelenches.org.uk, for the newsletter.
// The ids must match the templates exactly:
//   src/_includes/pages/events.njk  ('ev-' + date + '-' + title) | slugify   on /events/
//   src/_includes/pages/notices.njk ('notice-' + title) | slugify            on /notices/
//   lib/calendarpage.js /calendar/<the event id>.ics        (Add to calendar)
// "news" items are notices now (21 Oct 2026); /news/ redirects old links (src/news.njk).
// Eleventy's slugify filter is @sindresorhus/slugify with decamelize off
// (node_modules/@11ty/eleventy/src/Filters/Slugify.js); same module, same options here.
'use strict';

const { default: slugify } = require('@sindresorhus/slugify');

// The site's own address (site.json; Harvington stage 5a): the Lenches' is unchanged.
const CFG = require('./site').siteConfig();
const SITE = String(CFG.url || 'https://thelenches.org.uk').replace(/\/+$/, '');
const slug = (s) => slugify(String(s), { decamelize: false });

function anchorUrl(kind, item) {
  const title = String((item && item.title) || '');
  if (!title) return '';
  if (kind === 'event') return item.date ? `${SITE}/events/#${slug(`ev-${item.date}-${title}`)}` : '';
  if (kind === 'news' || kind === 'notice') return `${SITE}/notices/#${slug(`notice-${title}`)}`;
  return '';
}

// An event's own page (SEO step 1, 26 Nov 2026; lib/eventpage.js) on a site with "eventPages": true,
// else its place on the Events page as before. The newsletter's event links use this; anchorUrl stays
// the Events-page anchor (Now on the website emails check that anchor on the built page).
function eventPageUrl(item) {
  if (!item || !item.title || !item.date) return '';
  return CFG.eventPages === true ? `${SITE}${require('./eventpage.js').eventPath(item)}` : anchorUrl('event', item);
}

// An event's "Add to calendar" file (lib/calendarpage.js writes one per upcoming event, same id as its anchor).
function calendarUrl(item) {
  const title = String((item && item.title) || '');
  return title && item.date ? `${SITE}/calendar/${slug(`ev-${item.date}-${title}`)}.ics` : '';
}

// The same event as a prefilled Google Calendar page (lib/ics.js googleCalendarUrl; 5 Nov 2026).
function googleCalendarLink(item) {
  const title = String((item && item.title) || '');
  if (!title || !item.date) return '';
  return require('./ics.js').googleCalendarUrl(item, { url: eventPageUrl(item) });
}

// Regular activity card on /regulars/ (src/_includes/pages/regulars.njk: ('reg-' + day + '-' + what + '-' + where) | slugify).
function regularUrl(r) {
  return `${SITE}/regulars/#${slug(`reg-${(r && r.day) || 'other'}-${(r && r.what) || ''}-${(r && r.where) || ''}`)}`;
}
// True when the card shows more than the newsletter line (who runs it, contacts, costs, flyer...).
const REGULAR_DETAILS = ['about', 'runBy', 'phone', 'email', 'website', 'forWho', 'cost', 'booking', 'bring', 'image'];
const regularHasDetails = (r) => Boolean(r) && r.detailsElsewhere !== true && REGULAR_DETAILS.some((k) => r[k]);

module.exports = { anchorUrl, eventPageUrl, calendarUrl, googleCalendarLink, regularUrl, regularHasDetails, slug };
