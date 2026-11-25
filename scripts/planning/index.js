// Weekly planning feed (25 Nov 2026, Jon): reads Wychavon's planning weekly list page, takes the
// newest "Planning Applications", "Decisions Made" and "Planning Appeals" PDFs (links read from the
// page: their names and folders are inconsistent), turns each into text with pdftotext -layout,
// parses it (lib/planning.js) and adds each site's parishes' entries (site.json planningParishes)
// to sites/<site>/_data/planning.json, keeping 8 weeks. A list already stored is skipped, so a week
// with no new list writes nothing. No Claude calls; nothing personal is kept.
//
// The workflow (planning.yml) commits any change and starts both site builds. Problems (a link
// missing, a list without its week heading, a non-empty PDF the parser found no entries in) go in
// each planning.json "check", which the Daily diagnostic reports (checkPlanning).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../../lib/planning');
const { SITES, ROOT, siteConfigFor } = require('../../lib/site');

const UA = 'Mozilla/5.0 (compatible; community-website-planning-feed/1.0)';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchPdfText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for the PDF`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('Not a PDF');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-'));
  const file = path.join(dir, 'list.pdf');
  fs.writeFileSync(file, buf);
  try {
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const fileFor = (site) => path.join(ROOT, 'sites', site, '_data', 'planning.json');
const readData = (site) => {
  try { return JSON.parse(fs.readFileSync(fileFor(site), 'utf8')); } catch { return null; }
};

// Reads the newest list of each kind (backfill: every list on the page, for a first fill of the
// Planning page; the page keeps about 4 weeks): { lists: [{ kind, name, week, entries }], problems: [] }.
async function readLists({ getText = fetchText, getPdfText = fetchPdfText, backfill = false } = {}) {
  const problems = [];
  const html = await getText(P.LIST_PAGE);
  const newest = P.newestLinks(html, P.LIST_PAGE);
  const all = P.pdfLinks(html, P.LIST_PAGE);
  const lists = [];
  for (const kind of P.KINDS) {
    if (!newest[kind]) problems.push(`no ${kind} PDF link found on Wychavon's weekly list page`);
  }
  const todo = backfill ? all : P.KINDS.map((k) => newest[k]).filter(Boolean);
  for (const link of todo) {
    const { kind } = link;
    let text;
    try {
      text = await getPdfText(link.url);
    } catch (e) {
      problems.push(`${kind} list could not be read (${String(e.message || e).slice(0, 80)})`);
      continue;
    }
    const week = P.weekOf(text);
    if (!week) { problems.push(`${kind} list "${link.name}" has no week heading`); continue; }
    const entries = P.parseList(text, kind);
    const expected = P.entryCount(text);
    const parsed = P.rawEntries(text).filter((e) => /^W\/\d{2}\/\d{5}\//.test(String(e['Application Number'] || '').trim())).length;
    if (text.replace(/\s+/g, '').length > 300 && parsed === 0) {
      problems.push(`parser found no entries in the non-empty ${kind} list "${link.name}"`);
    } else if (parsed < expected) {
      problems.push(`parser read ${parsed} of ${expected} entries in the ${kind} list "${link.name}"`);
    }
    lists.push({ kind, name: link.name, week, entries });
  }
  return { lists, problems };
}

// Adds the lists to each site's data. Returns { changed: [site], counts }.
function apply({ lists, problems }, { sites = SITES, read = readData, write, today }) {
  const changed = [];
  const counts = {};
  for (const site of sites) {
    const parishes = siteConfigFor(site).planningParishes;
    if (!Array.isArray(parishes) || !parishes.length) continue;
    const before = read(site);
    let data = before ? JSON.parse(JSON.stringify(before)) : { weeks: [] };
    let added = false;
    for (const l of lists) {
      if (P.hasList(data, l.week, l.kind)) continue;
      const mine = P.forParishes(l.entries, parishes);
      data = P.addList(data, l.week, l.kind, mine);
      counts[`${site} ${l.kind}`] = (counts[`${site} ${l.kind}`] || 0) + mine.length;
      added = true;
    }
    const prevProblems = JSON.stringify((before && before.check && before.check.problems) || []);
    if (!added && prevProblems === JSON.stringify(problems)) continue;
    const out = {
      _help: 'Written by scripts/planning (planning.yml): Wychavon weekly planning lists for this site\'s parishes (site.json planningParishes), newest week first, 8 weeks. Reference, location, proposal, type, date, decision and link only; tree works left out. Don\'t edit by hand.',
      source: P.LIST_PAGE,
      check: { at: today, problems },
      weeks: data.weeks,
    };
    write(site, out);
    changed.push(site);
  }
  return { changed, counts };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const got = await readLists({ backfill: process.env.BACKFILL === 'true' });
  const res = apply(got, {
    today,
    write: (site, data) => fs.writeFileSync(fileFor(site), `${JSON.stringify(data, null, 2)}\n`),
  });
  for (const l of got.lists) console.log(`${l.kind}: week ${l.week.from} to ${l.week.to}, ${l.entries.length} entries (tree works left out)`);
  for (const [k, n] of Object.entries(res.counts)) console.log(`Added ${k}: ${n}`);
  for (const p of got.problems) console.log(`Problem: ${p}`);
  console.log(res.changed.length ? `Changed: ${res.changed.join(', ')}` : 'No new list: nothing written.');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${res.changed.join(' ')}\n`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = { readLists, apply };
