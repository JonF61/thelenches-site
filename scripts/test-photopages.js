// scripts/test-photopages.js
// Offline test: lib/photopages.js (the build's _site/photo-pages.json, read by the admin
// panel for its "On the website" links). Sample pages for the labels and anchors, then a
// real build: every slug, address, anchor and label in the file must already be public
// on the built site, and nothing else goes in. Run: node scripts/test-photopages.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { photoPages, scanPage, eventEnds } = require('../lib/photopages');

const REPO = path.resolve(__dirname, '..');
const page = (body) => `<html><head><title>x</title></head><body><header><a id="top">Site</a></header><main class="container">${body}</main></body></html>`;

// Events: anchored to the card, labelled with the card's title (badge left out) and date.
let r = scanPage(page(`<h1>Events</h1>
  <div class="item-card" id="ev-2026-11-07-bonfire-night">
    <div class="item-body"><a href="/images/photos/bonfire.webp"><img class="item-thumb" src="/images/photos/bonfire.webp" alt=""></a>
    <h3>Bonfire &amp; Fireworks Night <span class="lenches-badge">Lenches</span></h3></div></div>
  <div class="item-card" id="ev-2026-11-14-bonfire-night">
    <div class="item-body"><img src="/images/photos/bonfire.webp" alt=""><h3>Bonfire &amp; Fireworks Night</h3></div></div>`), '/events/');
assert.deepStrictEqual(r, [
  { slug: 'bonfire', label: 'Events: Bonfire & Fireworks Night, 7 Nov', url: '/events/#ev-2026-11-07-bonfire-night' },
  { slug: 'bonfire', label: 'Events: Bonfire & Fireworks Night, 14 Nov', url: '/events/#ev-2026-11-14-bonfire-night' },
]);

// Churches: the figure's own id, labelled with its caption (credit after the dot left out).
r = scanPage(page(`<div class="page-head" id="arch"><h1>Churches</h1></div><div class="gallery">
  <figure id="photo-church-a"><a href="/images/photos/church-a.webp"><img src="/images/photos/church-a.webp" alt="Tower"></a>
  <figcaption class="small">All Saints&#39;, Church Lench &middot; Photo: someone</figcaption></figure>
  <figure id="photo-church-b"><img src="/images/photos/church-b.jpg" alt=""><figcaption>St Peter's</figcaption></figure></div>
  <section id="services"><h2>Service times</h2></section>`), '/churches/');
assert.deepStrictEqual(r, [
  { slug: 'church-a', label: "Churches: All Saints', Church Lench", url: '/churches/#photo-church-a' },
  { slug: 'church-b', label: "Churches: St Peter's", url: '/churches/#photo-church-b' },
]);

// Halls: the image's own id, labelled with the section heading above it.
r = scanPage(page(`<h1>Village Halls</h1><section id="rous-lench"><h2>Rous Lench Village Hall</h2>
  <div class="gallery"><img id="photo-hall-1" src="/images/photos/hall-1.webp" alt=""></div><p>Text</p></section>`), '/halls/');
assert.deepStrictEqual(r, [{ slug: 'hall-1', label: 'Village Halls: Rous Lench Village Hall', url: '/halls/#photo-hall-1' }]);

// No id anywhere near: the page itself, labelled with its name; other images ignored.
r = scanPage(page('<h1>Walks</h1><img src="/images/photos/walk.webp"><img src="/images/items/flyer.webp">'), '/living-here/walks/');
assert.deepStrictEqual(r, [{ slug: 'walk', label: 'Walks', url: '/living-here/walks/' }], 'ids outside <main> not used');

// Whole list: only published slugs (photos.json), only the two fields, nothing else from the page.
const out = photoPages([
  { url: '/halls/', outputPath: '_site/halls/index.html', content: page('<h1>Village Halls</h1><img id="photo-hall-1" data-drive="1AbCdEfGhIjKlMnOpQrStUvWxYz012345" src="/images/photos/hall-1.webp">') },
  { url: '/old/', outputPath: '_site/old/index.html', content: page('<h1>Old</h1><img src="/images/photos/unpublished.webp">') },
  { url: '/photo-pages.json', outputPath: '_site/photo-pages.json', content: '"/images/photos/hall-1.webp"' },
], ['hall-1'], '2026-10-24T10:00:00.123Z');
assert.deepStrictEqual(out, { generated: '2026-10-24T10:00:00Z', pages: { 'hall-1': [{ label: 'Village Halls', url: '/halls/#photo-hall-1' }] } });
assert.ok(!JSON.stringify(out).includes('1AbCdEf'), 'attributes other than src and id never copied');

/* ---------------------------------------------------- a real site build -- */

fs.rmSync(path.join(REPO, '_site', 'photo-pages.json'), { force: true });
execFileSync('npx', ['@11ty/eleventy', '--quiet'], { cwd: REPO, stdio: 'ignore' });
const file = JSON.parse(fs.readFileSync(path.join(REPO, '_site', 'photo-pages.json'), 'utf8'));
const published = JSON.parse(fs.readFileSync(path.join(REPO, 'src', '_data', 'photos.json'), 'utf8'));
const slugs = new Set(published.map((p) => p.slug));
const htmlOf = (url) => fs.readFileSync(path.join(REPO, '_site', url.replace(/^\//, ''), 'index.html'), 'utf8');

assert.deepStrictEqual(Object.keys(file).sort(), ['eventEnds', 'generated', 'pages']);
assert.match(file.generated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
assert.ok(Object.keys(file.pages).length > 0, 'the current site has photos on pages');
const sheetOnly = ['drive_id', 'drive_link', 'filename', 'description', 'people', 'notes', 'dhash', 'path'];
for (const [slug, list] of Object.entries(file.pages)) {
  assert.ok(slugs.has(slug), `${slug} is published (in photos.json)`);
  for (const p of list) {
    assert.deepStrictEqual(Object.keys(p).sort(), ['label', 'url']);
    const [where, anchor] = p.url.split('#');
    assert.ok(anchor, `${p.url} is anchored`);
    assert.match(where, /^\/[a-z0-9/-]*\/$/, p.url);
    const html = htmlOf(where);
    assert.ok(html.includes(`/images/photos/${slug}.`), `${slug} is on ${where}`);
    assert.ok(html.includes(`id="${anchor}"`), `#${anchor} is on ${where}`);
    const name = p.label.split(': ')[0];
    assert.ok(html.includes(`<h1>${name}`), `label "${p.label}" starts with the page's own heading`);
  }
}
// Nothing from the Sheet or Drive: only slug, label, url and the time ever appear.
const text = JSON.stringify(file);
for (const k of sheetOnly) assert.ok(!text.includes(`"${k}"`), k);
assert.ok(!/drive\.google|docs\.google|googleapis|@/.test(text), 'no Google addresses or emails');
// The pages the current photos are on today.
assert.deepStrictEqual(file.pages['rous-lench-img-3113'], [{ label: 'Village Halls: Rous Lench Village Hall', url: '/halls/#photo-rous-lench-img-3113' }]);
assert.ok(Object.values(file.pages).flat().some((p) => p.label.startsWith('Churches: ')));

// Multi-day events' last days, keyed as the Image fetch tab keys events (start|title).
assert.deepStrictEqual(eventEnds([
  { date: '2026-11-14', endDate: '2026-11-15', title: 'Craft  fair — Church Lench ' },
  { date: '2026-11-20', title: 'One day' },
  { date: '2026-11-21', endDate: '2026-11-21', title: 'Same day' },
]), { '2026-11-14|Craft fair — Church Lench': '2026-11-15' });
assert.ok(file.eventEnds && typeof file.eventEnds === 'object', 'build writes eventEnds');

console.log(`photo-pages: all checks passed (${Object.keys(file.pages).length} photos on pages in this build).`);
