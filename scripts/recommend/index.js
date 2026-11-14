// scripts/recommend/index.js
// Recommend buttons on Local trades and Where to eat (double opt-in, like the newsletter
// sign-up). recommend.yml runs this on repository_dispatch "recommend" from the Worker
// (worker/src/recommend.js):
//   send     the button saved a Recommendations row (status "new"). If this address has
//            already recommended that entry: one "already counted" email ("already").
//            Otherwise one confirmation email with a signed /r link lasting LINK_DAYS ("sent").
//   confirm  the reader pressed the button behind that link: the row is "counted" (or
//            "already" if another confirmed row got there first).
//   counts   rewrites src/_data/recommends.json ({ trades: { id: n }, eat: { id: n } }: one
//            per address per entry), which the workflow commits and builds.
// The address is wiped from a row as soon as it is counted or found to be a repeat, and
// from rows never confirmed within KEEP_DAYS ("expired"), as the privacy page says; the
// `key` column (a SHA-256 of the address, same as the Worker's) stays to stop repeats.
// Rows are found by id only. Never logs an address, entry or count: Actions logs are public.
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, APPROVAL_SIGNING_KEY, WORKER_URL, ACTION, RECOMMEND_ID.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const g = require('../ingest/google');
const { signToken, linksEnabled } = require('../ingest/links');
const { emailHtml, stamp, ageDays } = require('../signup');
const { KINDS } = require('../../lib/listings');

const TAB = 'Recommendations';
const HEADERS = ['id', 'requested', 'kind', 'entry', 'email', 'key', 'status', 'sent_at', 'confirmed_at', 'result'];
const FROM = 'website@thelenches.org.uk';
const LINK_DAYS = 7;
const KEEP_DAYS = 30;
const DATA_DIR = path.join(__dirname, '..', '..', 'src', '_data');
const COUNTS_FILE = path.join(DATA_DIR, 'recommends.json');

const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();

// Same as worker/src/recommend.js emailKey().
const emailKey = (email) => crypto.createHash('sha256').update(`lenches-recommend|${lc(email)}`).digest('hex').slice(0, 24);

function entryFor(kind, id, dataDir = DATA_DIR) {
  const k = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
  if (!k) return null;
  const list = JSON.parse(fs.readFileSync(path.join(dataDir, k.file), 'utf8'))[k.list] || [];
  const e = list.find((x) => x.id === id);
  return e ? { name: e.name, label: k.label } : null;
}

/* --------------------------------------------------------------- emails -- */

function confirmEmail(entry, url) {
  const paras = [
    'Hello,',
    `Someone, hopefully you, asked to recommend ${entry.name} on the ${entry.label} page of thelenches.org.uk.`,
    `This link works for ${LINK_DAYS} days. If you didn't ask, just ignore this email. We never show who recommended anyone.`,
  ];
  return {
    subject: 'Please confirm your recommendation: The Lenches website',
    html: emailHtml(paras.slice(0, 2), { text: 'Yes, count my recommendation', url }, paras.slice(2)),
    text: `${paras[0]}\n\n${paras[1]}\n\nYes, count my recommendation:\n${url}\n\n${paras[2]}\n\nthelenches.org.uk\n`,
  };
}

function alreadyEmail(entry) {
  const paras = [
    'Hello,',
    `Someone, hopefully you, asked to recommend ${entry.name} on the ${entry.label} page of thelenches.org.uk. You've already recommended this one, thank you, so there's nothing more to do.`,
    'If you didn\'t ask, you can ignore this email.',
  ];
  return {
    subject: 'Already counted: The Lenches website',
    html: emailHtml(paras, null),
    text: `${paras.join('\n\n')}\n\nthelenches.org.uk\n`,
  };
}

/* --------------------------------------------------------------- counts -- */

function countsFrom(rows) {
  const out = {};
  for (const kind of Object.keys(KINDS)) out[kind] = {};
  const seen = new Set();
  for (const r of rows) {
    if (lc(r.status) !== 'counted' || !out[r.kind] || !str(r.entry) || !str(r.key)) continue;
    const k = `${r.kind}|${r.entry}|${r.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out[r.kind][r.entry] = (out[r.kind][r.entry] || 0) + 1;
  }
  for (const kind of Object.keys(out)) {
    out[kind] = Object.fromEntries(Object.entries(out[kind]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

function writeCounts(rows, file = COUNTS_FILE) {
  const text = `${JSON.stringify(countsFrom(rows), null, 2)}\n`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (old === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

/* ------------------------------------------------------------------ run -- */

async function tidy(deps, rows, ms) {
  const old = rows.filter((r) => str(r.email) && ['new', 'sent', 'failed'].includes(lc(r.status)) && ageDays(r.requested, ms) > KEEP_DAYS);
  for (const r of old) await deps.g.updateRow(TAB, r._row, { email: '', status: 'expired' });
  return old.length;
}

async function run({ action, id, ms = Date.now(), dataDir = DATA_DIR, countsFile = COUNTS_FILE }, deps = { g, signToken }) {
  if (!['send', 'confirm', 'counts'].includes(action)) throw new Error('ACTION must be send, confirm or counts');
  await deps.g.ensureTab(TAB, HEADERS);
  const rows = await deps.g.readTable(TAB);

  if (action === 'counts') {
    const changed = writeCounts(rows, countsFile);
    console.log(changed ? 'Recommendation counts changed.' : 'Recommendation counts unchanged.');
    return changed ? 'changed' : 'unchanged';
  }

  if (!/^rc-\d{8}-[a-z0-9]{6}$/.test(id)) throw new Error('RECOMMEND_ID is missing or malformed');
  const now = stamp(ms);
  const tidied = await tidy(deps, rows, ms);
  if (tidied) console.log(`${tidied} unconfirmed recommendation(s) over ${KEEP_DAYS} days: address wiped.`);

  const row = rows.find((r) => str(r.id) === id);
  if (!row) { console.log('No Recommendations row has this id. Nothing to do.'); return 'missing'; }
  const status = lc(row.status);
  const key = str(row.key) || (str(row.email) ? emailKey(row.email) : '');
  const counted = rows.some((r) => r !== row && lc(r.status) === 'counted' && r.key === key && r.kind === row.kind && r.entry === row.entry);
  const entry = entryFor(row.kind, row.entry, dataDir);

  if (action === 'send') {
    const email = lc(row.email);
    if (status !== 'new' || !email) { console.log(`Row is "${status}", not new. Nothing to do.`); return 'skipped'; }
    if (!entry) {
      await deps.g.updateRow(TAB, row._row, { email: '', status: 'skipped', result: 'entry no longer listed' });
      console.log('Entry no longer listed: nothing sent.');
      return 'skipped';
    }
    const { settings } = await deps.g.readSettings();
    const fromName = deps.g.fromNameFor(settings);
    const headers = { 'Auto-Submitted': 'auto-generated' };
    if (counted) {
      await deps.g.sendMail({ to: email, ...alreadyEmail(entry), from: FROM, fromName, headers });
      await deps.g.updateRow(TAB, row._row, { email: '', key, status: 'already', sent_at: now, result: 'already counted' });
      console.log('Already counted: "already counted" email sent.');
      return 'already';
    }
    if (deps.signToken === signToken && !linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY and WORKER_URL are needed for the link');
    const e = Math.floor(ms / 1000) + LINK_DAYS * 86400;
    const url = deps.signToken({ a: 'rec', i: id, k: row.kind, n: row.entry, e }, '/r');
    await deps.g.sendMail({ to: email, ...confirmEmail(entry, url), from: FROM, fromName, headers });
    await deps.g.updateRow(TAB, row._row, { key, status: 'sent', sent_at: now });
    console.log('Confirmation email sent.');
    return 'sent';
  }

  // confirm
  if (status !== 'sent' || !key) { console.log(`Row is "${status}", not awaiting confirmation. Nothing to do.`); return 'skipped'; }
  if (ageDays(row.sent_at, ms) > LINK_DAYS + 1) {
    console.log('Confirmation came after the link should have expired. Nothing done.');
    return 'late';
  }
  if (counted) {
    await deps.g.updateRow(TAB, row._row, { email: '', status: 'already', confirmed_at: now, result: 'already counted' });
    console.log('Confirmed, but this address had already recommended this entry: not counted again.');
    return 'already';
  }
  await deps.g.updateRow(TAB, row._row, { email: '', status: 'counted', confirmed_at: now });
  console.log('Confirmed: recommendation counted.');
  return 'counted';
}

module.exports = { run, confirmEmail, alreadyEmail, countsFrom, writeCounts, emailKey, TAB, HEADERS, LINK_DAYS, KEEP_DAYS };

if (require.main === module) {
  run({ action: str(process.env.ACTION), id: str(process.env.RECOMMEND_ID) }).catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
