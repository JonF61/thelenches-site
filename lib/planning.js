// Planning feed (25 Nov 2026, Jon): Wychavon's weekly planning lists, parsed from their PDFs
// (pdftotext -layout), for each site's newsletter "Planning this week" section and its
// /living-here/planning/ page. No Claude calls. Shared by scripts/planning (the weekly run),
// scripts/newsletter/select.js (planningFor) and the Daily diagnostic (checkPlanning).
//
// Only reference, location, proposal, type, date, decision and link are kept: never applicant or
// agent names or addresses, or officer contacts (Jon, 25 Nov). Tree works (CAN, TPO) are left out.
'use strict';

const LIST_PAGE = 'https://www.wychavon.gov.uk/planning/other-planning-services/planning-weekly-list';
const DISPLAY = 'https://plan.wychavon.gov.uk/Planning/Display/';
const KINDS = ['applications', 'decisions', 'appeals'];
const KEEP_WEEKS = 8;
const PROPOSAL_MAX = 120;

// File names and folders on Wychavon's page are inconsistent (e.g. "Planning Appeals Received
// 09-13 November.pdf"), so links are read from the page and matched on the name's start only.
const KIND_OF = [
  [/^planning applications\b/i, 'applications'],
  [/^decisions made\b/i, 'decisions'],
  [/^planning appeals\b/i, 'appeals'],
];

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// The page's PDF links of the three kinds, in page order (newest first on the page), each
// { kind, name, url }. Enforcement appeals, tree works and NMA lists are ignored.
function pdfLinks(html, base = LIST_PAGE) {
  const out = [];
  const re = /href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const href = decode(m[1]);
    let url;
    try { url = new URL(href, base); } catch { continue; }
    const name = url.searchParams.get('name') || decodeURIComponent(url.pathname.split('/').pop() || '');
    if (!/\.pdf$/i.test(name)) continue;
    const hit = KIND_OF.find(([rx]) => rx.test(name.trim()));
    if (!hit) continue;
    if (out.some((x) => x.url === url.href)) continue;
    out.push({ kind: hit[1], name: name.trim(), url: url.href });
  }
  return out;
}

// The first (newest) link of each kind: { applications, decisions, appeals } (missing = null).
function newestLinks(html, base) {
  const links = pdfLinks(html, base);
  const out = {};
  for (const k of KINDS) out[k] = links.find((x) => x.kind === k) || null;
  return out;
}

const ukToIso = (d) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(d || '').trim());
  if (!m) return '';
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};

// The list's own week, from its heading ("Weekly list for 16/11/2026 to 20/11/2026",
// "Weekly List from 16/11/2026 to 20/11/2026"): { from, to } or null.
function weekOf(text) {
  const m = /weekly list (?:for|from)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(String(text));
  if (!m) return null;
  const from = ukToIso(m[1]);
  const to = ukToIso(m[2]);
  return from && to ? { from, to } : null;
}

// Field labels in the PDFs (with Wychavon's "Desicion Date" spelling). Anything not listed under
// KEEP is read past and dropped.
const LABELS = ['Application Number', 'DETR/Appeal Reference', 'Location', 'Proposal', 'Date Valid',
  'Applicant', 'Applicant Address', 'Expected Decision Level', 'Agents Name', 'Agent Name', 'Agent Address',
  'Application Type', 'Ward(s)', 'Ward', 'Parish(es)', 'Parish', 'Case Officer', 'Telephone Number', 'Email',
  'Online Register', 'Desicion Date', 'Decision Date', 'Decision', 'Expiry Date', 'Appeal Start Date',
  'Appeal Method'];
const LABEL_RE = new RegExp(`^\\s*(${LABELS.map((l) => l.replace(/[()/]/g, '\\$&')).join('|')}):\\s*(.*)$`);
const NOISE = /^\s*(Page \d+ of \d+|Doc Ref:|Total Number of)/i;

// Splits pdftotext -layout text into entries of { label: value } (continuation lines joined with a
// space; Location's lines with ", "). Each entry starts at "Application Number:" or, in the appeals
// list, "DETR/Appeal Reference:".
function rawEntries(text) {
  const lines = String(text).replace(/\f/g, '\n').split(/\r?\n/);
  const entries = [];
  let cur = null;
  let last = '';
  for (const line of lines) {
    if (!line.trim()) { last = ''; continue; }
    if (NOISE.test(line)) { last = ''; continue; }
    const m = LABEL_RE.exec(line);
    if (m) {
      const [, label, value] = m;
      const starts = label === 'DETR/Appeal Reference' || (label === 'Application Number' && !(cur && cur['DETR/Appeal Reference'] && !cur['Application Number']));
      if (starts) { cur = {}; entries.push(cur); }
      if (!cur) continue;
      cur[label] = value.trim();
      last = label;
      continue;
    }
    // A continuation line (indented under its value).
    if (cur && last && /^\s{8,}\S/.test(line)) {
      const sep = last === 'Location' ? ', ' : ' ';
      cur[last] = cur[last] ? `${cur[last]}${sep}${line.trim()}` : line.trim();
    }
  }
  return entries;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const REF_RE = /^W\/\d{2}\/\d{5}\/[A-Z0-9]+$/;

// Address without the postcode and the post town (the parish already places it).
function tidyLocation(loc) {
  let s = clean(loc).replace(/,?\s*\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, '')
    .replace(/(,\s*)+,/g, ',').replace(/[\s,]+$/, '');
  for (let i = 0; i < 3; i += 1) s = s.replace(/,\s*(Evesham|Worcester|Worcestershire|Pershore|Alcester|Redditch|Droitwich)[\s,]*$/i, '');
  return s.replace(/^Land At\b/i, 'Land at').replace(/\(?Os (\d)/, (x, d) => x.replace('Os', 'OS')).replace(/,\s*,/g, ',').replace(/[\s,]+$/, '');
}

// Wychavon's own words, cut at a word break near PROPOSAL_MAX with "…" (the page shows them whole).
function shortProposal(p, max = PROPOSAL_MAX) {
  const s = clean(p).replace(/\.$/, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/[\s,;:.-]+\S*$/, '');
  return `${cut}…`;
}

// Labels for reference suffixes, for the decisions list (which has no Application Type).
const TYPE_BY_SUFFIX = {
  HP: 'Householder', FUL: 'Full planning permission', OUT: 'Outline', RM: 'Reserved matters',
  LB: 'Listed building consent', PIP: 'Permission in principle', CLPU: 'Certificate of lawfulness (proposed)',
  CLE: 'Certificate of lawfulness (existing)', CLPW: 'Certificate of lawfulness (proposed works)',
  ADV: 'Advertisement consent', AGR: 'Agricultural', GPDQ: 'Prior approval (agricultural to dwelling)',
  GPDA: 'Prior approval', PN: 'Prior notification', S106: 'Planning obligation', HED: 'Hedgerow notification',
  NMA: 'Non-material amendment', CON: 'Discharge of conditions', VAR: 'Variation of conditions',
};
const suffixOf = (ref) => String(ref).split('/').pop();

// Tree works (Jon, 25 Nov: left out): conservation-area tree notices and TPO applications.
function isTreeWork(ref, type) {
  return /^(CAN|TPO|TPOA|TCA)$/i.test(suffixOf(ref)) || /\btree\b|\bTPO\b/i.test(String(type || ''));
}

// One list's entries, kept fields only: { ref, location, proposal, type, date, decision?, parish, link }.
// kind: applications (date = Date Valid), decisions (date = decision date), appeals (date = appeal start).
function parseList(text, kind) {
  const out = [];
  for (const e of rawEntries(text)) {
    const ref = clean(e['Application Number']);
    if (!REF_RE.test(ref)) continue;
    const typeRaw = clean(e['Application Type']);
    if (isTreeWork(ref, typeRaw)) continue;
    const date = ukToIso(kind === 'decisions' ? (e['Desicion Date'] || e['Decision Date'])
      : kind === 'appeals' ? e['Appeal Start Date'] : e['Date Valid']);
    const item = {
      ref,
      location: tidyLocation(e.Location),
      proposal: clean(e.Proposal),
      type: typeRaw || TYPE_BY_SUFFIX[suffixOf(ref)] || '',
      date,
      parish: clean(e['Parish(es)'] || e.Parish),
      link: DISPLAY + ref,
    };
    if (kind === 'decisions') item.decision = clean(e.Decision);
    out.push(item);
  }
  return out;
}

// How many entries the text appears to hold (for the diagnostic's "parser found none" check).
const entryCount = (text) => (String(text).match(/Application Number:/g) || []).length;

// Entries for a site's parishes (exact names, as Wychavon spells them; an entry may name several,
// comma separated).
function forParishes(entries, parishes) {
  const want = new Set((parishes || []).map((p) => p.toLowerCase()));
  return entries.filter((e) => String(e.parish).split(/\s*,\s*/).some((p) => want.has(p.toLowerCase())));
}

// Puts one kind's entries into data.weeks (keyed by the list's week), newest week first, keeping
// KEEP_WEEKS. lists[kind] = true marks that list as read, even with nothing for these parishes.
function addList(data, week, kind, entries) {
  const d = data && Array.isArray(data.weeks) ? data : { weeks: [] };
  let w = d.weeks.find((x) => x.from === week.from);
  if (!w) {
    w = { from: week.from, to: week.to, lists: {}, applications: [], decisions: [], appeals: [] };
    d.weeks.push(w);
  }
  w.to = week.to;
  w.lists = { ...(w.lists || {}), [kind]: true };
  w[kind] = entries;
  d.weeks.sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
  d.weeks = d.weeks.slice(0, KEEP_WEEKS);
  return d;
}

const hasList = (data, week, kind) => !!(data && (data.weeks || []).some((w) => w.from === week.from && w.lists && w.lists[kind]));

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// The newsletter's week: the newest list week ending in the 12 days before the issue (a Thursday
// issue shows the Monday-to-Friday list of the week before), so each week is in one issue only. A
// list Wychavon publishes too late for its issue is on the Planning page only. null = no section.
function weekForIssue(data, issueDate) {
  const weeks = (data && data.weeks) || [];
  const w = weeks.filter((x) => x.to && x.to < issueDate && x.to >= addDays(issueDate, -12))
    .sort((a, b) => (a.to < b.to ? 1 : -1))[0];
  if (!w) return null;
  const pick = (e) => ({ ref: e.ref, location: e.location, proposal: shortProposal(e.proposal), link: e.link,
    ...(e.decision ? { decision: e.decision } : {}), ...(e.date ? { date: e.date } : {}) });
  return {
    from: w.from, to: w.to,
    lists: { ...(w.lists || {}) },
    applications: (w.applications || []).map(pick),
    decisions: (w.decisions || []).map(pick),
    appeals: (w.appeals || []).map(pick),
  };
}

module.exports = {
  LIST_PAGE, DISPLAY, KINDS, KEEP_WEEKS, pdfLinks, newestLinks, weekOf, rawEntries, parseList, entryCount,
  tidyLocation, shortProposal, isTreeWork, forParishes, addList, hasList, weekForIssue, ukToIso, addDays,
};
