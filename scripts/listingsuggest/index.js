// scripts/listingsuggest/index.js
// Suggest a tradesperson / somewhere to eat (part 2 of Suggest/Recommend, double opt-in like
// the Recommend buttons). listing-suggest.yml runs this on repository_dispatch "listing-suggest":
//   send      the form saved a Listing suggestions row (status "new"): one confirmation email
//             with a signed /sg link lasting LINK_DAYS ("sent"). From the Worker (/sg).
//   confirm   the suggester pressed that link's button: "confirmed", so it shows on the panel's
//             Suggestions screen for Jon. From the Worker (/sg?t=).
//   approve   Jon's Approve, or Edit then Save and approve (decide() sug_ok; his edited entry
//             is the payload's body, read from the event file): the entry, with a fixed id from
//             lib/listings.js listingId, is added to src/_data/trades.json or eat.json. The
//             workflow commits it, then runs this again with "approved" to mark the row.
//             The suggestion also counts as the entry's first recommendation: a "counted"
//             Recommendations row (key = the address's hash, as scripts/recommend makes, so the
//             same address can't recommend it again; no address) is added, and
//             src/_data/recommends.json is rewritten for the same commit.
//   approved  sends the suggester one fixed thank-you email (thanksEmail: the page link to the
//             entry's own anchor, lib/listings.js anchorFor, and where the star is), then marks
//             the row "approved" (decided_at, entry = the new id) and wipes the address.
//   reject    decide() sug_no: "rejected", Jon's optional reason (event file) in reject_reason,
//             address wiped. Nothing is sent back to the suggester.
//   thank / thanked  one-off, by hand (workflow_dispatch with the row id, or kind:entry
//             such as trades:john): for a suggestion
//             approved before thank-you emails existed (result "added"). The address was wiped,
//             so it is found again from our own confirmation email in Sent mail (exactly one
//             match, or nothing is done). "thank" counts the recommendation (the workflow
//             commits recommends.json), "thanked" sends the thank-you and sets result.
// Every run also wipes addresses 30 days (KEEP_DAYS) after the request was made, if never
// confirmed ("expired"), or after confirming. The address and "why" are never logged, put in
// env or committed; logs print the action and result only (Actions logs are public).
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, APPROVAL_SIGNING_KEY, WORKER_URL, ACTION, SUGGEST_ID,
// GITHUB_EVENT_PATH (body, reason), SUGGEST_STATE (a file approve -> approved passes the new id in).
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const g = require('../ingest/google');
const { signToken, linksEnabled } = require('../ingest/links');
const { emailHtml, stamp, ageDays } = require('../signup');
const { listingId, anchorFor } = require('../../lib/listings');
const rec = require('../recommend');

const FROM = 'website@thelenches.org.uk';
const SITE = 'https://thelenches.org.uk';
const LINK_DAYS = 7;
const KEEP_DAYS = 30;
const DATA_DIR = path.join(__dirname, '..', '..', 'src', '_data');

const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();

let rulesCache = null;
async function rules() {
  if (!rulesCache) rulesCache = await import(pathToFileURL(path.join(__dirname, '..', '..', 'worker', 'src', 'admin', 'suggestions.mjs')).href);
  return rulesCache;
}

function readData(dataDir, R) {
  const out = {};
  for (const [kind, k] of Object.entries(R.KINDS)) out[kind] = JSON.parse(fs.readFileSync(path.join(dataDir, k.file), 'utf8'));
  return out;
}

/* --------------------------------------------------------------- emails -- */

function confirmEmail(name, label, url) {
  const paras = [
    'Hello,',
    `Someone, hopefully you, suggested ${name} for the ${label} page of thelenches.org.uk.`,
    `This link works for ${LINK_DAYS} days. Once you confirm, we'll take a look before adding it. If you didn't ask, just ignore this email.`,
  ];
  return {
    subject: 'Please confirm your suggestion: The Lenches website',
    html: emailHtml(paras.slice(0, 2), { text: 'Yes, send my suggestion', url }, paras.slice(2)),
    text: `${paras[0]}\n\n${paras[1]}\n\nYes, send my suggestion:\n${url}\n\n${paras[2]}\n\nthelenches.org.uk\n`,
  };
}

// After Jon approves (wording approved by Jon 5 Nov). Fixed text, no Claude.
function thanksEmail({ kind, name, section, page, anchor }) {
  const url = `${SITE}${page}#${anchor}`;
  const where = kind === 'eat'
    ? `They're now listed on our Where to eat page, in ${section}`
    : `They're now listed on our Local trades page under ${section}`;
  const paras = [
    'Hi,',
    `Thanks for suggesting ${name}. ${where}:`,
  ];
  const after = [
    'We\'ve counted your suggestion as a recommendation, so you\'ll see "★ Recommended by 1 person" just under their name.',
  ];
  const sign = ['Best wishes,', 'Holly', 'Lenches website assistant'];
  return {
    subject: `Thanks — ${name} is now on the website`,
    html: emailHtml(paras, { text: 'See it on the website', url }, [...after, sign.join('\n')])
      .replace(/Best wishes,\nHolly\nLenches website assistant/, 'Best wishes,<br>Holly<br>Lenches website assistant'),
    text: `${paras[0]}\n\n${paras[1]} ${url}\n\n${after[0]}\n\n${sign.join('\n')}\n`,
  };
}

/* ------------------------------------------------------------------ run -- */

// Jon's edited entry (body) and reject reason, from the event file, never env.
function payloadText() {
  let p = {};
  if (process.env.GITHUB_EVENT_PATH) {
    try { p = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).client_payload || {}; } catch { p = {}; }
  }
  return { reason: String(p.reason ?? ''), body: String(p.body ?? '') };
}

async function tidy(deps, tab, rows, ms) {
  let n = 0;
  for (const r of rows) {
    if (!str(r.email)) continue;
    const s = lc(r.status);
    if (['new', 'sent', 'failed'].includes(s) && ageDays(r.requested, ms) > KEEP_DAYS) {
      await deps.g.updateRow(tab, r._row, { email: '', status: 'expired' });
      n += 1;
    } else if (str(r.confirmed_at) && ageDays(r.confirmed_at, ms) > KEEP_DAYS) {
      await deps.g.updateRow(tab, r._row, { email: '' });
      n += 1;
    }
  }
  return n;
}

// The suggestion counts as the new entry's first recommendation (unless this address has
// already got one counted for it, e.g. a replayed approve). No address is stored in the row.
async function firstRecommendation(deps, kind, entryId, email, ms, countsFile) {
  if (!str(email)) return false;
  await deps.g.ensureTab(rec.TAB, rec.HEADERS);
  const rows = await deps.g.readTable(rec.TAB);
  const key = rec.emailKey(email);
  const has = rows.some((r) => lc(r.status) === 'counted' && r.kind === kind && r.entry === entryId && r.key === key);
  if (!has) {
    const now = stamp(ms);
    const d = new Date(ms);
    const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const row = {
      id: `rc-${day}-${require('crypto').randomBytes(4).toString('hex').slice(0, 6)}`,
      requested: now, kind, entry: entryId, email: '', key, status: 'counted', confirmed_at: now, result: 'suggested it',
    };
    await deps.g.appendRows(rec.TAB, [row]);
    rows.push(row);
  }
  rec.writeCounts(rows, countsFile);
  return true;
}

// The address our confirmation email for this row went to (Sent mail, within a day of
// sent_at, naming the entry): exactly one, else ''. Never logged.
async function sentAddress(deps, row, label) {
  const name = str(row.name);
  const d = new Date(`${str(row.sent_at).slice(0, 10)}T12:00:00Z`);
  if (!name || Number.isNaN(d.getTime())) return '';
  const day = (n) => { const x = new Date(d.getTime() + n * 86400e3); return `${x.getUTCFullYear()}/${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };
  const ids = await deps.g.searchMessageIds(`in:sent subject:"Please confirm your suggestion" after:${day(-1)} before:${day(2)}`, 50);
  const found = new Set();
  const want = `suggested ${name} for the ${label} page`;
  for (const mid of ids) {
    const m = await deps.g.getMessage(mid);
    if (lc(m.fromAddress) !== FROM || !String(m.text || '').includes(want)) continue;
    for (const part of String(m.recipients || '').split(',')) {
      const a = lc(deps.g.addressOf ? deps.g.addressOf(part) : part);
      if (a && a.includes('@')) found.add(a);
    }
  }
  return found.size === 1 ? [...found][0] : '';
}

async function run({ action, id, ms = Date.now(), dataDir = DATA_DIR, typed = null, stateFile = '' }, deps = { g, signToken }) {
  if (!['send', 'confirm', 'approve', 'approved', 'reject', 'thank', 'thanked'].includes(action)) throw new Error('ACTION must be send, confirm, approve, approved, reject, thank or thanked');
  const R = await rules();
  const byEntry = (action === 'thank' || action === 'thanked') ? String(id || '').match(/^(trades|eat):([a-z0-9-]{1,80})$/) : null;
  if (!byEntry && !R.SUGGEST_ID.test(String(id || ''))) throw new Error('SUGGEST_ID is missing or malformed');
  const TAB = R.SUGGEST_TAB;
  await deps.g.ensureTab(TAB, R.SUGGEST_HEADERS);
  const rows = await deps.g.readTable(TAB);
  const now = stamp(ms);
  const wiped = await tidy(deps, TAB, rows, ms);
  if (wiped) console.log(`${wiped} suggestion address(es) over ${KEEP_DAYS} days: wiped.`);

  const row = byEntry
    ? rows.find((r) => r.kind === byEntry[1] && str(r.entry) === byEntry[2] && lc(r.status) === 'approved')
    : rows.find((r) => str(r.id) === id);
  if (!row) { console.log('No Listing suggestions row has this id. Nothing to do.'); return 'missing'; }
  const status = lc(row.status);
  const kind = Object.prototype.hasOwnProperty.call(R.KINDS, row.kind) ? row.kind : '';
  if (!kind) { console.log('Row has no known page. Nothing to do.'); return 'skipped'; }

  if (action === 'send') {
    const email = lc(row.email);
    if (status !== 'new' || !email) { console.log(`Row is "${status}", not new. Nothing to do.`); return 'skipped'; }
    if (deps.signToken === signToken && !linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY and WORKER_URL are needed for the link');
    const { settings } = await deps.g.readSettings();
    const fromName = deps.g.fromNameFor(settings);
    const e = Math.floor(ms / 1000) + LINK_DAYS * 86400;
    const url = deps.signToken({ a: 'sug', i: id, k: kind, e }, '/sg');
    await deps.g.sendMail({ to: email, ...confirmEmail(str(row.name), R.KINDS[kind].label, url), from: FROM, fromName, headers: { 'Auto-Submitted': 'auto-generated' } });
    await deps.g.updateRow(TAB, row._row, { status: 'sent', sent_at: now });
    console.log('Confirmation email sent.');
    return 'sent';
  }

  if (action === 'confirm') {
    if (status !== 'sent') { console.log(`Row is "${status}", not awaiting confirmation. Nothing to do.`); return 'skipped'; }
    if (ageDays(row.sent_at, ms) > LINK_DAYS + 1) { console.log('Confirmation came after the link should have expired. Nothing done.'); return 'late'; }
    await deps.g.updateRow(TAB, row._row, { status: 'confirmed', confirmed_at: now });
    console.log('Confirmed: waiting on the panel\'s Suggestions screen.');
    return 'confirmed';
  }

  if (action === 'reject') {
    if (status !== 'confirmed') { console.log(`Row is "${status}", not waiting. Nothing to do.`); return 'skipped'; }
    const reason = str((typed || payloadText()).reason).replace(/\s+/g, ' ').slice(0, 300);
    await deps.g.updateRow(TAB, row._row, { status: 'rejected', decided_at: now, email: '', reject_reason: reason });
    console.log(`Rejected${reason ? ' (reason saved)' : ''}.`);
    return 'rejected';
  }

  if (action === 'thank' || action === 'thanked') {
    const entry = str(row.entry);
    if (status !== 'approved' || !entry || lc(row.result) !== 'added') { console.log(`Row is "${status}" / "${str(row.result)}": not an approved suggestion waiting for thanks. Nothing to do.`); return 'skipped'; }
    const k = R.KINDS[kind];
    const listed = (JSON.parse(fs.readFileSync(path.join(dataDir, k.file), 'utf8'))[k.list] || []).find((x) => x.id === entry);
    if (!listed) { console.log('Entry no longer listed. Nothing to do.'); return 'skipped'; }
    const email = await sentAddress(deps, row, k.label);
    if (!email) { console.log('Could not find exactly one confirmation email for this row. Nothing done.'); return 'notfound'; }
    if (action === 'thank') {
      await firstRecommendation(deps, kind, entry, email, ms, path.join(dataDir, 'recommends.json'));
      console.log('Recommendation counted.');
      return 'counted';
    }
    const { settings } = await deps.g.readSettings();
    await deps.g.sendMail({
      to: email, ...thanksEmail({ kind, name: listed.name, section: kind === 'eat' ? listed.area : listed.trade, page: k.page, anchor: anchorFor(kind, entry) }),
      from: FROM, fromName: deps.g.fromNameFor(settings), headers: { 'Auto-Submitted': 'auto-generated' },
    });
    await deps.g.updateRow(TAB, row._row, { result: 'added, thanked' });
    console.log('Thank-you email sent.');
    return 'thanked';
  }

  if (action === 'approve') {
    if (status !== 'confirmed') { console.log(`Row is "${status}", not waiting. Nothing to do.`); return 'skipped'; }
    const data = readData(dataDir, R);
    const body = str((typed || payloadText()).body);
    let fields;
    if (body) {
      try { fields = JSON.parse(body); } catch { throw new Error('The edited entry is not valid JSON'); }
    } else {
      fields = R.draftEntry(kind, row, data);
    }
    const c = R.cleanEntry(kind, fields, data);
    if (c.error) {
      await deps.g.updateRow(TAB, row._row, { result: `not added: ${c.error}` });
      throw new Error(`Entry refused: ${c.error}`);
    }
    const list = data[kind][R.KINDS[kind].list] || [];
    const entry = { id: listingId(c.entry.name, list.map((x) => x.id)), ...c.entry };
    const file = path.join(dataDir, R.KINDS[kind].file);
    fs.writeFileSync(file, `${JSON.stringify(R.insertEntry(kind, data, entry), null, 2)}\n`);
    const starred = await firstRecommendation(deps, kind, entry.id, row.email, ms, path.join(dataDir, 'recommends.json'));
    const section = kind === 'eat' ? entry.area : entry.trade;
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ id, entry: entry.id, kind, name: entry.name, section, starred }));
    console.log(`Entry ${entry.id} added to ${R.KINDS[kind].file}${body ? ' (as edited)' : ''}${starred ? ', with its first recommendation' : ''}.`);
    return 'added';
  }

  // approved: after the commit is pushed.
  if (status !== 'confirmed') { console.log(`Row is "${status}", not waiting. Nothing to do.`); return 'skipped'; }
  let st = {};
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s.id === id) st = s;
  } catch { st = {}; }
  const entry = String(st.entry || '');
  if (!entry) throw new Error('No new entry id from the approve step');
  let result = 'added';
  const email = lc(row.email);
  if (email && st.starred && st.name && st.section) {
    try {
      const { settings } = await deps.g.readSettings();
      const fromName = deps.g.fromNameFor(settings);
      const k = R.KINDS[kind];
      await deps.g.sendMail({
        to: email, ...thanksEmail({ kind, name: st.name, section: st.section, page: k.page, anchor: anchorFor(kind, entry) }),
        from: FROM, fromName, headers: { 'Auto-Submitted': 'auto-generated' },
      });
      result = 'added, thanked';
      console.log('Thank-you email sent.');
    } catch (err) {
      result = 'added, thanks not sent';
      console.log(`Thank-you email failed: ${err && err.message ? err.message : err}`);
    }
  } else {
    console.log('No thank-you email (no address or no recommendation).');
  }
  await deps.g.updateRow(TAB, row._row, { status: 'approved', decided_at: now, email: '', entry, result });
  console.log(`Marked approved (entry ${entry}).`);
  return 'approved';
}

module.exports = { run, confirmEmail, thanksEmail, LINK_DAYS, KEEP_DAYS };

if (require.main === module) {
  run({
    action: str(process.env.ACTION), id: str(process.env.SUGGEST_ID), stateFile: str(process.env.SUGGEST_STATE),
  }).catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
