// scripts/test-standing-images.js
// Offline test: a newsletter event with no image of its own uses the Lenches Photos picture
// tagged for it (photos.json "event:" target), as the Events page does; never for notices;
// its own image still wins; the 2-issue picture limit applies; no JPEG copy = text only.
// Run: node scripts/test-standing-images.js
'use strict';

const assert = require('assert');
const { select, whatsonKey } = require('./newsletter/select');

const photos = [{ src: '/images/photos/vale-murder.webp', alt: 'Murder mystery poster', targets: ['event:terror lies ahead'] }];
const jpegFor = (u) => `https://thelenches.org.uk${u.replace(/\.webp$/, '.jpg')}`;
const ev = { date: '2026-10-30', title: 'Murder Mystery Dinner: Terror Lies Ahead — Bishampton', body: 'x' };
const base = {
  issueDate: '2026-10-29', settings: {}, sources: [], jpegFor, cutoff: '', bins: {}, siteupdates: { entries: [] }, onthisday: { entries: {} },
  issues: [], photos,
  whatson: { events: [ev], notices: [{ title: 'Terror lies ahead notice', body: 'y' }] },
  pending: [{ id: 'p1', title: 'Terror Lies Ahead — pipeline copy', body: 'z', category: 'event', status: 'approved', event_date: '2026-10-31', received: '2026-10-26 10:00' }],
};

let m = select(base);
const hand = m.events.find((e) => e.title.startsWith('Murder'));
assert.deepStrictEqual(hand.image, { src: 'https://thelenches.org.uk/images/photos/vale-murder.jpg', alt: 'Murder mystery poster' });
assert.ok(m.events.find((e) => e.key === 'p:p1').image, 'pipeline event too');
assert.strictEqual(m.notices[0].image, null, 'never for notices');

// Own image wins.
m = select({ ...base, whatson: { events: [{ ...ev, image: { url: '/images/items/own.webp', alt: 'own' } }], notices: [] } });
assert.strictEqual(m.events[0].image.src, 'https://thelenches.org.uk/images/items/own.jpg');

// Picture limit: shown with a picture in 2 earlier issues -> text only.
const key = whatsonKey('events', ev);
const sent = [1, 2].map((n) => ({ issue_date: `2026-10-${10 + n}`, status: 'sent', item_keys: key, image_keys: key }));
m = select({ ...base, issues: sent, pending: [] });
assert.strictEqual(m.events[0].image, null);

// No JPEG copy, or no photos list: text only.
assert.strictEqual(select({ ...base, jpegFor: () => '', pending: [] }).events[0].image, null);
assert.strictEqual(select({ ...base, photos: undefined, pending: [] }).events[0].image, null);

console.log('standing images: all tests passed');
