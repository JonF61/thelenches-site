// lib/photopages.js
// Where each published photo appears on the site, for the admin panel's "On the website"
// links. Run at the end of every build (.eleventy.js, eleventy.after): it scans the built
// pages for /images/photos/<slug>.webp|.jpg and writes _site/photo-pages.json:
//   { generated, pages: { slug: [{ label, url }] } }
// Only already-public facts go in: the slug (already in the public image address), the
// page address with an anchor already on that page, and a label from the page's own
// heading text. Nothing from the Sheet or Drive is read here.
'use strict';

const IMG = /<img\b[^>]*\bsrc="[^"]*\/images\/photos\/([a-z0-9-]{1,100})\.(?:webp|jpg)"[^>]*>/g;
const ID = /<[a-z][a-z0-9]*\b[^>]*\bid="([^"]+)"/g;
const PHOTO_ID = /^photo-/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', middot: '·', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});
// Text of an element's inner HTML: badges (<span>…</span>) dropped, tags removed.
const text = (html) => decode(html.replace(/<span\b[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The page's name: its <h1> inside <main> (the home page has the site name instead).
function pageName(html, url) {
  if (url === '/') return 'Home page';
  const main = html.slice(Math.max(html.indexOf('<main'), 0));
  const m = main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
  return m ? text(m[1]) : url;
}

// Every id in the page's <main>, in order: [{ id, at }] (header ids would jump to the top).
function ids(html) {
  const main = Math.max(html.indexOf('<main'), 0);
  const out = [];
  for (const m of html.matchAll(ID)) if (m.index > main) out.push({ id: m[1], at: m.index });
  return out;
}

// "ev-2026-11-12-..." -> "12 Nov" (Events cards repeat a title on several dates).
function evDate(id) {
  const m = id.match(/^ev-\d{4}-(\d{2})-(\d{2})-/);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : '';
}

// One page: [{ slug, label, url }] for each photo on it (one per slug and anchor).
function scanPage(html, url) {
  const name = pageName(html, url);
  const all = ids(html);
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(IMG)) {
    const [tag, slug] = m;
    const at = m.index;
    const before = all.filter((x) => x.at <= at);
    // Anchor: the image's own photo-<slug> id (on it or its <figure>), else the nearest id above it.
    const own = before.filter((x) => x.id === `photo-${slug}` && at - x.at < 400).pop();
    const section = before.filter((x) => !PHOTO_ID.test(x.id)).pop();
    const anchor = own || section;
    // Sub-label: the figure caption, else the first h2/h3 from the section's start up to the next section.
    let sub = '';
    const fig = html.slice(at, at + 2000).match(/^[\s\S]*?(<\/figure>|<figure\b)/);
    if (fig && fig[1] === '</figure>') {
      const cap = fig[0].match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/);
      if (cap) sub = text(cap[1].split('&middot;')[0]);
    }
    if (!sub && section) {
      const next = all.find((x) => x.at > section.at && !PHOTO_ID.test(x.id));
      const region = html.slice(section.at, next ? next.at : undefined);
      const hm = region.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/);
      if (hm) sub = text(hm[1]);
      const d = evDate(section.id);
      if (sub && d) sub = `${sub}, ${d}`;
    }
    const href = anchor ? `${url}#${anchor.id}` : url;
    if (seen.has(`${slug} ${href}`)) continue;
    seen.add(`${slug} ${href}`);
    out.push({ slug, label: sub && sub !== name ? `${name}: ${sub}` : name, url: href });
  }
  return out;
}

// All pages -> { generated, pages }. Only slugs in photos.json (published) are kept.
// results: Eleventy's [{ url, content }]. Pages sorted by label within each slug.
function photoPages(results, slugs, generated = new Date().toISOString()) {
  const keep = new Set(slugs);
  const pages = {};
  for (const r of results || []) {
    if (!r || typeof r.content !== 'string' || !/\.html$/.test(String(r.outputPath || 'x.html')) || !r.url) continue;
    for (const p of scanPage(r.content, r.url)) {
      if (!keep.has(p.slug)) continue;
      (pages[p.slug] = pages[p.slug] || []).push({ label: p.label, url: p.url });
    }
  }
  const sorted = {};
  for (const slug of Object.keys(pages).sort()) sorted[slug] = pages[slug].sort((a, b) => a.label.localeCompare(b.label) || a.url.localeCompare(b.url));
  return { generated: generated.replace(/\.\d+Z$/, 'Z'), pages: sorted };
}

module.exports = { photoPages, scanPage };
