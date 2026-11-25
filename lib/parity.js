// lib/parity.js: are the two websites in step? (18 Nov 2026, Jon: "anything that checks that
// changes made on one site are mirrored on the other, apart from things unique to each").
// Offline, from the repo only. Each other site is compared with the Lenches:
//   bins       the same collection day, end date and dates (Harvington copies the Lenches'
//              Yellow round, without brown: no garden waste there)
//   terms      the same county school closures and holidays
//   cartoons   every cartoon from CARTOONS_FROM on in both sites' cartoons.json (same image,
//              alt and caption) with its JPEG in both sites' images/cartoons
//   data       a data file one site has and the other lacks must be on the KNOWN list
//   pages      likewise a page
//   wording    a shared page (src/_includes/pages/) set up with the same wording blocks
//              ({% set … %}) on both sites, bar the KNOWN differences
// Returns plain problem lines (empty = in step). Used by scripts/test-site-parity.js and the
// Daily diagnostic (scripts/diagnostic), so drift shows on Health and in the failed-runs check.
// When a difference is meant, add it to KNOWN below with the reason.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const ROOT = path.join(__dirname, '..');
const BASE = 'lenches';
const CARTOONS_FROM = '2026-11-19'; // Harvington's first issue (18 Nov, Jon: a cartoon in each)

// Meant differences, per other site.
const KNOWN = {
  harvington: {
    binsLeaveOut: ['brown'], // no brown garden-waste collection in Harvington or Norton (17 Nov)
    // _data files (without extension) only one site has.
    dataOnlyBase: ['moving', 'onthisday', 'sponsors', 'walks', 'wherelenches'],
    dataOnlyOther: [],
    // Pages (paths under sites/<site>/) only one site has. The Lenches' Home is index.njk,
    // Harvington's home.njk; Harvington's guidelines.md is shown on its Contact page.
    pagesOnlyBase: ['index.njk', 'archive.njk', 'community.njk', 'news-events.njk', 'news.njk',
      'living-here/moving.njk', 'living-here/walks.njk',
      'sponsor/index.njk', 'sponsor/terms.njk'],
    pagesOnlyOther: ['home.njk', 'guidelines.md'],
    // Wording blocks of a shared page only one site sets ("<include>:<name>").
    wordingOnlyBase: [
      'events:lenchesBadge', // the Lenches badge is the Lenches' alone
    ],
    wordingOnlyOther: ['notices:localPlaces'], // Harvington labels its own three places
  },
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const dataFile = (root, site, name) => path.join(root, 'sites', site, '_data', name);
const SITE_NAMES = { lenches: 'the Lenches', harvington: 'Harvington' };
const nameOf = (s) => SITE_NAMES[s] || s;
const poss = (s) => (/s$/.test(nameOf(s)) ? `${nameOf(s)}'` : `${nameOf(s)}'s`);

function checkBins(root, other, known, out) {
  const a = readJson(dataFile(root, BASE, 'bins.json'));
  const b = readJson(dataFile(root, other, 'bins.json'));
  for (const k of ['collectionDay', 'validTo']) {
    if (String(a[k] || '') !== String(b[k] || '')) out.push(`Bins: ${k} is "${a[k] || ''}" for ${nameOf(BASE)} but "${b[k] || ''}" for ${nameOf(other)}`);
  }
  const drop = new Set(known.binsLeaveOut || []);
  const norm = (bins) => (bins || []).filter((x) => !drop.has(x)).slice().sort().join('+');
  const theirs = new Map((b.collections || []).map((c) => [c.date, norm(c.bins)]));
  const first = [...theirs.keys()].sort()[0];
  if (!first) { out.push(`Bins: ${nameOf(other)} has no collection dates`); return; }
  const ours = new Map((a.collections || []).filter((c) => c.date >= first).map((c) => [c.date, norm(c.bins)]));
  for (const [d, v] of ours) {
    if (!theirs.has(d)) out.push(`Bins: ${d} is in ${poss(BASE)} dates but not ${poss(other)}`);
    else if (theirs.get(d) !== v) out.push(`Bins: ${d} is ${v} for ${nameOf(BASE)} but ${theirs.get(d)} for ${nameOf(other)}`);
  }
  for (const d of theirs.keys()) if (!ours.has(d)) out.push(`Bins: ${d} is in ${poss(other)} dates but not ${poss(BASE)}`);
}

function checkTerms(root, other, out) {
  const a = readJson(dataFile(root, BASE, 'schools.json')).terms || {};
  const b = readJson(dataFile(root, other, 'schools.json')).terms || {};
  for (const k of ['closures', 'breaks']) {
    if (!isDeepStrictEqual(a[k] || [], b[k] || [])) out.push(`School terms: the ${k} differ between ${nameOf(BASE)} and ${nameOf(other)} (schools.json terms.${k})`);
  }
}

function checkCartoons(root, other, out) {
  const entries = (site) => {
    const f = dataFile(root, site, 'cartoons.json');
    return fs.existsSync(f) ? (readJson(f).entries || {}) : {};
  };
  const a = entries(BASE);
  const b = entries(other);
  const dates = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((d) => d >= CARTOONS_FROM).sort();
  for (const d of dates) {
    if (!a[d] || !b[d]) { out.push(`Cartoon ${d}: in ${poss(a[d] ? BASE : other)} cartoons.json but not ${poss(a[d] ? other : BASE)}`); continue; }
    for (const k of ['image', 'alt', 'caption']) {
      if (String(a[d][k] || '') !== String(b[d][k] || '')) out.push(`Cartoon ${d}: ${k} differs between the two sites`);
    }
    for (const [site, e] of [[BASE, a[d]], [other, b[d]]]) {
      const img = String(e.image || '').replace(/^\/+/, '');
      if (img && !fs.existsSync(path.join(root, 'sites', site, img))) out.push(`Cartoon ${d}: ${img} is missing from sites/${site}/`);
    }
  }
}

const stem = (f) => f.replace(/\.[^.]+$/, '');

function checkData(root, other, known, out) {
  const list = (site) => new Set(fs.readdirSync(path.join(root, 'sites', site, '_data')).filter((f) => !f.startsWith('.')).map(stem));
  const a = list(BASE);
  const b = list(other);
  for (const n of a) if (!b.has(n) && !(known.dataOnlyBase || []).includes(n)) out.push(`Data: ${nameOf(BASE)} has _data/${n} but ${nameOf(other)} has none (add it there, or list it in lib/parity.js KNOWN)`);
  for (const n of b) if (!a.has(n) && !(known.dataOnlyOther || []).includes(n)) out.push(`Data: ${nameOf(other)} has _data/${n} but ${nameOf(BASE)} has none (add it there, or list it in lib/parity.js KNOWN)`);
}

function pageFiles(root, site) {
  const dir = path.join(root, 'sites', site);
  const found = [];
  const walk = (rel) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!['_data', 'images', 'items'].includes(ent.name)) walk(r); } else if (/\.(njk|md|11ty\.js)$/.test(ent.name)) found.push(r);
    }
  };
  walk('');
  return found;
}

function checkPages(root, other, known, out) {
  const a = new Set(pageFiles(root, BASE));
  const b = new Set(pageFiles(root, other));
  for (const p of a) if (!b.has(p) && !(known.pagesOnlyBase || []).includes(p)) out.push(`Pages: ${nameOf(BASE)} has ${p} but ${nameOf(other)} has none (add it there, or list it in lib/parity.js KNOWN)`);
  for (const p of b) if (!a.has(p) && !(known.pagesOnlyOther || []).includes(p)) out.push(`Pages: ${nameOf(other)} has ${p} but ${nameOf(BASE)} has none (add it there, or list it in lib/parity.js KNOWN)`);
}

// The shared include a page uses and the wording blocks it sets.
function wordingOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const inc = src.match(/\{%-?\s*include\s+["']pages\/([a-z-]+)\.njk["']/);
  if (!inc) return null;
  const names = new Set([...src.matchAll(/\{%-?\s*set\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  return { include: inc[1], names };
}

function checkWording(root, other, known, out) {
  const a = pageFiles(root, BASE);
  const b = new Set(pageFiles(root, other));
  for (const p of a) {
    if (!b.has(p)) continue;
    const wa = wordingOf(path.join(root, 'sites', BASE, p));
    const wb = wordingOf(path.join(root, 'sites', other, p));
    if (!wa && !wb) continue;
    if (!wa || !wb || wa.include !== wb.include) { out.push(`Wording: ${p} uses a different shared page on the two sites`); continue; }
    for (const n of wa.names) if (!wb.names.has(n) && !(known.wordingOnlyBase || []).includes(`${wa.include}:${n}`)) out.push(`Wording: ${p} sets ${n} for ${nameOf(BASE)} but not for ${nameOf(other)}`);
    for (const n of wb.names) if (!wa.names.has(n) && !(known.wordingOnlyOther || []).includes(`${wa.include}:${n}`)) out.push(`Wording: ${p} sets ${n} for ${nameOf(other)} but not for ${nameOf(BASE)}`);
  }
}

function parityProblems({ root = ROOT, known = KNOWN } = {}) {
  const out = [];
  for (const other of Object.keys(known)) {
    const k = known[other];
    for (const [name, fn] of [['Bins', () => checkBins(root, other, k, out)], ['School terms', () => checkTerms(root, other, out)],
      ['Cartoons', () => checkCartoons(root, other, out)], ['Data', () => checkData(root, other, k, out)],
      ['Pages', () => checkPages(root, other, k, out)], ['Wording', () => checkWording(root, other, k, out)]]) {
      try { fn(); } catch (e) { out.push(`${name}: could not compare (${e.message})`); }
    }
  }
  return out;
}

module.exports = { parityProblems, KNOWN, CARTOONS_FROM, wordingOf, pageFiles };

if (require.main === module) {
  const p = parityProblems();
  console.log(p.length ? p.join('\n') : 'The two sites are in step.');
  process.exitCode = p.length ? 1 : 0;
}
