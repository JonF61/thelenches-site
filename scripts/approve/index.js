// scripts/approve/index.js
// Applies one button click, sent by the Cloudflare Worker via repository_dispatch.
//   approve / reject  Pending items. Only rows still "pending" change.
//   done              Pending item dealt with already (panel only): status "done", no sorry note.
//   approve_own / approve_rewrite
//                     Approve, publishing the submitter's own wording or our rewrite
//                     (Pending "wording" column, lib/wording.js). Same rule as approve.
//   trust             "Trust this source" (daily approvals email): adds the item's sender
//                     address or feed URL to the Trusted tab (once), then approves that
//                     item as "approve" does. Never touches the source's other items.
//   send / skip       Replies (Replies tab): the Approve and Reject buttons. Only rows still
//                     "awaiting" change; Approve sends the body cell as it is now (see
//                     scripts/ingest/replies.js). REASON (optional, typed on the Reject
//                     page) goes to the Reply feedback tab.
//   edit              The Worker's edit form (part 2): sends BODY, Jon's edited text, in place
//                     of the draft, if the reply is still awaiting (replies.applyEdit).
//   redraft           Redraft (23 Oct): REASON is what Jon wants changed (required). Holly
//                     writes a new draft (replies.redraftReply), closes the old one, and a
//                     fresh card is emailed to Jon (urgent.sendReplyCard). Needs
//                     ANTHROPIC_API_KEY, WORKER_URL and APPROVAL_SIGNING_KEY in approval.yml.
//   close             "Close, no reply needed" on an email still owed a reply
//                     (replies.closeOwed). Nothing is sent.
//   fb_approve, fb_reject (REASON = optional why), fb_postpone (REASON = the date),
//   fb_done, fb_send, fb_edit (BODY), fb_skip
//                     Reader feedback (Feedback tab), admin panel only: see
//                     scripts/readerfeedback. fb_done and fb_reject draft Holly's reply.
//   lesson_ok / lesson_no
//                     Holly's weekly lessons email (scripts/lessons): approve or reject one
//                     proposed lesson (Holly lessons tab). Only "proposed" rows change.
//   nudge             Draft nudge (admin panel Outreach, 26 Oct): ID is "c" + a hash of a
//                     contact's address. Holly drafts an outreach email (scripts/outreach) as
//                     an awaiting Replies row and a card is emailed to Jon. Nothing is sent.
//   contactmail       Draft email (admin panel, a contact's page, 1 Nov): ID as for nudge,
//                     REASON is Jon's brief. Holly drafts an email from it (scripts/outreach/
//                     contactmail.js) as an awaiting Replies row and a card is emailed to Jon.
//                     Nothing is sent.
//   orgcheck          Draft check / Draft chaser (admin panel Contacts > Organisations, 27 Oct):
//                     ID is an organisation's slug in contacts.json `outreach`. Holly's fixed
//                     check (or chaser) email is drafted (scripts/outreach/orgs.js) as an
//                     awaiting Replies row and a card is emailed to Jon. Nothing is sent.
//   merge             Add details (admin panel only, 3 Nov): the item is already listed
//                     (Pending `duplicate`, ingest/duplicates.js). BODY is JSON of the details
//                     to add to the existing entry, as Jon left them in the panel: body,
//                     link_text/link_url, link2_text/link2_url. A hand-written item's file in
//                     src/items/ is rewritten (approval.yml commits it and starts the build); a
//                     pipeline or waiting item's Pending row gets the new values (publish
//                     rebuilds the site from it). An official entry's wording is never changed.
//                     This item becomes "done". Nothing is sent to anyone.
// Every item decision also completes its Item feedback row (ingest/itemfeedback.js): what Jon
// changed in Holly's write-up before approving, for her lessons and the stage 2 stats.
// Rejecting an item whose acknowledgement said it was on its way drafts a "sorry, we
// couldn't use it after all" reply for Jon's Approve/Edit/Reject (replies.planSorry).
// Replayed or duplicate clicks therefore do nothing.
'use strict';

const g = require('../ingest/google');
const replies = require('../ingest/replies');
const trust = require('../ingest/trusted');
const itemFeedback = require('../ingest/itemfeedback');
const { sendReplyCard } = require('../ingest/urgent');
const readerFeedback = require('../readerfeedback');
const outreach = require('../outreach');
const orgs = require('../outreach/orgs');
const contactMail = require('../outreach/contactmail');
const lessons = require('../lessons');
const dupes = require('../ingest/duplicates');
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/London';
const WORDING = { approve_own: 'own', approve_rewrite: 'rewrite' };
const ITEM_ACTIONS = ['approve', 'reject', 'done', ...Object.keys(WORDING)];

function londonDateTime(ms) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${date} ${time}`;
}

async function decideItem(id, action, reason = '') {
  const rows = await g.readTable('Pending');
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`Item ${id} not found in Pending`);

  if (row.status !== 'pending') {
    console.log(`Item ${id} is already "${row.status}"; nothing to do.`);
    return;
  }

  // done (1 Nov, panel only): Jon dealt with it another way (e.g. already on the site), so
  // nothing publishes and no "sorry" note goes; Contributions shows it as done, not rejected.
  const status = action === 'reject' ? 'rejected' : action === 'done' ? 'done' : 'approved';
  const fields = { status, decided_at: londonDateTime(Date.now()) };
  // Reject's optional reason (panel, 3 Nov): Pending reject_reason, for Previous submissions only.
  // Never logged (logs may be public) and never in the sorry note.
  if (status === 'rejected' && reason) {
    if ('reject_reason' in row) fields.reject_reason = reason;
    else console.warn('Pending has no "reject_reason" column; the reason was not saved.');
  }
  const wording = WORDING[action];
  if (wording) {
    if (!('wording' in row)) {
      // Approve anyway: refusing would lose the click. The default wording applies.
      console.warn('Pending has no "wording" column; approved with the default wording.');
    } else if (wording === 'own' && !String(row.own_text || '').trim()) {
      console.warn('No own_text on this row; approved with the rewrite.');
      fields.wording = 'rewrite';
    } else {
      fields.wording = wording;
    }
  }
  await g.updateRow('Pending', row._row, fields);
  // Item feedback (stage 1): approved as written, edited first, rejected or done. Never fails the decision.
  await itemFeedback.resolve(row, action, { wording: fields.wording || '', decidedAt: fields.decided_at });
  console.log(`Item ${id} marked ${status}${fields.wording ? ` (${fields.wording} wording)` : ''}.`);
  if (status === 'rejected') {
    // The rejection is recorded either way; a failed draft only fails the run (GitHub emails Jon).
    try {
      await replies.planSorry(row);
    } catch (err) {
      console.error(`Sorry note not drafted: ${(err && err.message) || err}`);
      process.exitCode = 1;
    }
  }
}

// Add details: Jon's fields (JSON) -> { body?, link_text?, link_url?, link2_text?, link2_url? }
// (pure). Links must be http(s); a link without its address is dropped.
function mergeFields(json) {
  let o = {};
  try { o = JSON.parse(String(json || '')); } catch { o = {}; }
  if (!o || typeof o !== 'object') o = {};
  const out = {};
  const clean = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  const body = clean(o.body, 2000);
  if (body) out.body = body;
  for (const k of ['link', 'link2']) {
    const url = clean(o[`${k}_url`], 500).replace(/\s+/g, '');
    if (/^https?:\/\/\S+$/i.test(url)) {
      out[`${k}_url`] = url;
      out[`${k}_text`] = clean(o[`${k}_text`], 80).replace(/\s+/g, ' ') || 'More details';
    }
  }
  return out;
}

const HAND_KEY = /^h:(events|notices)\/([a-z0-9][a-z0-9-]*\.json)$/;

// Writes the details into the existing entry. Returns a short description of what changed.
async function applyDetails(dup, fields, pending, itemsDir = dupes.ITEMS) {
  const hand = HAND_KEY.exec(dup.key);
  if (hand) {
    const file = path.join(itemsDir, hand[1], hand[2]);
    if (!fs.existsSync(file)) throw new Error(`The listed item ${hand[1]}/${hand[2]} no longer exists`);
    const item = JSON.parse(fs.readFileSync(file, 'utf8'));
    const changed = [];
    if (fields.body && !item.official && fields.body !== item.body) { item.body = fields.body; changed.push('text'); }
    for (const k of ['link', 'link2']) {
      if (fields[`${k}_url`]) { item[k] = { text: fields[`${k}_text`], url: fields[`${k}_url`] }; changed.push(k === 'link' ? 'link' : 'second link'); }
    }
    if (changed.length) fs.writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`);
    return changed;
  }
  const m = /^p:([A-Za-z0-9_:.-]{1,100})$/.exec(dup.key);
  if (!m) throw new Error(`Bad listed-item key "${dup.key}"`);
  const target = pending.find((r) => r.id === m[1]);
  if (!target) throw new Error(`The listed item ${m[1]} is no longer in Pending`);
  const official = /^(true|yes|y|1)$/i.test(String(target.official || '').trim());
  const update = {};
  if (fields.body && !official) update.summary = fields.body;
  for (const f of ['link_text', 'link_url', 'link2_text', 'link2_url']) if (fields[f]) update[f] = fields[f];
  if (Object.keys(update).length) await g.updateRow('Pending', target._row, update);
  return Object.keys(update).map((f) => ({ summary: 'text', link_url: 'link', link2_url: 'second link' }[f])).filter(Boolean);
}

async function mergeItem(id, json) {
  const rows = await g.readTable('Pending');
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`Item ${id} not found in Pending`);
  if (row.status !== 'pending') {
    console.log(`Item ${id} is already "${row.status}"; nothing to do.`);
    return;
  }
  const dup = dupes.parse(row.duplicate);
  if (!dup) throw new Error(`Item ${id} isn't marked as already listed`);
  const fields = mergeFields(json);
  const changed = Object.keys(fields).length ? await applyDetails(dup, fields, rows) : [];
  const decidedAt = londonDateTime(Date.now());
  await g.updateRow('Pending', row._row, {
    status: 'done', decided_at: decidedAt,
    notes: [row.notes, changed.length ? `Details added to "${dup.title}" (${changed.join(', ')})` : `Nothing new added to "${dup.title}"`].filter(Boolean).join(' | '),
  });
  await itemFeedback.resolve(row, 'merge', { decidedAt, merged: fields });
  console.log(`Item ${id} done: ${changed.length ? `${changed.join(', ')} added to ${dup.key.startsWith('h:') ? 'a hand-written item' : 'a pipeline item'}` : 'nothing changed'}.`);
}

async function trustSource(id) {
  const [rows, { sources }] = await Promise.all([g.readTable('Pending'), g.readSettings()]);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`Item ${id} not found in Pending`);
  const src = trust.sourceKeyFor(row, sources);
  if (!src) throw new Error(`Item ${id} has no trustable source (not Gmail or a Settings feed)`);
  const added = await trust.addTrusted(src, id, londonDateTime(Date.now()));
  // A sender's address and name stay out of the log (may be public); a feed is public.
  const who = src.type === 'feed' ? `feed ${src.key} (${src.label})` : `the sender of item ${id}`;
  console.log(added ? `Trusted ${who}.` : `${who[0].toUpperCase()}${who.slice(1)} was already trusted.`);
  await decideItem(id, 'approve');
}

// Jon's typed text (reason, edited body) comes from the event file, never env: a step's env
// is printed in the public Actions log (1 Nov). Env REASON / BODY still work for local runs.
function payloadText() {
  let p = {};
  if (process.env.GITHUB_EVENT_PATH) {
    try { p = JSON.parse(require('fs').readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).client_payload || {}; } catch { p = {}; }
  }
  return {
    reason: String(p.reason ?? process.env.REASON ?? ''),
    body: String(p.body ?? process.env.BODY ?? ''),
  };
}

async function main() {
  const id = String(process.env.ITEM_ID || '').trim();
  const action = String(process.env.ACTION || '').trim();
  const typed = payloadText();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`Bad id "${id}"`);
  // Holly's lessons and recent corrections, for any draft this action leads to.
  if (!['send', 'skip', 'close', 'edit', 'lesson_ok', 'lesson_no', 'orgcheck', 'done', 'merge'].includes(action)) await replies.primeLearning();

  if (ITEM_ACTIONS.includes(action)) {
    return decideItem(id, action, action === 'reject' ? String(typed.reason).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300) : '');
  }
  if (action === 'trust') return trustSource(id);
  if (action === 'merge') return mergeItem(id, typed.body);
  if (action.startsWith('fb_')) {
    return readerFeedback.decide(id, action, String(typed.reason).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300),
      String(typed.body).replace(/\r\n?/g, '\n').trim().slice(0, 3000));
  }
  const reason = String(typed.reason).replace(/[\u0000-\u001f]+/g, ' ').trim()
    .slice(0, action === 'redraft' ? 500 : action === 'contactmail' ? 600 : 300);
  if (['send', 'skip'].includes(action)) return replies.decideReply(id, action, reason);
  if (action === 'redraft') {
    const fresh = await replies.redraftReply(id, reason);
    if (!fresh) return undefined;
    const { settings } = await g.readSettings();
    // The redraft is saved either way; a failed card only fails the run (GitHub emails
    // Jon) and the next ingestion run's action email shows the draft.
    try {
      await sendReplyCard(fresh.reply_id, settings);
    } catch (err) {
      console.error(`Redraft card not sent: ${(err && err.message) || err}`);
      process.exitCode = 1;
    }
    return undefined;
  }
  if (action === 'close') return replies.closeOwed(id);
  if (action === 'lesson_ok' || action === 'lesson_no') return lessons.decide(id, action);
  if (action === 'nudge' || action === 'orgcheck' || action === 'contactmail') {
    const fresh = action === 'nudge' ? await outreach.draftNudge(id)
      : action === 'contactmail' ? await contactMail.draftContactEmail(id, reason) : await orgs.draftOrgCheck(id);
    if (!fresh || fresh.status !== 'awaiting') return undefined;
    const { settings } = await g.readSettings();
    const title = action === 'nudge' ? 'Outreach draft' : action === 'contactmail' ? 'Email draft' : 'Organisation check draft';
    // The draft is saved either way; a failed card only fails the run (GitHub emails Jon)
    // and the next ingestion run's action email shows the draft.
    try {
      await sendReplyCard(fresh.reply_id, settings, { title, subject: `${title} ready: ${fresh.subject} (Lenches)` });
    } catch (err) {
      console.error(`Outreach card not sent: ${(err && err.message) || err}`);
      process.exitCode = 1;
    }
    return undefined;
  }
  if (action === 'edit') {
    const body = String(typed.body).replace(/\r\n?/g, '\n').trim();
    if (body.length < 10) throw new Error('Edit has no text (no body in the dispatch payload?)');
    return replies.applyEdit(id, body, reason);
  }
  throw new Error(`Bad action "${action}"`);
}

if (require.main !== module) {
  module.exports = { mergeFields, applyDetails, mergeItem, HAND_KEY };
} else main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
