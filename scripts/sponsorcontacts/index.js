// scripts/sponsorcontacts/index.js
// Sponsor prospect address finder (15 Nov 2026, Jon): fills the Sponsors tab's blank `email`
// cells from each firm's own website, using the listing finder (scripts/listingcontacts
// findEmail: home page plus up to three contact pages, same-domain address first). A row with
// no `website` gets one only if a guessed address (its name as a .co.uk/.com/.uk domain) loads
// a page that names both the firm and its town; that row's notes then say the website was
// guessed. It never overwrites a cell with a value and sends nothing. Run by
// sponsor-emails.yml (manual). Logs print row numbers and counts only, never an address.
'use strict';

const g = require('../ingest/google');
const { findEmail, fetchText } = require('../listingcontacts');

const TAB = 'Sponsors';
const GUESSED = 'Website guessed by the finder: check it is the right firm';
const str = (v) => String(v ?? '').trim();
const TYPE_WORDS = /\b(ltd|limited|llp|plc|and co|& co|co|estate agents?|solicitors?|accountants?|accountancy|architects?|associates|partners|financial advice|asset management|consultants?|property|wealth)\b/g;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const withUrl = (w) => (/^https?:\/\//i.test(w) ? w : `https://www.${w.replace(/^www\./i, '')}`);

// Candidate websites for a firm's name, most likely first (at most 8).
function guesses(name) {
  const n = str(name).toLowerCase().replace(/^qualitysolicitors\s+/, '');
  const bases = [];
  const add = (b) => { b = slug(b); if (b.length >= 4 && !bases.includes(b)) bases.push(b); };
  add(n.replace(/&/g, 'and'));
  add(n.replace(/&/g, ' '));
  const core = n.replace(/&/g, ' ').replace(TYPE_WORDS, ' ').replace(/\s+/g, ' ').trim();
  add(core);
  const out = [];
  for (const b of bases) for (const tld of ['co.uk', 'com']) out.push(`https://www.${b}.${tld}`);
  return out.slice(0, 8);
}

// Does this page look like this firm in this town? Its name's opening words (at least 8
// letters, "&" ignored) and one of its towns must both be written on the page.
function looksLike(html, name, town) {
  const letters = String(html || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/&amp;/g, ' ').replace(/[^a-z]/g, '');
  let key = '';
  for (const w of str(name).toLowerCase().replace(/^qualitysolicitors\s+/, '').split(/[^a-z]+/)) {
    key += w;
    if (key.length >= 8) break;
  }
  const towns = str(town).toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 4);
  return key.length >= 4 && letters.includes(key) && towns.some((t) => letters.includes(t));
}

async function guessSite(name, town, deps) {
  for (const u of guesses(name)) {
    const html = await fetchText(u, deps);
    if (html && looksLike(html, name, town)) return u;
  }
  return '';
}

async function run(deps = { g, fetch }) {
  const rows = await deps.g.readTable(TAB);
  let looked = 0; let found = 0; let sites = 0;
  for (const r of rows) {
    if (!str(r.name) || str(r.email)) continue;
    if (require('../../lib/neverlist').blocked({ name: r.name })) continue; // never-list (Jon, 25 Nov 2026)
    looked += 1;
    let website = str(r.website) ? withUrl(str(r.website)) : '';
    let guessed = false;
    if (!website) {
      website = await guessSite(str(r.name), str(r.town), deps);
      guessed = !!website;
      if (!website) { console.log(`Row ${r._row}: no website found.`); continue; }
      sites += 1;
    }
    const email = await findEmail(website, deps);
    const fields = {};
    if (email) fields.email = email;
    if (guessed) {
      fields.website = website.replace(/^https:\/\/www\./, '');
      fields.notes = str(r.notes) ? `${str(r.notes)}; ${GUESSED}` : GUESSED;
    }
    if (Object.keys(fields).length) await deps.g.updateRow(TAB, r._row, fields);
    if (email) found += 1;
    console.log(`Row ${r._row}: ${email ? 'address found' : 'no address found'}${guessed ? ' (website guessed)' : ''}.`);
  }
  console.log(`Sponsor prospects: looked for ${looked}, websites guessed ${sites}, addresses found ${found}.`);
  return { looked, found, sites };
}

if (require.main === module) run().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });

module.exports = { run, guesses, looksLike };
