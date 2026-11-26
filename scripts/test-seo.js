// SEO report (SEO step 7, 26 Nov 2026): lib/seo.js. Run: node scripts/test-seo.js
'use strict';
const assert = require('assert');
const { seoReport, hasPhrase } = require('../lib/seo.js');

assert.ok(hasPhrase('Bin collection days — the Lenches', 'Lenches bin collection'));
assert.ok(hasPhrase("What's on near Evesham", 'events near Evesham') === false);
assert.ok(hasPhrase('Pubs and cafés near Evesham', 'pubs near Evesham'));
assert.ok(hasPhrase('Clubs and groups in the Lenches', 'Lenches club'));

const page = (title, desc, h1, links = '') => `<html><head><title>${title}</title><meta name="description" content="${desc}"></head><body><h1>${h1}</h1>${links}</body></html>`;
const r = seoReport([
  { url: '/', html: page('The Lenches — village website for five villages', 'A long enough description of the Lenches villages near Evesham, with events and news.', 'The Lenches', '<a href="/bins/">Bins</a><a href="/events/2026-12-01-x/">x</a>') },
  { url: '/bins/', html: page('Bins', 'Short.', 'Bins') },
  { url: '/orphan/', html: page('The Lenches — village website for five villages', 'Short.', 'Orphan') },
  { url: '/privacy/', html: page('Privacy policy for the Lenches website', 'A long enough description of how the Lenches website handles your personal data.', 'Privacy', '<a href="/">Home</a>') },
  { url: '/hidden/', html: '<html><head><meta name="robots" content="noindex"><title>x</title></head><body></body></html>' },
  { url: '/events/2026-12-01-x/', html: page('x', 'y', 'x') },
], { '/': 'the Lenches', '/bins/': 'Lenches bin collection' }, { now: 't', skip: ['/privacy/'] });
const by = Object.fromEntries(r.pages.map((p) => [p.url, p.problems]));
assert.deepStrictEqual(Object.keys(by).sort(), ['/', '/bins/', '/orphan/', '/privacy/']);
assert.strictEqual(r.eventPages, 1);
assert.deepStrictEqual(by['/'], ['Same search title as another page']);
assert.ok(by['/bins/'].includes('Search phrase not in the search title'));
assert.ok(by['/bins/'].some((p) => p.startsWith('Search title is short')));
assert.ok(by['/bins/'].some((p) => p.startsWith('Description is short')));
assert.ok(by['/orphan/'].includes('No search phrase chosen'));
assert.ok(by['/orphan/'].includes('No other page links to it'));
assert.deepStrictEqual(by['/privacy/'], ['No other page links to it']);
console.log('seo: all tests passed');
