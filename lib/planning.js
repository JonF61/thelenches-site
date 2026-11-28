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
  // homes (25 Nov 2026, Jon): new homes in the proposal, for the newsletter's badge.
  const pick = (e) => ({ ref: e.ref, location: e.location, proposal: shortProposal(e.proposal), link: e.link,
    ...(homesIn(e.proposal, e.ref) ? { homes: homesIn(e.proposal, e.ref), homesLabel: homesLabel(e.proposal, homesIn(e.proposal, e.ref)) } : {}),
    ...(e.decision ? { decision: e.decision } : {}), ...(e.date ? { date: e.date } : {}) });
  return {
    from: w.from, to: w.to,
    lists: { ...(w.lists || {}) },
    applications: (w.applications || []).map(pick),
    decisions: (w.decisions || []).map(pick),
    appeals: (w.appeals || []).map(pick),
  };
}

// ---- Map links (25 Nov 2026, Jon): Google Maps for each entry on the Planning page.
// An address is searched as written, plus ", Worcestershire". "Land at OS 0208 4905" style
// locations carry an Ordnance Survey grid reference (two 4-figure numbers, 10 m, within its 100 km
// square): Wychavon straddles squares SO (eastings 3xxxxx) and SP (4xxxxx), so a first figure of 5
// or more is SO, else SP; northings are 2xxxxx. Converted OSGB36 -> WGS84 (Airy 1830 transverse
// Mercator inverse, then a Helmert shift; a few metres out at most), pinned at that point.
function osToLatLon(E, N) {
  const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717;
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180, N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;
  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (N - N0 - M >= 0.00001);
  const sin = Math.sin(lat), cos = Math.cos(lat), tan = Math.tan(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sin * sin);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const VII = tan / (2 * rho * nu);
  const VIII = tan / (24 * rho * nu ** 3) * (5 + 3 * tan ** 2 + eta2 - 9 * tan ** 2 * eta2);
  const IX = tan / (720 * rho * nu ** 5) * (61 + 90 * tan ** 2 + 45 * tan ** 4);
  const X = 1 / (cos * nu);
  const XI = 1 / (cos * 6 * nu ** 3) * (nu / rho + 2 * tan ** 2);
  const XII = 1 / (cos * 120 * nu ** 5) * (5 + 28 * tan ** 2 + 24 * tan ** 4);
  const XIIA = 1 / (cos * 5040 * nu ** 7) * (61 + 662 * tan ** 2 + 1320 * tan ** 4 + 720 * tan ** 6);
  const dE = E - E0;
  const phi = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lam = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  // OSGB36 -> WGS84 (Helmert).
  const H = 0;
  const x1 = (nu / F0 + H) * Math.cos(phi) * Math.cos(lam);
  const y1 = (nu / F0 + H) * Math.cos(phi) * Math.sin(lam);
  const z1 = ((1 - e2) * nu / F0 + H) * Math.sin(phi);
  const tx = 446.448, ty = -125.157, tz = 542.060, s = -20.4894e-6;
  const sec = Math.PI / (180 * 3600), rx = 0.1502 * sec, ry = 0.2470 * sec, rz = 0.8421 * sec;
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;
  const a2 = 6378137, b2 = 6356752.3142, e22 = 1 - (b2 * b2) / (a2 * a2);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let la = Math.atan2(z2, p * (1 - e22)), prev;
  do { prev = la; const v = a2 / Math.sqrt(1 - e22 * Math.sin(la) ** 2); la = Math.atan2(z2 + e22 * v * Math.sin(la), p); } while (Math.abs(la - prev) > 1e-12);
  return { lat: la * 180 / Math.PI, lon: Math.atan2(y2, x2) * 180 / Math.PI };
}

function gridPoint(location) {
  const m = /\bOS\s*\(?\s*(\d{4})\s+(\d{4})\s*\)?/i.exec(String(location || ''));
  if (!m) return null;
  const e = Number(m[1]), n = Number(m[2]);
  const E = (e >= 5000 ? 300000 : 400000) + e * 10 + 5;
  const N = 200000 + n * 10 + 5;
  return osToLatLon(E, N);
}

// Pins for the Planning page map (28 Nov 2026, Jon): every application in the weeks and open lists
// that has a point (scripts/planning placeAll), once per reference, with what the filters need.
// kind: closing (comments close within CLOSING_DAYS), open (comments open), waiting, decided, appeal.
function mapPoints(data, today) {
  const seen = new Map();
  const closing = new Set(closingSoon((data && data.open) || [], today).map((e) => e.ref));
  const add = (e, extra) => {
    if (e.lat == null || e.lng == null) return;
    const had = seen.get(e.ref) || {};
    seen.set(e.ref, { ...had, ref: e.ref, location: e.location, proposal: shortProposal(e.proposal, 90), lat: e.lat, lng: e.lng,
      approx: e.place === 'postcode', homes: e.homes || had.homes || homesIn(e.proposal, e.ref) || 0, ...extra });
  };
  for (const w of (data && data.weeks) || []) {
    for (const e of w.applications || []) add(e, { anchor: `pl-${slug(e.ref)}`, kind: 'waiting' });
    for (const e of w.appeals || []) add(e, { anchor: `pl-${slug(e.ref)}`, kind: 'appeal' });
    for (const e of w.decisions || []) add(e, { anchor: `pl-${slug(e.ref)}`, kind: 'decided', decision: e.decision || '' });
  }
  for (const e of (data && data.open) || []) {
    const had = seen.get(e.ref);
    const kind = e.decisionDate ? 'decided' : closing.has(e.ref) ? 'closing' : commentsOpen(e, today) ? 'open' : e.appealStarted ? 'appeal' : 'waiting';
    add(e, { anchor: had ? had.anchor : `open-${slug(e.ref)}`, kind, ...(e.decisionDate ? { decision: e.decision || '' } : {}) });
  }
  return [...seen.values()];
}
// As Eleventy's slugify does for a reference (W/26/02518/PIP → w-26-02518-pip).
const slug = (ref) => String(ref).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function mapUrl(location) {
  const pt = gridPoint(location);
  const q = pt ? `${pt.lat.toFixed(5)},${pt.lon.toFixed(5)}` : `${clean(location)}, Worcestershire`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// ---- New homes (25 Nov 2026, Jon: highlight significant applications). The number of new homes a
// proposal adds, from Wychavon's wording, or 0. Householder and other non-building references
// never count; extensions, annexes and outbuildings of an existing home don't either.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NOT_HOMES = /^(HP|CAN|TPO|TPOA|TCA|CCO|CON|NMA|S106|ADV|HED|LB|LBC|VAR|DIS|AGR)$/i;
const HOME_WORD = /\b(dwellings?|dwellinghouses?|dwelling\s+houses?|houses|homes|bungalows?|residential\s+units?|flats|apartments)\b/i;
function homesIn(proposal, ref = '') {
  const p = clean(proposal);
  if (!p || NOT_HOMES.test(suffixOf(ref))) return 0;
  if (!HOME_WORD.test(p)) return 0;
  if (/\b(extension|annexe|annex|outbuilding|garage|conservatory|porch|dormer|loft)\b/i.test(p)
    && !/\b(new|erection of|construction of)\s+(\d+\s*(no\.?)?\s*)?(dwelling|house|home|bungalow)/i.test(p)) return 0;
  const n = (t) => (/^\d+$/.test(t) ? Number(t) : NUM_WORDS[t.toLowerCase()] || 0);
  const nums = [];
  const word = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  for (const re of [new RegExp(`maximum\\s+(?:of\\s+)?${word}`, 'gi'), new RegExp(`up\\s+to\\s+${word}`, 'gi'),
    new RegExp(`${word}\\s*(?:no\\.?\\s*)?(?:new\\s+)?(?:\\w+\\s+)?(?:dwellings?|dwellinghouses?|houses|homes|bungalows?|units|flats|apartments)`, 'gi')]) {
    let m;
    while ((m = re.exec(p))) nums.push(n(m[1]));
  }
  const best = Math.max(0, ...nums.filter((x) => x > 0 && x < 1000));
  return best || 1;
}
// "1 new home" / "Up to 5 new homes" (a range or maximum: "up to").
function homesLabel(proposal, homes) {
  if (!homes) return '';
  if (homes === 1) return '1 new home';
  return `${/maximum|up to/i.test(String(proposal)) ? 'Up to ' : ''}${homes} new homes`;
}

// ---- Awaiting a decision (25 Nov 2026, Jon). Each open application's own page on Wychavon's
// planning site (plan.wychavon.gov.uk/Planning/Display/<ref>) gives its stage. Only these fields
// are read: status, valid date, consultation end, committee, decision and its date, appeal started
// and appeal decision, and (for the back-fill) location, proposal, type and parish. Never the
// applicant, agent, officer or anyone's address.
const pageText = (html) => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '\n')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .split('\n').map((l) => l.trim()).filter(Boolean);
const NA = (v) => (!v || /^N\/?A$/i.test(v) ? '' : v);
function parseDisplay(html) {
  const lines = pageText(html);
  const at = (from, labels) => {
    for (let i = from; i < lines.length - labels.length; i += 1) {
      if (labels.every((l, j) => lines[i + j].toLowerCase() === l.toLowerCase())) return lines[i + labels.length] || '';
    }
    return '';
  };
  const os = lines.findIndex((l) => /^Planning Online Status$/i.test(l));
  if (os < 0) return null;
  const sum = lines.findIndex((l, i) => i > os && /^Summary$/i.test(l));
  const field = (label) => {
    const i = lines.findIndex((l, k) => k > sum && l.toLowerCase() === label.toLowerCase());
    return i < 0 ? '' : lines[i + 1] || '';
  };
  const block = (label, stop) => {
    const i = lines.findIndex((l, k) => k > sum && l.toLowerCase() === label.toLowerCase());
    if (i < 0) return '';
    const out = [];
    for (let k = i + 1; k < lines.length && !stop.test(lines[k]); k += 1) out.push(lines[k]);
    return out.join(', ');
  };
  return {
    valid: ukToIso(at(os, ['Application', 'Valid'])),
    consultationEnd: ukToIso(at(os, ['Consultation', 'End'])),
    committee: ukToIso(NA(at(os, ['Committee', 'Meeting']))),
    decision: NA(at(os, ['Decision'])),
    decisionDate: ukToIso(NA(at(os, ['Decision', 'Date']))),
    appealStarted: ukToIso(NA(at(os, ['Appeal', 'Started']))),
    appealDecision: NA(at(os, ['Appeal', 'Decision'])),
    status: field('Status'),
    location: tidyLocation(block('Location Address', /^Proposal$/i)),
    proposal: clean(block('Proposal', /^Status$/i)),
    type: field('Application Type'),
    parish: clean(field('Parish')),
    ...(postcodeIn(block('Location Address', /^Proposal$/i)) ? { postcode: postcodeIn(block('Location Address', /^Proposal$/i)) } : {}),
  };
}
// The site's postcode, from an address (Map, 28 Nov 2026): used only to look up a map point, never stored.
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
function postcodeIn(s) {
  const m = POSTCODE_RE.exec(String(s || ''));
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : '';
}
// Still awaiting a decision?
const isOpen = (d) => !!d && /pending/i.test(`${d.decision} ${d.status}`) && !d.decisionDate;

// The open applications, newest valid date first, new homes first.
function sortOpen(list) {
  return [...(list || [])].sort((a, b) => ((b.homes ? 1 : 0) - (a.homes ? 1 : 0)) || String(b.valid || '').localeCompare(String(a.valid || '')) || a.ref.localeCompare(b.ref));
}

// The stage line for an open application on the Planning page: [{ text, strong }], worked out on
// the build day (today, YYYY-MM-DD). Open over 6 months: a pointer to Wychavon for the latest.
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso, today) {
  const d = Number(iso.slice(8, 10));
  const m = MON3[Number(iso.slice(5, 7)) - 1];
  return iso.slice(0, 4) === String(today).slice(0, 4) ? `${d} ${m}` : `${d} ${m} ${iso.slice(0, 4)}`;
}
function waited(from, today) {
  const days = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);
  if (days < 14) return '';
  if (days < 60) return `${Math.floor(days / 7)} weeks`;
  if (days < 730) return `${Math.floor(days / 30.44)} months`;
  return `${Math.floor(days / 365.25)} years`;
}
function openStatus(e, today) {
  const out = [];
  if (e.valid) out.push({ text: `Valid ${shortDate(e.valid, today)}` });
  if (e.appealStarted) out.push({ text: `At appeal since ${shortDate(e.appealStarted, today)}`, strong: true });
  else if (e.consultationEnd && e.consultationEnd >= today) out.push({ text: `Comments until ${shortDate(e.consultationEnd, today)}`, strong: true });
  else if (e.consultationEnd) out.push({ text: `comments closed ${shortDate(e.consultationEnd, today)}` });
  if (e.committee && e.committee >= today) out.push({ text: `Planning committee ${shortDate(e.committee, today)}`, strong: true });
  else if (e.committee) out.push({ text: `went to planning committee ${shortDate(e.committee, today)}` });
  const w = e.valid ? waited(e.valid, today) : '';
  const long = e.valid && addDays(e.valid, 183) < today;
  if (w) out.push({ text: long ? `waiting ${w}: check Wychavon for the latest` : `waiting ${w}` });
  return out;
}
const commentsOpen = (e, today) => !e.appealStarted && !!e.consultationEnd && e.consultationEnd >= today;

// Comments close soon (28 Nov 2026, Jon): undecided applications whose comment period ends within
// CLOSING_DAYS of today (today counts), soonest first. Each copy gets daysLeft (0 = today).
// Used by the Planning page's top box, the Home line and the newsletter's Planning band.
const CLOSING_DAYS = 10;
function closingSoon(open, today, days = CLOSING_DAYS) {
  const last = addDays(today, days);
  return (open || [])
    .filter((e) => !e.decisionDate && commentsOpen(e, today) && e.consultationEnd <= last)
    .map((e) => ({ ...e, daysLeft: Math.round((new Date(`${e.consultationEnd}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000) }))
    .sort((a, b) => a.consultationEnd.localeCompare(b.consultationEnd) || ((b.homes || 0) - (a.homes || 0)) || a.ref.localeCompare(b.ref));
}
// The Home line's counts: undecided applications open for comments, and how many of those include new homes.
function commentCounts(open, today) {
  const list = (open || []).filter((e) => !e.decisionDate && commentsOpen(e, today));
  return { comments: list.length, withHomes: list.filter((e) => e.homes).length, closing: closingSoon(open, today).length };
}
// Going to planning committee (28 Nov 2026, Jon): undecided applications with a committee date in the
// next COMMITTEE_DAYS (today counts), soonest first. Page box, newsletter band.
const COMMITTEE_DAYS = 21;
function atCommittee(open, today, days = COMMITTEE_DAYS) {
  const last = addDays(today, days);
  return (open || []).filter((e) => !e.decisionDate && e.committee && e.committee >= today && e.committee <= last)
    .sort((a, b) => a.committee.localeCompare(b.committee) || ((b.homes || 0) - (a.homes || 0)) || a.ref.localeCompare(b.ref));
}
const daysLeftText = (n) => (n <= 0 ? 'closes today' : n === 1 ? 'closes tomorrow' : `${n} days left`);

module.exports = {
  openStatus, commentsOpen, closingSoon, atCommittee, COMMITTEE_DAYS, commentCounts, daysLeftText, CLOSING_DAYS,
  homesIn, homesLabel, parseDisplay, isOpen, sortOpen, pageText,
  mapUrl, gridPoint, postcodeIn, mapPoints,
  LIST_PAGE, DISPLAY, KINDS, KEEP_WEEKS, pdfLinks, newestLinks, weekOf, rawEntries, parseList, entryCount,
  tidyLocation, shortProposal, isTreeWork, forParishes, addList, hasList, weekForIssue, ukToIso, addDays,
};
