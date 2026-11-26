// SEO report (SEO step 7, 26 Nov 2026): code-only checks of every indexable page the build wrote,
// for the admin panel's SEO screen (no Claude). Written to <output>/seo-report.json by
// .eleventy.js (eleventy.after). Keywords come from the site's _data/seo.json (approved by Jon).
//   per page: url, title, description, h1, keyword, and problems:
//     keyword missing from the title / description / main heading (words matched loosely:
//       case, apostrophes and "the" ignored, every word of the phrase present)
//     title over 65 or under 20 characters; description missing, under 70 or over 160
//     the same title or description as another page; no other page links to it
// Event pages (/events/<date>-…/) are counted, not checked one by one.
'use strict';

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&hellip;/g, '…')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&middot;/g, '·').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const first = (re, html) => { const m = re.exec(html); return m ? m[1] : ''; };

// Loose word match: every word of the phrase (bar "the") appears, as a word or its plural/possessive.
const words = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter((w) => w && w !== 'the');
function hasPhrase(hay, phrase) {
  const have = new Set(words(hay));
  return words(phrase).every((w) => have.has(w) || have.has(`${w}s`) || have.has(w.replace(/s$/, '')));
}

const EVENT_PAGE = /^\/events\/\d{4}-\d{2}-\d{2}-[^/]+\/$/;

function pageInfo(url, html) {
  const head = first(/<head[^>]*>([\s\S]*?)<\/head>/i, html);
  const body = first(/<body[^>]*>([\s\S]*)<\/body>/i, html) || html;
  return {
    url,
    noindex: /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(head),
    title: text(first(/<title>([\s\S]*?)<\/title>/i, head)),
    description: decode(first(/<meta[^>]+name=["']description["'][^>]+content=["']([^"]*)["']/i, head)).trim(),
    h1: text(first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, body)),
    links: [...body.matchAll(/<a\b[^>]*href=["']([^"'#?]*)/gi)].map((m) => m[1]).filter((h) => h.startsWith('/')),
  };
}

// pages: [{ url, html }] (url like "/events/"); keywords: { url: phrase }.
function seoReport(pages, keywords = {}, { now = new Date().toISOString(), skip = [] } = {}) {
  const infos = pages.filter((p) => /\.html$|\/$/.test(p.url)).map((p) => pageInfo(p.url, p.html)).filter((p) => !p.noindex);
  const linkedFrom = new Map();
  for (const p of infos) for (const h of new Set(p.links)) {
    const to = h.endsWith('/') ? h : `${h}/`;
    if (to === p.url) continue;
    linkedFrom.set(to, (linkedFrom.get(to) || 0) + 1);
  }
  const main = infos.filter((p) => !EVENT_PAGE.test(p.url) && p.url !== '/404.html');
  const count = (key) => { const m = new Map(); for (const p of main) if (p[key]) m.set(p[key], (m.get(p[key]) || 0) + 1); return m; };
  const titles = count('title');
  const descs = count('description');
  const out = main.map((p) => {
    const keyword = keywords[p.url] || '';
    const problems = [];
    if (keyword) {
      if (!hasPhrase(p.title, keyword)) problems.push('Search phrase not in the search title');
      if (!hasPhrase(p.description, keyword)) problems.push('Search phrase not in the description');
      if (!hasPhrase(p.h1, keyword)) problems.push('Search phrase not in the main heading');
    } else if (!skip.includes(p.url)) problems.push('No search phrase chosen');
    if (p.title.length > 65) problems.push(`Search title is long (${p.title.length} characters; Google shows about 60)`);
    if (p.title.length < 20) problems.push(`Search title is short (${p.title.length} characters)`);
    if (!p.description) problems.push('No description');
    else if (p.description.length > 160) problems.push(`Description is long (${p.description.length} characters; Google shows about 155)`);
    else if (p.description.length < 70) problems.push(`Description is short (${p.description.length} characters)`);
    if (p.title && titles.get(p.title) > 1) problems.push('Same search title as another page');
    if (p.description && descs.get(p.description) > 1) problems.push('Same description as another page');
    if (p.url !== '/' && !linkedFrom.get(p.url)) problems.push('No other page links to it');
    return { url: p.url, title: p.title, description: p.description, h1: p.h1, keyword, problems };
  }).sort((a, b) => a.url.localeCompare(b.url));
  return { at: now, pages: out, eventPages: infos.filter((p) => EVENT_PAGE.test(p.url)).length };
}

module.exports = { seoReport, hasPhrase, pageInfo };
