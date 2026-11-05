// scripts/listingcontacts/index.js
// Listing address finder (5 Nov 2026, Jon): Holly's yearly listing check (Contacts >
// Organisations > Listings; worker/src/admin/orgoutreach.mjs listingEntries) needs an address
// for each Local trades and Where to eat entry, and most entries show only a phone number or a
// website. For each listing with no address yet (none in the entry, none in the Org outreach
// tab's `email` cell) and a website that isn't Facebook, this reads the home page and up to
// three contact pages (links whose address or words say "contact", then /contact and
// /contact-us), takes the addresses written there (mailto: links, plain text, Cloudflare's
// hidden addresses) and saves the best one (same domain as the website first) to the Org
// outreach tab: email, email_source "website". It never overwrites a cell that has a value,
// so a typed address or a cleared one stays. Run by listing-emails.yml (manual: all, or one
// id like trade-john / eat-boot-inn) and by listing-suggest.yml after a suggestion is
// approved (that one entry). Nothing is sent. Logs print ids and counts only, never an address.
'use strict';

const g = require('../ingest/google');
const { allEntries, orgRows, rules } = require('../outreach/orgs');

const UA = 'Mozilla/5.0 (compatible; LenchesWebsite/1.0; +https://thelenches.org.uk)';
const TIMEOUT_MS = 12000;
const MAX_PAGES = 4;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// Not a real contact address: image names, tracking and platform addresses, placeholders.
const JUNK_RE = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(\d|2x)|sentry|wixpress|example\.|domain\.com|yourdomain|godaddy|wordpress|squarespace|mysite|email\.com$|noreply|no-reply|donotreply|privacy@|gdpr@|abuse@|postmaster@|webmaster@/i;

const str = (v) => String(v ?? '').trim();
const low = (v) => str(v).toLowerCase();
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// Cloudflare's email protection: data-cfemail="hex" (first byte is the XOR key).
function cfDecode(hex) {
  const k = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return out;
}

const decodeEntities = (s) => s.replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&').replace(/&commat;|&#64;/g, '@');

// Every plausible address in one page's HTML, in the order found, lower case.
function addressesIn(html) {
  const text = decodeEntities(String(html || ''));
  const found = [];
  for (const m of text.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) found.push(cfDecode(m[1]));
  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) found.push(decodeURIComponent(m[1]));
  for (const m of text.matchAll(EMAIL_RE)) found.push(m[0]);
  const out = [];
  for (const e of found.map(low)) {
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) || JUNK_RE.test(e) || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

// Up to 2 same-site links that look like a contact page, as absolute URLs.
function contactLinks(html, base) {
  const host = hostOf(base);
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const words = m[2].replace(/<[^>]+>/g, ' ');
    if (!/contact|get in touch|find us|enquir/i.test(`${m[1]} ${words}`)) continue;
    let u;
    try { u = new URL(m[1], base).href; } catch { continue; }
    if (hostOf(u) !== host || out.includes(u) || /^mailto:|^tel:/i.test(m[1])) continue;
    out.push(u);
    if (out.length >= 2) break;
  }
  return out;
}

// The best address from a list for a website: same domain first, then info@/hello@/enquiries@,
// then the first found.
function pick(list, website) {
  if (!list.length) return '';
  const host = hostOf(website);
  const same = list.filter((e) => host && (e.endsWith(`@${host}`) || e.split('@')[1].endsWith(`.${host}`) || host.endsWith(e.split('@')[1])));
  const pool = same.length ? same : list;
  for (const p of ['info', 'hello', 'enquiries', 'enquiry', 'contact', 'office', 'bookings']) {
    const e = pool.find((x) => x.startsWith(`${p}@`));
    if (e) return e;
  }
  return pool[0];
}

async function fetchText(url, deps) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return '';
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || 'text/html');
    if (!/html|text/i.test(type)) return '';
    return (await res.text()).slice(0, 2e6);
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

// The address found on one website, or ''.
async function findEmail(website, deps = { fetch }) {
  if (!/^https?:\/\//i.test(str(website)) || /facebook\.com|instagram\.com/i.test(website)) return '';
  const home = await fetchText(website, deps);
  const all = addressesIn(home);
  const base = website.replace(/\/+$/, '');
  const pages = [...contactLinks(home, website), `${base}/contact`, `${base}/contact-us`];
  const seen = new Set([website]);
  for (const u of pages) {
    if (pick(all, website) && all.some((e) => e.endsWith(`@${hostOf(website)}`))) break;
    if (seen.has(u) || seen.size >= MAX_PAGES) continue;
    seen.add(u);
    for (const e of addressesIn(await fetchText(u, deps))) if (!all.includes(e)) all.push(e);
  }
  return pick(all, website);
}

// only: one listing id (trade-… / eat-…), or '' for all. Returns { looked, found, saved }.
async function run({ only = '' } = {}, deps = { g, fetch }) {
  const R = await rules();
  const entries = (await allEntries()).filter((e) => e.listing && (!only || e.id === only));
  if (only && !entries.length) { console.log(`No listing ${only}. Nothing to do.`); return { looked: 0, found: 0, saved: 0 }; }
  await deps.g.ensureTab(R.ORG_TAB, R.ORG_HEADERS);
  let headers = await deps.g.readHeaders(R.ORG_TAB);
  for (const h of ['email', 'email_source']) {
    if (!headers.includes(h)) {
      await deps.g.setHeader(R.ORG_TAB, headers.length, h);
      headers = [...headers, h];
    }
  }
  const tab = await orgRows(R);
  const byId = new Map(tab.map((r) => [str(r.id), r]));
  let looked = 0; let found = 0; let saved = 0;
  for (const e of entries) {
    const row = byId.get(e.id) || null;
    if (R.emailOf(e, row) || str(row && row.email) || str(row && row.email_source)) continue;
    if (!e.website || /facebook\.com/i.test(e.website)) { console.log(`${e.id}: no website to look on.`); continue; }
    looked += 1;
    const email = await findEmail(e.website, deps);
    if (!email) { console.log(`${e.id}: no address found.`); continue; }
    found += 1;
    if (row) await deps.g.updateRow(R.ORG_TAB, row._row, { email, email_source: 'website' });
    else await deps.g.appendRows(R.ORG_TAB, [{ id: e.id, email, email_source: 'website' }]);
    saved += 1;
    console.log(`${e.id}: address found and saved.`);
  }
  console.log(`Listing addresses: looked on ${looked} website(s), found ${found}, saved ${saved}.`);
  return { looked, found, saved };
}

if (require.main === module) {
  // LISTING_ID: one id, or blank/"all". A suggestion's state file gives kind + entry instead.
  let only = str(process.env.LISTING_ID);
  if (only === 'all') only = '';
  if (!only && process.env.SUGGEST_STATE) {
    try {
      const s = JSON.parse(require('fs').readFileSync(process.env.SUGGEST_STATE, 'utf8'));
      if (s.entry) only = `${s.kind === 'eat' ? 'eat' : 'trade'}-${s.entry}`;
    } catch { /* no state: nothing to do */ }
    if (!only) { console.log('No new entry. Nothing to do.'); process.exit(0); }
  }
  run({ only }).catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
}

module.exports = { run, findEmail, addressesIn, contactLinks, pick, cfDecode };
