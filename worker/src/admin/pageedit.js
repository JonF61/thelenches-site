// worker/src/admin/pageedit.js
// Edit page: Jon's in-page text editor (footer "Edit page" link -> /admin/page?p=/privacy/,
// behind Cloudflare Access like the rest of /admin).
//   GET  /admin/page?p=        the live page, scripts removed, with the editor (ui/pageedit.js)
//                              and the page's editable blocks: plain text blocks (p, h1-h6, li,
//                              td, th, dt, dd, figcaption) written word-for-word in the page's
//                              own .njk file, with no template tags and found only once there
//   POST /admin/api/page-save  { path, changes: [{ old, new }] }: each old must still be one of
//                              those blocks; new is wording and links only (cleanInline). One
//                              commit to main with the Worker's token; build.yml publishes it.
// Only page templates (src/*.njk, never _includes, _data or items) can change; text built
// from data files or template logic stays greyed out on the page ("Ask Kryten").

import { github } from '../core.js';

export const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'dt', 'dd', 'figcaption'];
const BLOCK_RE = new RegExp(`<(${BLOCK_TAGS.join('|')})(\\s[^<>]*)?>([\\s\\S]*?)</\\1\\s*>`, 'gi');
// Inner HTML that holds another block, a template tag or anything but simple inline text.
const NOT_PLAIN = /<\/?(p|div|ul|ol|li|table|tr|td|th|dl|dt|dd|h[1-6]|section|article|aside|nav|header|footer|main|figure|figcaption|form|details|summary|blockquote|script|style|iframe|img|svg|picture|input|button|select|textarea)\b|\{\{|\{%|\{#|%\}|\}\}|#\}/i;
const MAX_CHANGES = 30;
const MAX_BLOCK = 8000;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '\u2013', mdash: '\u2014',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', pound: '\u00a3',
  times: '\u00d7', middot: '\u00b7', bull: '\u2022', copy: '\u00a9', eacute: '\u00e9', rarr: '\u2192',
  larr: '\u2190', deg: '\u00b0', frac12: '\u00bd', euro: '\u20ac', shy: '\u00ad', zwj: '\u200d', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
};

// The text a browser shows for some inline HTML, whitespace collapsed; null if it uses an
// entity this list doesn't know (that block then stays greyed out).
export function textOf(html) {
  let unknown = false;
  const s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : (unknown = true, m);
      }
      if (e in ENTITIES) return ENTITIES[e];
      unknown = true;
      return m;
    });
  return unknown ? null : s.replace(/[\s\u00a0]+/g, ' ').trim();
}

// Editable blocks of a page template: [{ tag, raw, text, whole }], raw = the exact inner
// HTML, whole = the element as written (found exactly once in the file, and no other block
// has the same inner HTML, so raw alone identifies it).
export function editableBlocks(source) {
  const src = String(source);
  // Template comments and {% raw %} hide nothing editable; drop matches inside them.
  const hidden = [];
  for (const m of src.matchAll(/\{#[\s\S]*?#\}|\{%-?\s*(raw|verbatim)\s*-?%\}[\s\S]*?\{%-?\s*end(raw|verbatim)\s*-?%\}/g)) {
    hidden.push([m.index, m.index + m[0].length]);
  }
  const out = [];
  const seen = new Map();
  for (const m of src.matchAll(BLOCK_RE)) {
    seen.set(m[3], (seen.get(m[3]) || 0) + 1);
    const [, tag, attrs = '', raw] = m;
    if (hidden.some(([a, b]) => m.index >= a && m.index < b)) continue;
    if (/\{\{|\{%/.test(attrs) || NOT_PLAIN.test(raw) || raw.length > MAX_BLOCK) continue;
    const text = textOf(raw);
    if (!text) continue;
    if (src.split(m[0]).length !== 2) continue; // the element must occur exactly once in the file
    out.push({ tag: tag.toLowerCase(), raw, text, whole: m[0] });
  }
  return out.filter((b) => seen.get(b.raw) === 1);
}

const INLINE_TAGS = new Set(['a', 'strong', 'em', 'b', 'i', 'br', 'span', 'abbr', 'small', 'sup', 'sub', 'code', 'time']);
const ATTRS = new Set(['href', 'class', 'title', 'rel', 'target', 'aria-label', 'datetime', 'lang']);
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

// New wording for a block: text plus simple inline tags only. { ok, value } or { ok: false, error }.
export function cleanInline(html) {
  const s = String(html ?? '');
  if (s.length > MAX_BLOCK) return { ok: false, error: 'Too long' };
  if (/\{\{|\{%|\{#|%\}|\}\}|#\}/.test(s)) return { ok: false, error: 'Curly-brace tags ({{ }} or {% %}) can\'t be typed here' };
  if (/<!--/.test(s)) return { ok: false, error: 'Comments are not allowed' };
  if (!textOf(s)) return { ok: false, error: 'A block can\'t be left empty: ask Kryten to remove it' };
  const tagRe = /<\/?([a-z][a-z0-9]*)\b([^<>]*)>|<|>/gi;
  for (const m of s.matchAll(tagRe)) {
    if (!m[1]) return { ok: false, error: 'Stray < or > (type them as &lt; and &gt;)' };
    const tag = m[1].toLowerCase();
    if (!INLINE_TAGS.has(tag)) return { ok: false, error: `<${tag}> is not allowed: wording and links only` };
    const attrs = m[2] || '';
    const rest = attrs.replace(/\s+([a-z-]+)\s*=\s*("[^"]*"|'[^']*')/gi, (a, name, val) => {
      const n = name.toLowerCase();
      if (!ATTRS.has(n)) throw new AttrError(n);
      if (n === 'href' && !SAFE_HREF.test(textOf(val.slice(1, -1)) || '')) throw new AttrError('href');
      return '';
    }).replace(/\s*\/?\s*$/, '');
    if (rest.trim()) return { ok: false, error: `Odd markup in <${tag}>` };
  }
  return { ok: true, value: s };
}

class AttrError extends Error {
  constructor(name) {
    super(name === 'href' ? 'Links must start https://, mailto:, tel: or /' : `The ${name} attribute is not allowed`);
  }
}

function safeClean(html) {
  try {
    return cleanInline(html);
  } catch (e) {
    if (e instanceof AttrError) return { ok: false, error: e.message };
    throw e;
  }
}

// "./src/privacy.njk" (Eleventy's page.inputPath) -> "src/privacy.njk", or '' if not a page template.
export function sourcePath(p) {
  const s = String(p || '').replace(/^\.\//, '');
  return /^src\/(?!_)(?:[a-z0-9-]+\/)*[a-z0-9-]+\.njk$/.test(s) && !s.startsWith('src/items/') ? s : '';
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const fromB64 = (b) => dec.decode(Uint8Array.from(atob(String(b).replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
function toB64(text) {
  const u8 = enc.encode(text);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A page template's current text and blob sha on main.
export async function readSource(env, path) {
  const r = await github(env, `/repos/${env.REPO}/contents/${path}?ref=main`);
  if (!r.ok) throw Object.assign(new Error(`GitHub contents ${path}: HTTP ${r.status}`), { status: r.status });
  const j = await r.json();
  return { text: fromB64(j.content), sha: j.sha };
}

// Applies the edits to the file's text; { ok, text, count } or { ok: false, status, error }.
export function applyChanges(text, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) {
    return { ok: false, status: 400, error: 'Nothing to save' };
  }
  const blocks = editableBlocks(text);
  let out = text;
  let count = 0;
  for (const c of changes) {
    const old = String(c && c.old || '');
    const block = blocks.find((b) => b.raw === old);
    if (!block) {
      return { ok: false, status: 409, error: `Changed since you opened the page: "${(textOf(old) || '').slice(0, 60)}". Reload and try again.` };
    }
    const fresh = safeClean(c.new);
    if (!fresh.ok) return { ok: false, status: 400, error: `${fresh.error} ("${(textOf(old) || '').slice(0, 40)}…")` };
    if (fresh.value === old) continue;
    if (out.split(block.whole).length !== 2) {
      return { ok: false, status: 409, error: 'Two changes touch the same text. Reload and try again.' };
    }
    const open = block.whole.slice(0, block.whole.length - old.length - block.whole.match(/<\/[a-z0-9]+\s*>$/i)[0].length);
    out = out.replace(block.whole, () => `${open}${fresh.value}${block.whole.slice(open.length + old.length)}`);
    count += 1;
  }
  return { ok: true, text: out, count };
}

export async function savePage(env, body) {
  const path = sourcePath(body.path);
  if (!path) return { ok: false, status: 400, error: 'Not a page that can be edited here' };
  const { text, sha } = await readSource(env, path);
  const done = applyChanges(text, body.changes);
  if (!done.ok) return done;
  if (!done.count) return { ok: true, count: 0, message: 'No changes to save.' };
  const r = await github(env, `/repos/${env.REPO}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Page edit: ${path.replace(/^src\//, '')} (${done.count} change${done.count === 1 ? '' : 's'}, from the admin panel)`,
      content: toB64(done.text),
      sha,
      branch: 'main',
    }),
  });
  if (r.status === 409 || r.status === 422) {
    return { ok: false, status: 409, error: 'The page changed while saving. Reload and try again.' };
  }
  if (!r.ok) return { ok: false, status: 502, error: `GitHub did not accept the change (HTTP ${r.status}). Nothing has changed.` };
  return { ok: true, count: done.count, message: `Saved ${done.count} change${done.count === 1 ? '' : 's'}. Live in about 2 minutes.` };
}

/* ---------------------------------------------------------- editor page -- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON safe inside <script type="application/json">.
const jsonForHtml = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

export function validPagePath(p) {
  const s = String(p || '');
  return /^\/(?:[a-z0-9_-]+\/)*$/.test(s) && s.length <= 200 ? s : '';
}

// The live page as the editor shows it: scripts out, <base> to the site, editor in.
export function editorHtml(live, { origin, site, page, data, version }) {
  let html = String(live)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const base = `<base href="${esc(new URL(page, site).href)}">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : base + html;
  const tail = `<link rel="stylesheet" href="${esc(origin)}/admin/pageedit.css?v=${esc(version)}">`
    + `<script type="application/json" id="lenches-edit-data">${jsonForHtml(data)}</script>`
    + `<script src="${esc(origin)}/admin/pageedit.js?v=${esc(version)}" defer></script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tail}</body>`) : html + tail;
}

export function editorCsp(origin, site) {
  const s = new URL(site).origin;
  return [
    "default-src 'none'",
    `script-src ${origin}`,
    `style-src ${origin} ${s} https://fonts.googleapis.com 'unsafe-inline'`,
    `font-src ${s} https://fonts.gstatic.com`,
    `img-src ${s} https: data:`,
    `connect-src ${origin}`,
    `base-uri ${s}`,
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Everything the editor page needs: { status, html } (html is a plain message page on failure).
export async function editorPage(env, { page, origin, csrf, version, fetcher = fetch }) {
  const p = validPagePath(page);
  const site = String(env.SITE_URL || 'https://thelenches.org.uk/');
  const message = (status, text) => ({
    status,
    html: `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit page</title></head>`
      + `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem"><p>${esc(text)}</p>`
      + `<p><a href="${esc(new URL(p || '/', site).href)}">Back to the page</a></p></body></html>`,
    csp: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  if (!p) return message(400, 'That page address isn\'t one that can be edited here.');
  // A fresh copy, not the Pages cache (just after a save it can still show the old text).
  const live = await fetcher(`${new URL(p, site).href}?edit=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!live.ok) return message(502, `Couldn't load the page (HTTP ${live.status}).`);
  const html = await live.text();
  const m = html.match(/data-src="([^"]+)"/);
  const path = sourcePath(m && m[1]);
  if (!path) return message(404, 'This page has no text that can be edited here: ask Kryten.');
  const { text, sha } = await readSource(env, path);
  const blocks = editableBlocks(text).map(({ tag, raw, text: t }) => ({ tag, raw, text: t })); // whole stays here
  return {
    status: 200,
    html: editorHtml(html, { origin, site, page: p, version, data: { page: p, path, sha, csrf, blocks, live: new URL(p, site).href, api: `${origin}/admin/api/page-save` } }),
    csp: editorCsp(origin, site),
  };
}
