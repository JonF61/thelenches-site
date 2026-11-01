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
// Rejecting an item whose acknowledgement said it was on its way drafts a "sorry, we
// couldn't use it after all" reply for Jon's Approve/Edit/Reject (replies.planSorry).
// Replayed or duplicate clicks therefore do nothing.
'use strict';

const g = require('../ingest/google');
const replies = require('../ingest/replies');
const trust = require('../ingest/trusted');
const { sendReplyCard } = require('../ingest/urgent');
const readerFeedback = require('../readerfeedback');
const outreach = require('../outreach');
const orgs = require('../outreach/orgs');
const contactMail = require('../outreach/contactmail');
const lessons = require('../lessons');

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

async function decideItem(id, action) {
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
  if (!['send', 'skip', 'close', 'edit', 'lesson_ok', 'lesson_no', 'orgcheck', 'done'].includes(action)) await replies.primeLearning();

  if (ITEM_ACTIONS.includes(action)) return decideItem(id, action);
  if (action === 'trust') return trustSource(id);
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

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
