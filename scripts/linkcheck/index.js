// scripts/linkcheck/index.js
// Inbound links (SEO step 5, 26 Nov 2026, Jon): the panel's SEO → Inbound links list is the
// site's "Link partners" tab (made by this script from lib/linkpartners.json when it is new).
// Each run reads every partner's website (its home page, then up to MAX_PAGES pages it links to
// that look like links, community or what's-on pages) and records whether, and where, it links
// to this site: columns link_found_at, last_checked and check. Status (Jon's column) moves only
// two ways: to "Linking" when a link is found (unless Jon set Declined or Not now), and from
// "Linking" to "Link gone" when a readable site no longer shows one. Nothing else is written,
// and nothing is sent. Run by link-check.yml (Mondays, and by hand). Logs print counts and
// partner ids only.
'use strict';

const fs = require('fs');
const path = require('path');

const TAB = 'Link partners';
const HEADERS = ['id', 'name', 'type', 'url', 'status', 'link_found_at', 'last_checked', 'check', 'notes', 'email', 'asked_at', 'listed_page', 'listed_url'];
const STATUSES = ['To ask', 'Asked', 'Linking', 'Link gone', 'Declined', 'Not now'];
const MAX_PAGES = 6;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (compatible; LenchesLinkCheck/1.0; +https://thelenches.org.uk/contact/)';
const LIKELY = /link|useful|communit|local|village|partner|resource|director|what.?s.?on|event|club|group|news|about|contact/i;

const str = (v) => String(v ?? '').trim();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// Does this page link to one of our domains? Returns true for an <a href> to it (any page).
function linksToUs(html, domains) {
  const re = /<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const h = hostOf(m[1].replace(/&amp;/g, '&'));
    if (h && domains.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  }
  return false;
}

// Same-site pages worth a look, from a page's links (at most MAX_PAGES, in page order).
function candidatePages(html, base) {
  const out = [];
  const host = hostOf(base);
  const re = /<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>#]+)[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < MAX_PAGES) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.href) !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|docx?|xlsx?|zip|mp[34])$/i.test(u.pathname)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (!LIKELY.test(u.pathname) && !LIKELY.test(text)) continue;
    u.hash = '';
    if (u.href.replace(/\/$/, '') === base.replace(/\/$/, '') || out.includes(u.href)) continue;
    out.push(u.href);
  }
  return out;
}

async function fetchText(url, deps) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return null;
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || 'text/html');
    if (!/html|text/i.test(type)) return null;
    return (await res.text()).slice(0, 2e6);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// One partner's website -> { result: 'linking' | 'none' | 'unreadable' | 'no-url' | 'facebook', at }
async function checkSite(url, domains, deps = { fetch }) {
  url = str(url);
  if (!/^https?:\/\//i.test(url)) return { result: 'no-url', at: '' };
  if (/facebook\.com|instagram\.com/i.test(url)) return { result: 'facebook', at: '' };
  const home = await fetchText(url, deps);
  if (home === null) return { result: 'unreadable', at: '' };
  if (linksToUs(home, domains)) return { result: 'linking', at: url };
  for (const p of candidatePages(home, url)) {
    const html = await fetchText(p, deps);
    if (html && linksToUs(html, domains)) return { result: 'linking', at: p };
  }
  return { result: 'none', at: '' };
}

const CHECK_WORDS = {
  linking: 'Links to us',
  none: 'No link found',
  unreadable: 'Website could not be read',
  'no-url': 'No website address yet',
  facebook: 'Facebook: check by hand',
};

// Jon's status after a check (only three automatic moves; requestSent: the day Holly's link
// request went, from Replies).
function nextStatus(status, result, requestSent = '') {
  const s = str(status) || 'To ask';
  if (result !== 'linking' && requestSent && s === 'To ask') return 'Asked';
  if (result === 'linking' && ['To ask', 'Asked', 'Link gone'].includes(s)) return 'Linking';
  if (result === 'none' && s === 'Linking') return 'Link gone';
  return str(status) || 'To ask';
}

// The cells to write for one row (only those that change), or null.
function rowUpdate(row, check, today, { requestSent = '', seed = null } = {}) {
  const status = nextStatus(row.status, check.result, requestSent);
  const want = {
    status,
    link_found_at: check.result === 'linking' ? check.at : (check.result === 'none' ? '' : str(row.link_found_at)),
    last_checked: today,
    check: CHECK_WORDS[check.result] || check.result,
  };
  if (status === 'Asked' && str(row.status) !== 'Asked' && !str(row.asked_at)) want.asked_at = requestSent;
  // Where we list them (for the request's "listed on our … page" line): from the starting list,
  // only into blank cells.
  for (const k of ['listed_page', 'listed_url']) if (seed && seed[k] && !str(row[k])) want[k] = seed[k];
  const out = {};
  for (const [k, v] of Object.entries(want)) if (str(row[k]) !== v) out[k] = v;
  return Object.keys(out).length ? out : null;
}

// Email finder (27 Nov 2026, Jon): a partner still to ask (or whose link has gone) with no email
// and a website that isn't Facebook gets the best public address on its own site (the listing
// finder: home page plus contact pages, same-domain address first), written only into a blank
// email cell, with FOUND_NOTE added to its notes. A partner whose notes already carry that note
// is never looked up again, so an address Jon clears stays cleared.
const FOUND_NOTE = 'Email found on their website by the weekly check: check it before asking';
function wantsEmail(row) {
  const st = str(row.status) || 'To ask';
  return ['To ask', 'Link gone'].includes(st) && !str(row.email) && /^https?:\/\//i.test(str(row.url))
    && !/facebook\.com|instagram\.com/i.test(str(row.url)) && !str(row.notes).includes(FOUND_NOTE);
}
async function emailUpdate(row, deps) {
  if (!wantsEmail(row)) return null;
  const email = await deps.findEmail(str(row.url), deps);
  if (!email) return null;
  return { email, notes: str(row.notes) ? `${str(row.notes)}; ${FOUND_NOTE}` : FOUND_NOTE };
}

function seedRows(site) {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'linkpartners.json'), 'utf8'));
  return (file[site] || []).map((p) => ({ id: p.id, name: p.name, type: p.type || '', url: p.url || '', status: 'To ask', notes: p.notes || '', listed_page: p.listed_page || '', listed_url: p.listed_url || '' }));
}

async function main() {
  const g = require('../ingest/google');
  const { SITE, siteConfig } = require('../../lib/site');
  const cfg = siteConfig();
  const domains = [str(cfg.domain || hostOf(cfg.url)).replace(/^www\./, '').toLowerCase()].filter(Boolean);
  if (!domains.length) throw new Error('No domain in site.json');
  const made = await g.ensureTab(TAB, HEADERS);
  if (made) {
    const seed = seedRows(SITE);
    await g.appendRows(TAB, seed);
    console.log(`Made the ${TAB} tab with ${seed.length} partners from lib/linkpartners.json.`);
  }
  for (const h of HEADERS) await g.ensureColumn(TAB, h);
  const rows = await g.readTable(TAB);
  const R = await import(require('url').pathToFileURL(path.join(__dirname, '..', '..', 'worker', 'src', 'admin', 'links.mjs')).href);
  // This Sheet's Replies plus the other sites' (read-only): one request can cover both sites.
  const { otherSites } = require('../../lib/site');
  const others = await Promise.all(otherSites().map((s) => g.readOtherTable(s, 'Replies').catch(() => [])));
  const replyRows = R.bothReplies(await g.readTable('Replies'), others);
  const seeds = Object.fromEntries(seedRows(SITE).map((p) => [p.id, p]));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const counts = {};
  let changed = 0;
  let emails = 0;
  const { findEmail } = require('../listingcontacts');
  for (const row of rows) {
    if (!str(row.id) && !str(row.name)) continue;
    const check = await checkSite(row.url, domains);
    counts[check.result] = (counts[check.result] || 0) + 1;
    let upd = rowUpdate(row, check, today, { requestSent: R.requestsFor(str(row.id), replyRows, SITE).requestSent, seed: seeds[str(row.id)] });
    const found = await emailUpdate(row, { fetch, findEmail }).catch(() => null);
    if (found) { upd = { ...(upd || {}), ...found }; emails += 1; }
    if (upd) { await g.updateRow(TAB, row._row, upd); changed += 1; }
    if (upd && upd.status && upd.status !== str(row.status)) console.log(`${str(row.id) || `row ${row._row}`}: ${str(row.status) || 'To ask'} -> ${upd.status}`);
  }
  console.log(`Checked ${rows.length} partners for links to ${domains.join(', ')}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}; ${changed} rows updated; ${emails} email addresses found.`);
}

module.exports = { TAB, HEADERS, STATUSES, linksToUs, candidatePages, checkSite, nextStatus, rowUpdate, seedRows, CHECK_WORDS, FOUND_NOTE, wantsEmail, emailUpdate };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
