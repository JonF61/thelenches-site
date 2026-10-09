// scripts/newsletter/index.js
// Builds the weekly issue "The Lenches Newsletter" and sends ONLY:
//   - a test copy, exactly as subscribers would see it, to Settings test_to
//   - a preview copy (banner with signed Send / Rebuild / Approve / Reject buttons, then
//     the issue) to Settings preview_to
// Nothing goes to subscribers from this script; the Send button runs send.js.
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, APPROVAL_SIGNING_KEY, WORKER_URL; optional
// ISSUE_DATE (YYYY-MM-DD, default the coming Thursday, UK time) and SHADOW ("true" marks
// the issue "shadow", which counts like "sent" for the appearance limits).
// Deadline: Pending items received after Wednesday 18:00 UK are held for next week,
// unless this run came from the Rebuild button (client_payload.rebuild), which lets
// late items in deliberately.
// Frozen content: the selected issue is saved (deflated JSON, base64) in the Issues
// "snapshot" column. send.js sends exactly that, so nothing ingested, published or
// edited after the build changes the issue; only a Rebuild does.
// Issues tab: one row per issue; a rebuild of the same issue updates its row.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const g = require('../ingest/google');
const { select, deadlineFor } = require('./select');
const { render, wrapPreview } = require('./render');
const { personalise, forPreview } = require('./unsub');
const { buttons } = require('./actions');

const TZ = 'Europe/London';
const ROOT = path.join(__dirname, '..', '..');
const SITE = 'https://thelenches.org.uk';
const FROM = 'website@thelenches.org.uk';
const SNAPSHOT_MAX = 45000; // a Sheets cell holds 50,000 characters
// Hard limits: a Sheet edit can never point a test or preview at anyone else.
const TEST_ALLOWED = ['jon@alphaquad.co.uk'];
const PREVIEW_ALLOWED = ['jon@thelenches.org.uk'];

const str = (v) => String(v ?? '').trim();
const londonDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);

function comingThursday(today) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((4 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// client_payload of the repository_dispatch that started this run ({} otherwise).
function dispatchPayload() {
  try {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    return (ev && ev.client_payload) || {};
  } catch {
    return {};
  }
}

// Absolute URL of the JPEG copy publish.js makes, or '' if it isn't in the repo yet
// (the item then goes out text only).
function jpegFor(webpUrl) {
  const rel = webpUrl.replace(/\.webp$/, '.jpg');
  return fs.existsSync(path.join(ROOT, 'src', rel)) ? `${SITE}${rel}` : '';
}

function recipient(value, allowed, name) {
  const addr = str(value || allowed[0]).toLowerCase();
  if (!allowed.includes(addr)) throw new Error(`${name} "${addr}" is not allowed (allowed: ${allowed.join(', ')})`);
  return addr;
}

// Same guard as replies.js: website@ must be a Send-mail-as address, and Gmail
// must not have rewritten the From on the sent message.
async function assertSendAs() {
  const allowed = await g.sendAsAddresses();
  if (!allowed.includes(FROM)) throw new Error(`${FROM} is not a "Send mail as" address on ${process.env.GMAIL_USER}; nothing sent`);
}

async function sendChecked(opts) {
  const id = await g.sendMail({ ...opts, from: FROM });
  const check = await g.getMessage(id);
  if (check.fromAddress !== FROM) throw new Error(`Gmail rewrote From to ${check.fromAddress} (message ${id}): stopping`);
  return id;
}

async function main() {
  const today = londonDate(Date.now());
  const issueDate = str(process.env.ISSUE_DATE) || comingThursday(today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error(`ISSUE_DATE must be YYYY-MM-DD, got "${issueDate}"`);
  const shadow = /^true$/i.test(str(process.env.SHADOW));
  const rebuild = dispatchPayload().rebuild === true;
  const cutoff = rebuild ? '' : deadlineFor(issueDate);

  const [{ sources, settings }, pending, issues, subscribers, dns] = await Promise.all([
    g.readSettings(), g.readTable('Pending'), g.readTable('Issues'),
    g.readTable('Subscribers'), g.readTable('Do Not Send'),
  ]);
  const testTo = recipient(settings.test_to, TEST_ALLOWED, 'test_to');
  const previewTo = recipient(settings.preview_to, PREVIEW_ALLOWED, 'preview_to');

  const existing = issues.filter((r) => str(r.issue_id) === issueDate);
  if (existing.some((r) => ['sent', 'sending'].includes(str(r.status).toLowerCase()))) {
    throw new Error(`Issue ${issueDate} has already been sent (or is sending); not rebuilding`);
  }

  const model = select({
    issueDate, pending, issues, settings, sources, jpegFor, cutoff,
    whatson: readJson('src/_data/whatson.json'),
    bins: readJson('src/_data/bins.json'),
    siteupdates: readJson('src/_data/siteupdates.json'),
  });
  const issue = render(model);
  console.log(`Issue ${issueDate}: ${model.keys.length} items (${model.events.length} events, ${model.news.length} news, `
    + `${model.notices.length} notices, ${model.roads.length} roads, ${model.elsewhere.length} elsewhere, ${(model.siteUpdates || []).length} site updates), `
    + `${model.imageKeys.length} images, hash ${issue.hash.slice(0, 12)}${model.holiday ? ', holiday mode' : ''}.`);
  console.log(cutoff
    ? `Deadline ${cutoff} UK: ${model.held} late item(s) held for next week (Rebuild lets them in).`
    : 'Rebuild: no deadline cutoff, late items included.');
  if (model.empty) console.warn('Warning: the issue is empty.');

  const snapshot = zlib.deflateSync(Buffer.from(JSON.stringify(model), 'utf8'), { level: 9 }).toString('base64');
  if (snapshot.length > SNAPSHOT_MAX) throw new Error(`Content snapshot is ${snapshot.length} characters, over the ${SNAPSHOT_MAX} limit for one Sheet cell`);
  const cutoffNote = cutoff ? `deadline ${cutoff}${model.held ? `, ${model.held} held` : ''}` : 'rebuild: no deadline';

  const fields = {
    issue_id: issueDate,
    issue_date: issueDate,
    kind: 'weekly',
    status: 'built',
    content_hash: issue.hash,
    item_keys: model.keys.join(' '),
    image_keys: model.imageKeys.join(' '),
    item_count: model.keys.length,
    subject: issue.subject,
    built_at: new Date().toISOString(),
    tested_at: '',
    snapshot,
    notes: [model.holiday ? 'holiday mode' : '', model.empty ? 'EMPTY' : '', cutoffNote].filter(Boolean).join('; '),
  };
  if (existing.length) {
    await g.updateRow('Issues', existing[existing.length - 1]._row, fields);
  } else {
    await g.appendRows('Issues', [fields]);
  }
  // Read back: the row must exist and hold the snapshot (updateRow skips unknown headers).
  const again = (await g.readTable('Issues')).filter((r) => str(r.issue_id) === issueDate);
  if (!again.length) throw new Error('Issues row not found after writing: check the Issues tab headers');
  const written = again[again.length - 1];
  const rowNumber = written._row;
  if (str(written.snapshot) !== snapshot) {
    await g.updateRow('Issues', rowNumber, { status: 'failed', notes: 'failed: snapshot not saved (Issues needs a "snapshot" header)' });
    throw new Error('Content snapshot was not saved: add the header "snapshot" to the Issues tab (column Q)');
  }

  try {
    await assertSendAs();
    const fromName = g.fromNameFor(settings);
    const test = personalise(issue, testTo);
    await sendChecked({
      to: testTo, subject: issue.subject, html: test.html, text: test.text, fromName,
      headers: { ...test.headers, 'Auto-Submitted': 'auto-generated', Precedence: 'bulk' },
    });
    console.log(`Test copy sent to ${testTo}.`);

    const status = shadow ? 'shadow' : 'tested';
    const actions = buttons({ issueDate, hash: issue.hash, settings, subscribers, dns, pending });
    const preview = wrapPreview(forPreview(issue), { testTo, status, ...actions });
    await sendChecked({
      to: previewTo, subject: preview.subject, html: preview.html, text: preview.text, fromName,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    console.log(`Preview sent to ${previewTo}${actions.send ? ` (button: ${actions.send.label})` : ' (no Send button)'}.`);

    await g.updateRow('Issues', rowNumber, {
      status,
      tested_at: new Date().toISOString(),
      notes: [fields.notes, `test ${testTo}`, `preview ${previewTo}`].filter(Boolean).join('; '),
    });
    console.log(`Issues row ${rowNumber}: ${status}.`);
  } catch (err) {
    await g.updateRow('Issues', rowNumber, {
      status: 'failed',
      notes: `failed: ${String((err && err.message) || err)}`.slice(0, 300),
    });
    throw err;
  }
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
