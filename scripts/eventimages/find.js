// scripts/eventimages/find.js
// Finds the share image on an event's linked page: schema.org Event image, then
// og:image, then twitter:image, then the largest content image. Skips logos/icons,
// stock libraries, SVG/GIF, images under 600px on the long side or wider than 3:1,
// and the site's own homepage share image (a site-wide default). Obeys robots.txt,
// never fetches social media, one request per host every 1.5s.
'use strict';

const sharp = require('sharp');

const UA = 'LenchesPipeline/1.0 (+https://thelenches.org.uk)';
const BLOCKED_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|x\.com|twitter\.com|tiktok\.com|threads\.net|thelenches\.org\.uk)$/i;
const STOCK_HOSTS = /(gettyimages|shutterstock|istockphoto|alamy|adobestock|stock\.adobe|dreamstime|depositphotos|123rf|unsplash|pexels|pixabay|bigstockphoto|canstockphoto)/i;
const BAD_WORDS = /(logo|icon|avatar|favicon|sprite|placeholder|default|spacer|pixel|blank|button|badge|gravatar|emoji)/i;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const MIN_LONG = 600;
const MIN_SHORT = 200;
const MAX_RATIO = 3;
const MAX_TRIES = 6;         // candidate images looked at per page
const PAUSE_MS = 1500;       // per host
const TIMEOUT_MS = 20000;
const FORMATS = { jpeg: 'jpg', png: 'png', webp: 'webp' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- Fetching -- */

const lastHit = new Map();
async function politeFetch(url, accept) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) || 0) + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: accept },
  });
}

async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error(`larger than ${Math.round(max / 1048576)} MB`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`larger than ${Math.round(max / 1048576)} MB`);
  return buf;
}

/* ----------------------------------------------------------- robots.txt -- */

function ruleRegex(p) {
  const body = p.replace(/\$(?!$)/g, '\\$').replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}`);
}

function parseRobots(text) {
  const groups = [];
  let cur = null;
  let agentRun = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (!line || i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!agentRun) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      agentRun = true;
    } else {
      agentRun = false;
      if (cur && (k === 'allow' || k === 'disallow') && v) {
        try { cur.rules.push({ allow: k === 'allow', len: v.length, re: ruleRegex(v) }); } catch { /* bad rule */ }
      }
    }
  }
  const mine = groups.filter((g) => g.agents.includes('lenchespipeline'));
  return (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
}

const robotsCache = new Map();
async function allowed(href) {
  const url = new URL(href);
  if (!robotsCache.has(url.origin)) {
    let rules = [];
    try {
      const res = await politeFetch(`${url.origin}/robots.txt`, 'text/plain');
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

/* -------------------------------------------------------------- Parsing -- */

function decode(s) {
  return String(s || '')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ').replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/gi, '&');
}

function attrs(tag) {
  const out = {};
  const re = /([^\s=<>\/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function metaGetter(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  return (key) => {
    for (const a of metas) {
      const names = [a.property, a.name, a.itemprop].map((x) => String(x || '').toLowerCase());
      if (names.includes(key) && a.content) return a.content.trim();
    }
    return '';
  };
}

function absolute(src, base) {
  if (!src || /^data:/i.test(src)) return '';
  try {
    const u = new URL(String(src).trim(), base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') return '';
    if (/\.(svg|gif)$/i.test(u.pathname)) return '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

function bestSrc(a) {
  const set = a.srcset || a['data-srcset'] || '';
  if (set) {
    let best = '';
    let bw = -1;
    for (const part of set.split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const w = d && /w$/i.test(d) ? Number(d.slice(0, -1)) : 0;
      if (u && w > bw) { best = u; bw = w; }
    }
    if (best) return best;
  }
  return a['data-src'] || a['data-lazy-src'] || a['data-original'] || a.src || '';
}

// Image of the first schema.org Event on the page (listings pages often carry one).
function eventDataImage(html) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || out.length) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const types = [].concat(node['@type'] || []).map(String);
    if (types.some((t) => /event$/i.test(t))) {
      for (const im of [].concat(node.image || [])) {
        const u = typeof im === 'string' ? im : im && (im.url || im.contentUrl);
        if (u) { out.push(u); break; }
      }
    }
    if (node['@graph']) visit(node['@graph']);
  };
  for (const m of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* bad JSON */ }
  }
  return out[0] || '';
}

function pageInfo(html, base) {
  const meta = metaGetter(html);
  const cands = [];
  const add = (src, via, hint = '') => {
    const url = absolute(src, base);
    if (url && !cands.some((c) => c.url === url)) cands.push({ url, via, hint });
  };
  add(eventDataImage(html), 'event data');
  add(meta('og:image:secure_url') || meta('og:image'), 'og:image');
  add(meta('twitter:image') || meta('twitter:image:src'), 'twitter:image');
  const imgs = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const src = bestSrc(a);
    if (!src) continue;
    const w = Number(a.width) || 0;
    const h = Number(a.height) || 0;
    if (w && w < MIN_LONG && (!h || h < MIN_LONG)) continue; // declared small
    imgs.push({ src, w, hint: [a.alt, a.class, a.id].filter(Boolean).join(' ') });
  }
  imgs.sort((x, y) => y.w - x.w); // declared-large first, the rest in page order
  for (const i of imgs.slice(0, 6)) add(i.src, 'page image', i.hint);

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = decode(html
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, 2000);
  return {
    title: decode(titleM ? titleM[1] : '').replace(/\s+/g, ' ').trim().slice(0, 200),
    siteName: meta('og:site_name').slice(0, 100),
    shareImage: absolute(meta('og:image:secure_url') || meta('og:image'), base),
    text,
    candidates: cands,
  };
}

// The homepage's share image, per site: anything equal to it is a site-wide default.
const homeCache = new Map();
async function siteDefault(origin) {
  if (homeCache.has(origin)) return homeCache.get(origin);
  let img = '';
  try {
    if (await allowed(`${origin}/`)) {
      const res = await politeFetch(`${origin}/`, 'text/html');
      if (res.ok) img = pageInfo((await readCapped(res, MAX_HTML)).toString('utf8'), res.url || origin).shareImage;
    }
  } catch { img = ''; }
  homeCache.set(origin, img);
  return img;
}

/* --------------------------------------------------------------- Images -- */

async function tryImage(c) {
  const pathHint = `${decodeURIComponent(new URL(c.url).pathname)} ${c.hint || ''}`;
  if (STOCK_HOSTS.test(c.url)) return { skip: 'stock library' };
  if (BAD_WORDS.test(pathHint)) return { skip: 'looks like a logo or icon' };
  if (!(await allowed(c.url))) return { skip: 'robots.txt' };
  const res = await politeFetch(c.url, 'image/avif;q=0,image/webp,image/jpeg,image/png,image/*;q=0.8');
  if (!res.ok) return { skip: `HTTP ${res.status}` };
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/')) return { skip: `not an image (${type || 'no type'})` };
  const buffer = await readCapped(res, MAX_IMAGE);
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const ext = FORMATS[meta.format];
  if (!ext) return { skip: `format ${meta.format || 'unknown'}` };
  let w = meta.width || 0;
  let h = meta.height || 0;
  if ((meta.orientation || 1) >= 5) [w, h] = [h, w];
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long < MIN_LONG || short < MIN_SHORT) return { skip: `too small (${w}x${h})` };
  if (long / short > MAX_RATIO) return { skip: `banner shape (${w}x${h})` };
  return { ok: true, url: c.url, via: c.via, width: w, height: h, ext, buffer };
}

// Returns { ok, url, via, width, height, ext, buffer, page, finalUrl }
//      or { fail: reason }  (definite: recorded so the event isn't tried again)
//      or { retry: reason } (transient: tried again tomorrow)
async function findImage(link) {
  let url;
  try { url = new URL(link); } catch { return { fail: 'bad link' }; }
  if (!/^https?:$/.test(url.protocol)) return { fail: 'bad link' };
  if (BLOCKED_HOSTS.test(url.hostname)) return { fail: `${url.hostname} is not fetched (social media or our own site)` };
  if (!(await allowed(url.href))) return { fail: 'robots.txt disallows the page' };

  let res;
  try {
    res = await politeFetch(url.href, 'text/html,application/xhtml+xml');
  } catch (err) {
    return { retry: `page fetch failed: ${err.message}` };
  }
  if (res.status >= 500 || res.status === 429) return { retry: `page HTTP ${res.status}` };
  if (!res.ok) return { fail: `page HTTP ${res.status}` };
  if (!/html/i.test(res.headers.get('content-type') || '')) return { fail: 'link is not a web page' };
  let html;
  try { html = (await readCapped(res, MAX_HTML)).toString('utf8'); } catch (err) { return { fail: `page ${err.message}` }; }

  const finalUrl = res.url || url.href;
  const page = pageInfo(html, finalUrl);
  const final = new URL(finalUrl);
  const home = final.pathname.replace(/\/+$/, '') ? await siteDefault(final.origin) : '';
  const tried = [];
  for (const c of page.candidates.slice(0, MAX_TRIES)) {
    if (home && c.url === home) { tried.push(`${c.via}: site-wide default`); continue; }
    let r;
    try { r = await tryImage(c); } catch (err) { r = { skip: err.message }; }
    if (r.ok) return { ...r, page, finalUrl };
    tried.push(`${c.via}: ${r.skip}`);
  }
  return { fail: tried.length ? `no usable image (${tried.slice(0, 4).join('; ')})` : 'no image on the page', page };
}

module.exports = { findImage };
