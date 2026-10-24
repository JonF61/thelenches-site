// scripts/suggest/web.js
// Guarded web fetches for image suggestions (scripts/suggest) and for saving a chosen
// suggestion on approval (scripts/publish). Pipeline only: the admin panel never fetches
// anything from outside. Every fetch has a 10 s timeout and a 5 MB limit (read as a
// stream and cut off, so a lying or missing Content-Length can't get past it); images must
// be JPEG, PNG or WebP by both their Content-Type and their bytes. Organisers' sites are
// fetched only where robots.txt allows (robots: true); Pexels image addresses come from
// its API and skip that check. Social media and our own site are never fetched.
// Page parsing: og:image, twitter:image and a logo (schema.org logo, a "logo" <img>, or
// the apple-touch-icon), using the helpers in scripts/eventimages/find.js.
'use strict';

const sharp = require('sharp');
const { parseRobots, attrs, decode, metaGetter, absolute, BLOCKED_HOSTS, UA } = require('../eventimages/find');

const TIMEOUT_MS = 10000;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FORMATS = { jpeg: 'jpg', png: 'png', webp: 'webp' };

class Refused extends Error {}

function hostOf(href) {
  try { return new URL(href).hostname; } catch { return ''; }
}

// A web address we may fetch at all: https/http, not social media or our own site.
function fetchable(href) {
  let u;
  try { u = new URL(String(href || '').trim()); } catch { return false; }
  return /^https?:$/.test(u.protocol) && !BLOCKED_HOSTS.test(u.hostname);
}

// Body as a Buffer, at most max bytes: refused as soon as the stream passes the limit.
async function readCapped(res, max = MAX_BYTES) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Refused(`larger than ${Math.round(max / 1048576)} MB`);
  if (!res.body || !res.body.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Refused(`larger than ${Math.round(max / 1048576)} MB`);
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Refused(`larger than ${Math.round(max / 1048576)} MB`);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

function get(url, accept) {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: accept },
  });
}

const robotsCache = new Map();
function resetRobots() { robotsCache.clear(); }

// True if robots.txt lets us fetch href (no robots.txt = allowed; a server error = not).
async function robotsAllow(href) {
  const url = new URL(href);
  if (!robotsCache.has(url.origin)) {
    let rules = [];
    try {
      const res = await get(`${url.origin}/robots.txt`, 'text/plain');
      if (res.ok) rules = parseRobots((await readCapped(res, 512 * 1024)).toString('utf8'));
      else if (res.status >= 500) rules = [{ allow: false, len: 1, re: /^/ }];
    } catch { rules = []; }
    robotsCache.set(url.origin, rules);
  }
  const p = url.pathname + url.search;
  let best = null;
  for (const r of robotsCache.get(url.origin)) {
    if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function guarded(href, accept, { robots }) {
  if (!fetchable(href)) throw new Refused('not fetched (social media, our own site or not a web address)');
  if (robots && !(await robotsAllow(href))) throw new Refused('robots.txt disallows it');
  const res = await get(href, accept);
  if (!res.ok) throw new Refused(`HTTP ${res.status}`);
  if (robots && res.url && res.url !== href) {
    if (!fetchable(res.url)) throw new Refused('redirected to a site we do not fetch');
    if (!(await robotsAllow(res.url))) throw new Refused('robots.txt disallows it');
  }
  return res;
}

// { html, finalUrl } for a web page.
async function fetchPage(href, { robots = true } = {}) {
  const res = await guarded(href, 'text/html,application/xhtml+xml', { robots });
  if (!/html/i.test(res.headers.get('content-type') || '')) throw new Refused('not a web page');
  return { html: (await readCapped(res)).toString('utf8'), finalUrl: res.url || href };
}

// { buffer, ext, width, height, type } for a JPEG, PNG or WebP image; anything else is refused.
async function fetchImage(href, { robots = true } = {}) {
  const res = await guarded(href, 'image/jpeg,image/png,image/webp', { robots });
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(type)) throw new Refused(`not a JPEG, PNG or WebP (${type || 'no type'})`);
  const buffer = await readCapped(res);
  let meta;
  try { meta = await sharp(buffer, { failOn: 'none' }).metadata(); } catch { throw new Refused('not a readable image'); }
  const ext = FORMATS[meta.format];
  if (!ext) throw new Refused(`not a JPEG, PNG or WebP (${meta.format || 'unknown'})`);
  let w = meta.width || 0;
  let h = meta.height || 0;
  if ((meta.orientation || 1) >= 5) [w, h] = [h, w];
  return { buffer, ext, width: w, height: h, type };
}

/* -------------------------------------------------------------- parsing -- */

// schema.org logo of an Organization (or of the page's publisher/organizer).
function ldLogo(html) {
  let found = '';
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.logo) {
      const l = [].concat(node.logo)[0];
      const u = typeof l === 'string' ? l : l && (l.url || l.contentUrl);
      if (u) { found = u; return; }
    }
    for (const k of ['@graph', 'publisher', 'organizer', 'brand']) if (node[k]) visit(node[k]);
  };
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* bad JSON */ }
  }
  return found;
}

// The page's share images and logo, as absolute https addresses ('' if none).
function pageImages(html, base) {
  const meta = metaGetter(html);
  const og = absolute(meta('og:image:secure_url') || meta('og:image'), base);
  const twitter = absolute(meta('twitter:image') || meta('twitter:image:src'), base);
  let logo = absolute(ldLogo(html), base);
  if (!logo) {
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const a = attrs(m[0]);
      const src = a.src || a['data-src'] || '';
      if (/logo/i.test([a.class, a.id, a.alt, src].join(' '))) { logo = absolute(src, base); if (logo) break; }
    }
  }
  if (!logo) {
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const a = attrs(m[0]);
      if (/apple-touch-icon/i.test(a.rel || '') && a.href) { logo = absolute(a.href, base); if (logo) break; }
    }
  }
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = decode(html
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 2000);
  return {
    og, twitter, logo,
    siteName: meta('og:site_name').slice(0, 100),
    title: decode(titleM ? titleM[1] : '').replace(/\s+/g, ' ').trim().slice(0, 200),
    text,
  };
}

// Small JPEG as a data: address for the panel (kept under a Sheet cell's 50,000 characters).
async function thumbnail(buffer) {
  for (const [edge, quality] of [[240, 62], [180, 55], [120, 50]]) {
    const jpg = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality })
      .toBuffer();
    const uri = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    if (uri.length <= 45000) return uri;
  }
  return '';
}

module.exports = {
  fetchPage, fetchImage, pageImages, thumbnail, robotsAllow, resetRobots, readCapped, fetchable, hostOf, Refused,
  TIMEOUT_MS, MAX_BYTES, IMAGE_TYPES,
};
