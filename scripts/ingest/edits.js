// scripts/ingest/edits.js
// "Edit by email" for reply drafts (part 1, agreed 23 Oct). Part 2 added the Worker's edit
// form, which the action email's Edit button opens; this stays as the fallback (a draft too
// long for a link, or the "Edit by email" link). It opens a new email to Jon himself,
// subject "[Edit reply <reply_id>] ...", with Holly's draft as the body. Jon corrects the
// text and sends it; the next ingestion run finds it in Sent mail and sends the corrected
// text to the submitter in place of the draft (replies.applyEdit), if that reply is still
// awaiting a decision.
//   - Only Jon's own sent mail counts (Gmail "in:sent", SENT label, From GMAIL_USER), so
//     nobody else can trigger a send.
//   - Everything from the "### Edit above this line" marker down, quoted text and a mail
//     signature ("-- ") are dropped. An optional first line "Reason: ..." goes to the
//     Reply feedback tab, not to the submitter.
//   - Single use: once the reply has gone (or been rejected), later edit emails do nothing.
'use strict';

const g = require('./google');
const replies = require('./replies');

const SUBJECT_TAG = 'Edit reply';
const MARKER = '### Edit above this line. Everything below it is ignored. ###';
const LOOKBACK = '14d'; // matches the button expiry (links.js LINK_DAYS)
const ID_RE = /\[Edit reply ([A-Za-z0-9_-]{1,100})\]/;

function editSubject(row) {
  return `[${SUBJECT_TAG} ${row.reply_id}] ${row.subject || ''}`.trim();
}

// mailto: link for the action email.
function editLink(row, to) {
  const body = [
    row.body,
    '',
    MARKER,
    'Change the text above, then send this email to yourself. The next run (within the hour)',
    'sends your text to them instead of the draft. Optional: start with a line "Reason: ..."',
    'saying why you changed it (kept in the Reply feedback tab, never sent to them).',
  ].join('\n');
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(editSubject(row))}&body=${encodeURIComponent(body)}`;
}

// The corrected text and optional reason from Jon's email.
function parseEdit(text) {
  const lines = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('### Edit above this line') || /^-- ?$/.test(line)) break;
    lines.push(line);
  }
  let body = replies.stripQuoted(lines.join('\n'));
  let reason = '';
  const m = body.match(/^\s*reason:\s*(.*)(\r?\n|$)/i);
  if (m) {
    reason = m[1].trim().slice(0, 300);
    body = body.slice(m[0].length);
  }
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), reason };
}

// Each run, before sendDueReplies. Returns the number of edits sent.
async function applyEdits(settings) {
  if (replies.repliesMode(settings) !== 'live') return 0;
  const me = String(process.env.GMAIL_USER || '').trim().toLowerCase();
  const ids = (await g.searchMessageIds(`in:sent subject:"${SUBJECT_TAG}" newer_than:${LOOKBACK}`)).reverse();
  let sent = 0;
  for (const id of ids) {
    const msg = await g.getMessage(id);
    const m = String(msg.subject || '').match(ID_RE);
    if (!m || !msg.labelIds.includes('SENT') || msg.fromAddress !== me) continue;
    const { body, reason } = parseEdit(msg.text);
    if (body.length < 10) {
      console.warn(`Edit email ${id} for ${m[1]} has no text; ignored.`);
      continue;
    }
    if (await replies.applyEdit(m[1], body, reason)) sent += 1;
  }
  if (sent) console.log(`Edits: ${sent} edited reply(ies) sent.`);
  return sent;
}

module.exports = { applyEdits, editLink, parseEdit, editSubject, MARKER };
