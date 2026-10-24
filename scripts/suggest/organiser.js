// scripts/suggest/organiser.js
// Organiser's site: where its address can come from, and its share image.
// Addresses, in order: the item's link (link_url, Claude's pick from the email), other
// links in the email (Pending "links", saved by ingest), then the sender's own domain's
// home page (never for webmail, Facebook or our own domain). The first page that gives an
// image wins: og:image, else twitter:image, else a clear logo. Fetches go through web.js
// (robots.txt, 10 s, 5 MB, JPEG/PNG/WebP only). Never a general web image search.
'use strict';

const { fetchPage, fetchImage, pageImages, fetchable, hostOf } = require('./web');
const { STOCK_HOSTS } = require('../eventimages/find');

const MAX_PAGES = 3;
const MIN_LONG = 400;      // share images smaller than this on the long side are skipped
const MIN_LOGO = 120;
const MAX_RATIO = 3.2;
const WEBMAIL = /(^|\.)(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|aol|icloud|me|mac|btinternet|btopenworld|sky|talktalk|tiscali|virginmedia|blueyonder|ntlworld|plus|protonmail|proton|gmx|mail|zoho|fastmail|facebookmail|thelenches)\.[a-z.]+$/i;
const NOT_ORGANISER = /(^|\.)(google\.[a-z.]+|goo\.gl|bit\.ly|tinyurl\.com|list-manage\.com|mailchimp\.com|eventbrite\.[a-z.]+|ticketsource\.[a-z.]+|wa\.me|whatsapp\.com|youtube\.com|youtu\.be|linkedin\.com|zoom\.us|gov\.uk)$/i;

// Web links in email text, cleaned: at most max, no duplicates.
function extractLinks(text, max = 5) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>()"'\]]+/gi)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!fetchable(u) || /\.(pdf|docx?|jpe?g|png|gif)(\?|#|$)/i.test(u) || /unsubscribe/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function senderHome(from) {
  const m = String(from || '').match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!m) return '';
  const domain = m[1].toLowerCase();
  return WEBMAIL.test(domain) ? '' : `https://${domain}/`;
}

// Candidate organiser pages for a Pending row, best first.
function organiserUrls(row) {
  const out = [];
  const push = (u) => {
    const v = String(u || '').trim();
    if (!/^https?:\/\//i.test(v) || /\.pdf(\?|#|$)/i.test(v) || !fetchable(v) || NOT_ORGANISER.test(hostOf(v))) return;
    if (!out.includes(v)) out.push(v);
  };
  push(row.link_url);
  String(row.links || '').split(/\s+/).forEach(push);
  push(senderHome(row.from));
  return out.slice(0, MAX_PAGES);
}

async function tryImage(url, kind) {
  if (!url || STOCK_HOSTS.test(url)) return null;
  try {
    const img = await fetchImage(url);
    const long = Math.max(img.width, img.height);
    const short = Math.min(img.width, img.height) || 1;
    if (long < (kind === 'logo' ? MIN_LOGO : MIN_LONG) || long / short > MAX_RATIO) return null;
    return img;
  } catch {
    return null;
  }
}

// { url, via, page, image, info } for the first page that gives an image, or { tried }.
async function organiserImage(row) {
  const tried = [];
  for (const pageUrl of organiserUrls(row)) {
    let page;
    try { page = await fetchPage(pageUrl); } catch (err) { tried.push(`${hostOf(pageUrl)}: ${err.message}`); continue; }
    const info = pageImages(page.html, page.finalUrl);
    for (const [via, url] of [['og:image', info.og], ['twitter:image', info.twitter], ['logo', info.logo]]) {
      const image = await tryImage(url, via === 'logo' ? 'logo' : 'photo');
      if (image) return { url, via, page: page.finalUrl, image, info };
    }
    tried.push(`${hostOf(pageUrl)}: no usable image`);
  }
  return { tried };
}

module.exports = { organiserUrls, organiserImage, extractLinks, senderHome };
