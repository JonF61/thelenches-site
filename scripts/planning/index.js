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

// 27 Nov 2026 (Jon): Wychavon's firewall (Sucuri) now answers Node's fetch with HTTP 307 even from
// the cloud session, while curl reads the page normally, so the list page and its PDFs are read
// with curl (installed on GitHub's runners and in cloud sessions). Standing rule: if a site we read
// refuses Node's fetch but curl reads it normally, switch that fetch to curl (CLAUDE.md).
function curlGet(url) {
  try {
    return execFileSync('curl', ['-sS', '-f', '-L', '--max-time', '60', '-A', UA, url],
      { maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    const m = /error: (\d{3})/.exec(String(e.stderr || ''));
    throw new Error(m ? `HTTP ${m[1]} for ${url}` : `curl failed for ${url}`);
  }
}

async function fetchText(url) {
  return curlGet(url).toString('utf8');
}

async function fetchPdfText(url) {
  const buf = curlGet(url);
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
  let html;
  try {
    html = await getText(P.LIST_PAGE);
  } catch (e) {
    // 25 Nov 2026: Wychavon's firewall (Sucuri) answers GitHub's runners with HTTP 307. Not a
    // failed run: the Daily diagnostic reports it from the file's check.
    problems.push(`Wychavon's weekly list page could not be read (${String(e.message || e).replace(/ for https?:\S+/, '').slice(0, 60)})`);
    return { lists: [], problems };
  }
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
      ...(data.open ? { open: data.open } : {}),
    };
    write(site, out);
    changed.push(site);
  }
  return { changed, counts };
}

// ---- Awaiting a decision (25 Nov 2026, Jon). Kept in planning.json "open" (never cut by the
// 8-week limit): each site's applications from the weekly lists, plus (SEED_OPEN=true, a one-off
// back-fill) every application Wychavon's planning search lists as undecided for its parishes. Each
// run re-reads every open application's own page (lib/planning.js parseDisplay) for its stage and
// drops it once decided or withdrawn. Wychavon's planning site isn't behind the weekly list page's
// firewall; one request at a time, half a second apart.
const PLAN = 'https://plan.wychavon.gov.uk';
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function getPage(url, { jar, method = 'GET', body } = {}) {
  const headers = { 'user-agent': UA, ...(jar && jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method, body, headers, redirect: 'manual' });
  if (jar && typeof res.headers.getSetCookie === 'function') {
    for (const c of res.headers.getSetCookie()) { const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); }
  }
  if ([301, 302, 303].includes(res.status) && res.headers.get('location')) return getPage(new URL(res.headers.get('location'), url).href, { jar });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Every undecided planning application for one parish (by Wychavon's exact name): [ref].
async function searchOpen(parish, get = getPage) {
  const jar = new Map();
  const form = await get(`${PLAN}/Search/Advanced`, { jar });
  const token = (/name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(form) || [])[1];
  const select = (/<select[^>]*name="Parish"[\s\S]*?<\/select>/.exec(form) || [''])[0];
  const opt = [...select.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)]
    .find((m) => P.pageText(m[2]).join(' ').trim().toLowerCase() === parish.toLowerCase());
  if (!token || !opt) throw new Error(`parish "${parish}" not found on Wychavon's search form`);
  const body = new URLSearchParams([['__RequestVerificationToken', token], ['AdvancedSearch', 'True'], ['SearchPlanning', 'true'],
    ['SearchPlanning', 'false'], ['SearchEnforcement', 'false'], ['SearchTreePreservationOrders', 'false'], ['Parish', opt[1]],
    ['ExcludeDecidedApps', 'true'], ['ExcludeDecidedApps', 'false']]).toString();
  const refs = new Set();
  let html = await get(`${PLAN}/Search/SiteResults`, { jar, method: 'POST', body });
  for (let page = 2; page < 30; page += 1) {
    for (const m of html.matchAll(/Planning\/Display\/(W\/\d{2}\/\d{5}\/[A-Z0-9]+)/g)) refs.add(m[1]);
    if (!new RegExp(`ResultsPage/${page}\\?module=PLA`).test(html)) break;
    await pause(500);
    html = await get(`${PLAN}/Search/ResultsPage/${page}?module=PLA`, { jar });
  }
  return [...refs];
}

// Decided applications stay on the page, marked with their outcome, for 4 weeks after the decision
// (Jon, 25 Nov 2026), then drop off.
const KEEP_DECIDED_DAYS = 28;

// Refreshes data.open for one site. Returns { open, problems, dropped, added }.
async function refreshOpen(data, { parishes, seed = [], getDisplay, wait = 500, today = new Date().toISOString().slice(0, 10), keepDays = KEEP_DECIDED_DAYS }) {
  const listDecided = new Set();
  const fromLists = [];
  for (const w of (data && data.weeks) || []) {
    for (const e of w.decisions || []) listDecided.add(e.ref);
    for (const e of w.applications || []) fromLists.push(e);
  }
  const byRef = new Map(((data && data.open) || []).map((e) => [e.ref, e]));
  let added = 0;
  for (const e of fromLists) {
    if (byRef.has(e.ref) || listDecided.has(e.ref) || P.isTreeWork(e.ref, e.type)) continue;
    byRef.set(e.ref, { ref: e.ref, location: e.location, proposal: e.proposal, type: e.type, parish: e.parish, link: e.link, valid: e.date });
    added += 1;
  }
  for (const ref of seed) {
    if (byRef.has(ref) || P.isTreeWork(ref, '')) continue;
    byRef.set(ref, { ref, link: P.DISPLAY + ref });
    added += 1;
  }
  const want = new Set((parishes || []).map((p) => p.toLowerCase()));
  const open = [];
  const problems = [];
  let dropped = 0;
  let first = true;
  for (const e of byRef.values()) {
    if (!first && wait) await pause(wait);
    first = false;
    let d = null;
    try { d = P.parseDisplay(await getDisplay(e.link || P.DISPLAY + e.ref)); } catch (err) { d = null; }
    if (!d) { problems.push(`${e.ref}: its page could not be read`); if (e.location) open.push(e); continue; }
    const decided = !P.isOpen(d);
    if (decided && !(d.decisionDate && d.decisionDate >= P.addDays(today, -keepDays))) { dropped += 1; continue; }
    const parish = d.parish || e.parish || '';
    if (parish && want.size && !parish.split(/\s*,\s*/).some((x) => want.has(x.toLowerCase()))) { dropped += 1; continue; }
    const proposal = d.proposal || e.proposal || '';
    const homes = P.homesIn(proposal, e.ref);
    open.push({
      ref: e.ref, location: d.location || e.location || '', proposal, type: d.type || e.type || '', parish,
      link: P.DISPLAY + e.ref, valid: d.valid || e.valid || '',
      ...(d.consultationEnd ? { consultationEnd: d.consultationEnd } : {}),
      ...(d.committee ? { committee: d.committee } : {}),
      ...(d.appealStarted ? { appealStarted: d.appealStarted } : {}),
      ...(homes ? { homes, homesLabel: P.homesLabel(proposal, homes) } : {}),
      ...(decided ? { decision: d.decision || d.status, decisionDate: d.decisionDate } : {}),
    });
  }
  if (problems.length > 3) problems.splice(3, problems.length - 3, `and ${problems.length - 3} more`);
  return { open: P.sortOpen(open), problems, dropped, added };
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
  if (process.env.OPEN !== 'false') {
    for (const site of SITES) {
      const parishes = siteConfigFor(site).planningParishes;
      if (!Array.isArray(parishes) || !parishes.length) continue;
      const data = readData(site) || { weeks: [] };
      let seed = [];
      if (process.env.SEED_OPEN === 'true') {
        for (const p of parishes) seed = seed.concat(await searchOpen(p));
        console.log(`${site}: ${seed.length} undecided applications on Wychavon's search`);
      }
      const r = await refreshOpen(data, { parishes, seed, getDisplay: (u) => getPage(u) });
      const before = JSON.stringify(data.open || []);
      if (before === JSON.stringify(r.open)) { console.log(`${site}: awaiting a decision unchanged (${r.open.length})`); continue; }
      data.open = r.open;
      fs.writeFileSync(fileFor(site), `${JSON.stringify(data, null, 2)}\n`);
      if (!res.changed.includes(site)) res.changed.push(site);
      console.log(`${site}: awaiting a decision ${r.open.length} (${r.added} added, ${r.dropped} decided or gone)${r.problems.length ? `; ${r.problems.join('; ')}` : ''}`);
    }
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${res.changed.join(' ')}\n`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = { readLists, apply, refreshOpen, searchOpen };
