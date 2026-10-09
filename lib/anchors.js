// Links to an item's place on thelenches.org.uk, for the newsletter.
// The ids must match the templates exactly:
//   src/events.njk  ('ev-' + date + '-' + title) | slugify   on /events/
//   src/news.njk    ('news-' + title) | slugify              on /news/
//                   ('notice-' + title) | slugify            on /news/
// Eleventy's slugify filter is @sindresorhus/slugify with decamelize off
// (node_modules/@11ty/eleventy/src/Filters/Slugify.js); same module, same options here.
'use strict';

const { default: slugify } = require('@sindresorhus/slugify');

const SITE = 'https://thelenches.org.uk';
const slug = (s) => slugify(String(s), { decamelize: false });

function anchorUrl(kind, item) {
  const title = String((item && item.title) || '');
  if (!title) return '';
  if (kind === 'event') return item.date ? `${SITE}/events/#${slug(`ev-${item.date}-${title}`)}` : '';
  if (kind === 'news') return `${SITE}/news/#${slug(`news-${title}`)}`;
  if (kind === 'notice') return `${SITE}/news/#${slug(`notice-${title}`)}`;
  return '';
}

module.exports = { anchorUrl, slug };
