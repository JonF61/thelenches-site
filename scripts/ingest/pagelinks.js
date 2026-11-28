'use strict';
// scripts/ingest/pagelinks.js
// The links on a feed item's own source page (a council news article), so extraction can pick a
// second link the text names but the feed leaves out (e.g. "report it to West Mercia Police
// online"). One fetch per item, best effort: any failure gives an empty list. Only the links are
// read (anchor text + address); the page's wording is never used. Never called for local-news
// feeds (rss.js), whose articles we don't fetch.

const USER_AGENT = 'TheLenchesBot/1.0 (+https://thelenches.org.uk)';
const { webFetch } = require('../../lib/webfetch');
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 1500000;
const MAX_LINKS = 80;

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

// The article body if the page marks one (<article> or <main>), else the whole page.
function mainPart(html) {
  for (const tag of ['article', 'main']) {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m && m[1].length > 200) return m[1];
  }
  return html;
}

// [{ text, url }] from HTML: absolute http(s) and mailto links only, de-duplicated, in page order.
function linksFromHtml(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const part = mainPart(String(html || ''));
  while ((m = re.exec(part)) && out.length < MAX_LINKS) {
    let url = decode(m[1] != null ? m[1] : m[2]).trim();
    if (!url || url.startsWith('#') || /^javascript:/i.test(url)) continue;
    if (!/^mailto:/i.test(url)) {
      try { url = new URL(url, pageUrl).href; } catch { continue; }
      if (!/^https?:\/\//i.test(url)) continue;
    }
    if (url === pageUrl || seen.has(url)) continue;
    seen.add(url);
    const text = decode(m[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({ text, url });
  }
  return out;
}

// PDF addresses anywhere in the page's main part (links, embeds, viewer iframes), same order,
// de-duplicated: a council's newsletter is often an embedded PDF rather than a link (25 Nov).
function pdfsFromHtml(html, pageUrl) {
  const out = [];
  let part = decode(mainPart(String(html || '')));
  try { part = decodeURIComponent(part); } catch { part = part.replace(/%2F/gi, '/').replace(/%3A/gi, ':'); }
  const re = /(?:https?:\/\/|\/)[^\s"'<>()?=&]+?\.pdf\b/gi;
  let m;
  while ((m = re.exec(part)) && out.length < 5) {
    let url;
    try { url = new URL(m[0], pageUrl).href; } catch { continue; }
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

// { links, pdfs } from the item's page; one fetch, best effort (empty on any failure).
async function pageInfo(url) {
  try {
    const res = await webFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { links: [], pdfs: [], problem: `page answered HTTP ${res.status}` };
    if (!/html/i.test(res.headers.get('content-type') || '')) return { links: [], pdfs: [], problem: 'page is not HTML' };
    const html = (await res.text()).slice(0, MAX_BYTES);
    const pdfs = pdfsFromHtml(html, res.url || url);
    const challenge = /<title>\s*Just a moment/i.test(html);
    return {
      links: linksFromHtml(html, res.url || url),
      pdfs,
      problem: pdfs.length ? '' : challenge ? 'page is a firewall check (blocked)' : `no PDF address in the page (${html.length} characters read)`,
    };
  } catch (err) {
    return { links: [], pdfs: [], problem: `page could not be fetched: ${(err && err.message) || err}` };
  }
}

async function pageLinks(url) {
  return (await pageInfo(url)).links;
}

module.exports = { pageLinks, pageInfo, linksFromHtml, pdfsFromHtml, USER_AGENT };
