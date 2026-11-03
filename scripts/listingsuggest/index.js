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
//   approved  marks the row "approved" (decided_at, entry = the new id) and wipes the address.
//   reject    decide() sug_no: "rejected", Jon's optional reason (event file) in reject_reason,
//             address wiped. Nothing is ever sent back to the suggester.
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
const { listingId } = require('../../lib/listings');

const FROM = 'website@thelenches.org.uk';
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

async function run({ action, id, ms = Date.now(), dataDir = DATA_DIR, typed = null, stateFile = '' }, deps = { g, signToken }) {
  if (!['send', 'confirm', 'approve', 'approved', 'reject'].includes(action)) throw new Error('ACTION must be send, confirm, approve, approved or reject');
  const R = await rules();
  if (!R.SUGGEST_ID.test(String(id || ''))) throw new Error('SUGGEST_ID is missing or malformed');
  const TAB = R.SUGGEST_TAB;
  await deps.g.ensureTab(TAB, R.SUGGEST_HEADERS);
  const rows = await deps.g.readTable(TAB);
  const now = stamp(ms);
  const wiped = await tidy(deps, TAB, rows, ms);
  if (wiped) console.log(`${wiped} suggestion address(es) over ${KEEP_DAYS} days: wiped.`);

  const row = rows.find((r) => str(r.id) === id);
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
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ id, entry: entry.id }));
    console.log(`Entry ${entry.id} added to ${R.KINDS[kind].file}${body ? ' (as edited)' : ''}.`);
    return 'added';
  }

  // approved: after the commit is pushed.
  if (status !== 'confirmed') { console.log(`Row is "${status}", not waiting. Nothing to do.`); return 'skipped'; }
  let entry = '';
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s.id === id) entry = String(s.entry || '');
  } catch { entry = ''; }
  if (!entry) throw new Error('No new entry id from the approve step');
  await deps.g.updateRow(TAB, row._row, { status: 'approved', decided_at: now, email: '', entry, result: 'added' });
  console.log(`Marked approved (entry ${entry}).`);
  return 'approved';
}

module.exports = { run, confirmEmail, LINK_DAYS, KEEP_DAYS };

if (require.main === module) {
  run({
    action: str(process.env.ACTION), id: str(process.env.SUGGEST_ID), stateFile: str(process.env.SUGGEST_STATE),
  }).catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
