// scripts/ingest/sitechanges.js
// What has lately been done (autonomy plan step 3, 15 Nov 2026, Jon), so Holly never
// chases, asks for or promises something already done, and Rimmer can catch it if she does.
// Two things, both given to Holly's answer, follow-up and redraft prompts and to Rimmer's
// reading (scripts/ingest/replies.js `siteContext`):
//   senderItems    what this sender sent us in the last 60 days and what became of each
//                  (from the Pending rows; no Sheet read of its own).
//   recentChanges  hand changes to the website in the last 14 days, read from git: each
//                  commit's date, its subject and the entries or pages it touched. Commit
//                  subjects and file names are already public. Needs history in the
//                  checkout (ingest.yml: fetch-depth 0, blobless); with none it returns [].
// Both are pure apart from the git call and file reads, and never throw.
// Test: scripts/test-sitechanges.js.

const { SITE, SITE_REL } = require('../../lib/site.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const nlissues = require('./nlissues');

const ROOT = path.join(__dirname, '..', '..');
const CHANGE_DAYS = 14;
const MAX_CHANGES = 30;
const MAX_ENTRIES = 6;
const SENDER_DAYS = 60;
const MAX_SENDER_ITEMS = 12;

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Data files whose changes mean something to a reader, by the page they feed. Anything
// not here (pipeline.json, recommends.json, roadgeo.json, cartoons, sponsors, site
// settings, images) is left out: automatic, or not about anyone's entry.
const DATA_PAGES = {
  'items/regulars.json': 'Regular activities page',
  'items/bin-and-footnote.json': 'bin collection line',
  '_data/eat.json': 'Where to eat page',
  '_data/trades.json': 'Local trades page',
  '_data/schools.json': 'Schools page',
  '_data/services.json': 'church services',
  '_data/council.json': 'Councils page',
  '_data/health.json': 'Health page',
  '_data/transport.json': 'Transport page',
  '_data/contacts.json': 'Groups and contacts page',
  '_data/bins.json': 'bin collections',
};
const VERB = { A: 'added', M: 'changed', D: 'removed', R: 'changed' };

// One changed file -> words for it, or '' to leave it out.
function describeFile(status, file, root = ROOT) {
  const verb = VERB[String(status || '').charAt(0)] || 'changed';
  // Paths inside the site's folder (sites/<site>/…; before 16 Nov 2026 the Lenches files were in src/).
  const rel = file.startsWith(`${SITE_REL}/`) ? file.slice(SITE_REL.length + 1)
    : SITE === 'lenches' && file.startsWith('src/') ? file.slice(4) : '';
  const item = rel.match(/^items\/(events|notices)\/(.+)\.json$/);
  if (item) {
    let title = '';
    try { title = str(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).title); } catch { /* removed or unreadable */ }
    if (!title) title = item[2].replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
    return `${item[1] === 'events' ? 'event' : 'notice'} "${title}" ${verb}`;
  }
  if (DATA_PAGES[rel]) return `${DATA_PAGES[rel]} changed`;
  const page = rel.match(/^(.+)\.njk$/);
  // Unlisted pages (the sponsor pages) and includes are nobody's entry.
  if (page && !/^(_includes|sponsor)\//.test(page[1])) {
    return `page /${page[1].replace(/(^|\/)index$/, '').replace(/\/$/, '')}${page[1] === 'index' ? '' : '/'} wording changed`;
  }
  return '';
}

// `git log --name-status` output (records start \x01, date \x02 subject) -> changes (pure
// apart from reading item titles).
function parseLog(out, { root = ROOT, max = MAX_CHANGES } = {}) {
  const changes = [];
  for (const rec of String(out || '').split('\x01').slice(1)) {
    const [head, ...lines] = rec.split('\n');
    const [date, subject = ''] = head.split('\x02');
    const entries = [];
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      // The 16 Nov 2026 move of the Lenches files from src/ to sites/lenches/ is not a change.
      if (parts.length === 3 && parts[0].startsWith('R') && parts[1].startsWith('src/') && parts[2] === `sites/lenches/${parts[1].slice(4)}`) continue;
      const what = describeFile(parts[0], parts[parts.length - 1], root);
      if (what && !entries.includes(what)) entries.push(what);
    }
    if (!entries.length) continue;
    changes.push({
      date: str(date),
      change: str(subject).replace(/\s*\(#\d+\)\s*$/, '').slice(0, 160),
      entries: entries.slice(0, MAX_ENTRIES),
    });
    if (changes.length >= max) break;
  }
  return changes;
}

let cache = null;
// Hand changes to the site in the last `days` days, newest first: [{ date, change, entries }].
function recentChanges({ days = CHANGE_DAYS, root = ROOT, run = execFileSync, fresh = false } = {}) {
  if (cache && !fresh) return cache;
  let out = [];
  try {
    const log = run('git', ['log', `--since=${days} days ago`, '--date=short', '--format=%x01%ad%x02%s', '--name-status', '--', SITE_REL, 'src'],
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    out = parseLog(log, { root });
  } catch { /* no git or no history: nothing known */ }
  if (!fresh) cache = out;
  return out;
}

const STATE = {
  pending: 'waiting for the team to look at it',
  approved: 'accepted by the team',
  auto: 'accepted',
  trusted: 'accepted',
  rejected: 'not used',
  done: 'already dealt with: the website had it already, or the team added it by hand',
};

// What one sender sent lately and what became of it (pure).
// existing: Pending rows; isSender(fromCell) -> boolean; live: Map of Pending id -> page url
// for items on the website now; today: YYYY-MM-DD.
function senderItems(existing = [], isSender = () => false, { live = new Map(), today = new Date().toISOString().slice(0, 10), skipMessageId = '', now = Date.now() } = {}) {
  const since = new Date(new Date(`${today}T12:00:00Z`).getTime() - SENDER_DAYS * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const r of existing) {
    if (!str(r.title) || (skipMessageId && str(r.message_id) === skipMessageId)) continue;
    if (str(r.received).slice(0, 10) < since || !isSender(r.from)) continue;
    const status = str(r.status).toLowerCase();
    const url = live.get(str(r.id)) || '';
    const notes = str(r.notes);
    out.push({
      title: str(r.title),
      date: str(r.event_date).slice(0, 10),
      sent: str(r.received).slice(0, 10),
      state: url ? 'on the website now' : (STATE[status] || status),
      page: url,
      decided: str(r.decided_at).slice(0, 10),
      details_they_added_later: /Details added from submitter's reply/.test(notes),
      already_listed_as: (notes.match(/Already listed: "([^"]+)"/) || [])[1] || '',
      newsletter: ['approved', 'auto', 'trusted'].includes(status) || url ? nlissues.words(nlissues.plan({
        kind: str(r.category).toLowerCase() === 'event' ? 'event' : 'notice', date: r.event_date,
        newsletterCount: r.newsletter_count, roads: !!str(r.road) }, now)) : '',
    });
  }
  return out.sort((a, b) => (a.sent < b.sent ? 1 : -1)).slice(0, MAX_SENDER_ITEMS);
}

module.exports = { CHANGE_DAYS, SENDER_DAYS, DATA_PAGES, describeFile, parseLog, recentChanges, senderItems };
