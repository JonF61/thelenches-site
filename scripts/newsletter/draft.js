// scripts/newsletter/draft.js
// The admin panel's "Newsletter draft": the next issue as it would be built now, from the
// same select.js and render.js as Thursday's build (with the Wednesday 6pm cutoff), or,
// once that issue has been built (Issues status built, tested or shadow), its frozen
// snapshot exactly as built. Sends nothing and never touches Issues, Pending or any other
// tab: it only rewrites the "Newsletter draft" tab (key, value), which the panel reads.
//   as_of, issue_date, mode (live | frozen), status (the Issues row's, if any), subject,
//   items, events, notices, roads, elsewhere, held, cutoff, subscribers (who a live send goes
//   to now: Subscribers minus Do Not Send, as send.js counts them), then, for a built issue,
//   built_at, tested_at, hash (first 16 of content_hash), send_mode (Settings newsletter_mode)
//   and send_count (the count send.js will check; canary_to's for a canary), which the panel's
//   Send to all (4 Nov) passes to the same nlsend decision as the preview email's Send button;
//   then html_1..html_n: the copy as
//   a subscriber sees it (unsubscribe link pointing at the privacy page, as preview copies),
//   deflated and base64, split into cells under the Sheet's 50,000-character limit.
// Run by newsletter-draft.yml after approvals, publishing, site builds and newsletter
// runs, every 3 hours, and from the panel's Refresh button.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { select, deadlineFor, whatsonKey } = require('./select');
const { render } = require('./render');
const { forPreview } = require('./unsub');
const { buildRecipients, canaryList } = require('./send');

const TAB = 'Newsletter draft';
const CHUNK = 45000;
const FROZEN = new Set(['built', 'tested', 'shadow']);
const ROOT = path.join(__dirname, '..', '..');
const SITE = 'https://thelenches.org.uk';
const TZ = 'Europe/London';

const str = (v) => String(v ?? '').trim();
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Thursday on or after today; next week's once today's issue has gone out (as the panel's Summary).
function issueDateFor(today, issues) {
  let d = today;
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 4) d = addDays(d, 1);
  const gone = (issues || []).some((r) => str(r.issue_id).slice(0, 10) === d && ['sent', 'sending'].includes(str(r.status).toLowerCase()));
  return gone ? addDays(d, 7) : d;
}

function snapshotModel(row) {
  const model = JSON.parse(zlib.inflateSync(Buffer.from(str(row.snapshot), 'base64')).toString('utf8'));
  if (!model || model.issueDate !== str(row.issue_id).slice(0, 10)) throw new Error('snapshot is for a different issue');
  return model;
}

// inputs: { today, pending, issues, settings, sources, whatson, bins, siteupdates, onthisday, photos, jpegFor,
//           subscribers?, dns? (Subscribers / Do Not Send rows; counts only, never printed) }
// -> { meta, html }
function buildDraft(inputs) {
  const issues = inputs.issues || [];
  const issueDate = issueDateFor(inputs.today, issues);
  const rows = issues.filter((r) => str(r.issue_id) === issueDate);
  const row = rows[rows.length - 1] || null;
  const status = row ? str(row.status).toLowerCase() : '';
  let model = null;
  if (row && FROZEN.has(status) && str(row.snapshot)) {
    try { model = snapshotModel(row); } catch (e) { console.warn(`Snapshot unreadable (${e.message}): showing the live draft instead.`); }
  }
  const mode = model ? 'frozen' : 'live';
  if (!model) {
    model = select({
      issueDate, pending: inputs.pending, issues, settings: inputs.settings, sources: inputs.sources, jpegFor: inputs.jpegFor,
      cutoff: deadlineFor(issueDate), whatson: inputs.whatson, bins: inputs.bins, siteupdates: inputs.siteupdates, onthisday: inputs.onthisday, cartoons: inputs.cartoons, photos: inputs.photos,
    });
  }
  const tagged = editTags(model, inputs);
  const issue = forPreview(render(tagged.model, { entries: tagged.entries }));
  const meta = {
    issue_date: issueDate, mode, status, subject: issue.subject,
    items: (model.keys || []).length, events: (model.events || []).length, notices: (model.notices || []).length,
    roads: (model.roads || []).length, elsewhere: (model.elsewhere || []).length,
    held: model.held || 0, cutoff: str(model.cutoff),
  };
  const subs = Array.isArray(inputs.subscribers) ? buildRecipients(inputs.subscribers, inputs.dns || [], []).list.length : null;
  if (subs !== null) meta.subscribers = subs;
  if (mode === 'frozen') {
    const sendMode = str((inputs.settings || {}).newsletter_mode).toLowerCase() || 'off';
    Object.assign(meta, {
      built_at: str(row.built_at), tested_at: str(row.tested_at), hash: str(row.content_hash).toLowerCase().slice(0, 16), send_mode: sendMode,
    });
    if (sendMode === 'canary') meta.send_count = canaryList((inputs.settings || {}).canary_to, []).length;
    else if (subs !== null) meta.send_count = subs;
  }
  return { meta, html: issue.html };
}

// Edit tags for the panel's draft editor (4 Nov, "edit everything"): each item's newsletter key ->
// its source key as in scripts/rimmer/fix.js sources() (p:<Pending id>; h:events/<file> and
// h:notices/<file> found by whatsonKey from the current src/items; r:<index> for Regular
// activities, matched on day, what, time and where). Official statements are left out (Ask Kryten).
// Only this copy carries them; the built issue and every sent copy never do.
function editTags(model, inputs) {
  const { entryKeyOf } = require('../../lib/whatson');
  const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));
  const entries = {};
  const w = inputs.whatson || {};
  const official = new Set((inputs.pending || []).filter((r) => truthy(r.official)).map((r) => `p:${str(r.id)}`));
  for (const ev of w.events || []) if (entryKeyOf(ev) && !truthy(ev.official)) entries[whatsonKey('events', ev)] = entryKeyOf(ev);
  for (const n of w.notices || []) if (entryKeyOf(n) && !truthy(n.official)) entries[whatsonKey('notices', n)] = entryKeyOf(n);
  for (const it of [...(model.events || []), ...(model.notices || []), ...(model.roads || [])]) {
    const k = str(it && it.key);
    if (/^p:/.test(k) && !official.has(k)) entries[k] = k;
  }
  const regKey = (r) => [r.day, r.what, r.time, r.where].map(str).join('|');
  const regs = new Map((w.regulars || []).filter((r) => entryKeyOf(r)).map((r) => [regKey(r), entryKeyOf(r)]));
  if (!Array.isArray(model.regulars)) return { model, entries };
  const regulars = model.regulars.map((r, i) => {
    const e = regs.get(regKey(r));
    if (!e) return r;
    entries[`rg:${i}`] = e;
    return { ...r, key: `rg:${i}` };
  });
  return { model: { ...model, regulars }, entries };
}

// The tab's rows: header, meta, then the deflated html in chunks.
function draftRows(meta, html, asOf) {
  const b64 = zlib.deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).toString('base64');
  const rows = [['key', 'value'], ['as_of', asOf]];
  for (const [k, v] of Object.entries(meta)) rows.push([k, String(v)]);
  for (let i = 0; i * CHUNK < b64.length; i += 1) rows.push([`html_${i + 1}`, b64.slice(i * CHUNK, (i + 1) * CHUNK)]);
  return rows;
}

// Everything buildDraft needs, read from the Sheet and the repo (shared with scripts/checker).
async function loadInputs(g) {
  const { loadWhatson } = require('../../lib/whatson');
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const jpegFor = (webpUrl) => {
    const rel = webpUrl.replace(/\.webp$/, '.jpg');
    return fs.existsSync(path.join(ROOT, 'src', rel)) ? `${SITE}${rel}` : '';
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(Date.now());
  const [{ sources, settings }, pending, issues, subscribers, dns] = await Promise.all([
    g.readSettings(), g.readTable('Pending'), g.readTable('Issues'), g.readTable('Subscribers'), g.readTable('Do Not Send'),
  ]);
  return {
    today, pending, issues, settings, sources, jpegFor, whatson: loadWhatson(), subscribers, dns,
    bins: readJson('src/_data/bins.json'), siteupdates: readJson('src/_data/siteupdates.json'), onthisday: readJson('src/_data/onthisday.json'), cartoons: readJson('src/_data/cartoons.json'),
    photos: readJson('src/_data/photos.json'),
  };
}

async function main() {
  const g = require('../ingest/google');
  const { meta, html } = buildDraft(await loadInputs(g));
  await g.replaceTab(TAB, draftRows(meta, html, new Date().toISOString()));
  console.log(`Draft for ${meta.issue_date} (${meta.mode}${meta.status ? `, Issues ${meta.status}` : ''}): ${meta.items} items `
    + `(${meta.events} events, ${meta.notices} notices, ${meta.roads} roads, ${meta.elsewhere} elsewhere), ${meta.held} held as late`
    + `${meta.subscribers !== undefined ? `; ${meta.subscribers} subscribers` : ''}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  editTags, buildDraft, draftRows, issueDateFor, loadInputs, TAB, CHUNK };
