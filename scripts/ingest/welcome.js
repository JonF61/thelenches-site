// scripts/ingest/welcome.js
// Welcome-back digest (part 2, agreed 23 Oct). Every reply Holly sends herself while
// holiday mode is on is logged in the "Holiday log" tab (created at the end of the Sheet
// the first time it's needed). On the first ingestion run after holiday_mode goes back to
// FALSE, one email to Jon lists them all, oldest first, with a link to each conversation,
// plus a count of replies still waiting for his decision. Rows are stamped digested_at
// only after that email has gone, so a failed send is retried on the next run.
'use strict';

const g = require('./google');

const TAB = 'Holiday log';
const HEADERS = ['sent_at', 'reply_id', 'type', 'class', 'to', 'subject', 'body', 'message_id', 'digested_at'];
const TYPE_WORDS = {
  ack: 'Acknowledgement', clarify: 'Acknowledgement + question', holding: 'Holding reply',
  answer: 'Answer', whattodo: '"What would you like us to do?"', list: 'Newsletter list',
};
const C = { green: '#3F5233', cream: '#F6F1E4', grey: '#666666' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const gmailLink = (id) => (id ? `https://mail.google.com/mail/u/0/#all/${id}` : '');

// replies.sendDueReplies, after each send in holiday mode. Never stops a send: only warns.
async function logHolidaySend(row, sentAt) {
  try {
    await g.ensureTab(TAB, HEADERS);
    await g.appendRows(TAB, [{
      sent_at: sentAt, reply_id: row.reply_id, type: row.type, class: row.class || '', to: row.to,
      subject: row.subject, body: row.body, message_id: row.message_id,
    }]);
  } catch (err) {
    console.warn(`Holiday log: ${row.reply_id} not logged: ${(err && err.message) || err}`);
  }
}

function buildHtml(rows, waiting, sheetUrl) {
  const cards = rows.map((r) => `
<tr><td style="padding:0 0 14px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #d8d2c2;">
    <tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;font-size:14px;line-height:1.45;">
      <div style="font-weight:bold;color:${C.green};font-size:15px;">${esc(TYPE_WORDS[r.type] || r.type)} to ${esc(r.to)}</div>
      <div style="color:${C.grey};font-size:13px;margin-bottom:8px;">${esc(r.sent_at)} · ${esc(r.subject)}${r.class ? ` · ${esc(r.class)}` : ''}</div>
      <div style="white-space:pre-wrap;background:${C.cream};border-radius:6px;padding:10px 12px;">${esc(r.body)}</div>
      ${r.message_id ? `<div style="margin-top:6px;"><a href="${esc(gmailLink(r.message_id))}" style="color:${C.green};">Their email and our reply</a></div>` : ''}
    </td></tr>
  </table>
</td></tr>`).join('');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};">
  <tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;">
        <div style="font-size:22px;font-weight:bold;color:${C.green};">Welcome back</div>
        <div style="margin-top:6px;font-size:15px;">Holly sent ${rows.length} repl${rows.length === 1 ? 'y' : 'ies'} while holiday mode was on, listed below oldest first.
        ${waiting ? `<b>${waiting} more ${waiting === 1 ? 'is' : 'are'} waiting for your decision</b> (complaints and other held emails, and anything over the limits): see the action emails or the <a href="${esc(sheetUrl)}" style="color:${C.green};">Replies tab</a>.` : 'Nothing is waiting for your decision.'}</div>
      </td></tr>
      ${cards}
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildText(rows, waiting, sheetUrl) {
  const out = ['Welcome back', '', `Holly sent ${rows.length} reply(ies) while holiday mode was on, oldest first.`];
  out.push(waiting ? `${waiting} more waiting for your decision: ${sheetUrl}` : 'Nothing is waiting for your decision.', '');
  for (const r of rows) {
    out.push(`${TYPE_WORDS[r.type] || r.type} to ${r.to}, ${r.sent_at}: ${r.subject}${r.class ? ` [${r.class}]` : ''}`, '---', r.body, '---');
    if (r.message_id) out.push(gmailLink(r.message_id));
    out.push('');
  }
  return out.join('\n');
}

// Each ingestion run with holiday mode off. Returns the number of replies digested.
async function sendWelcomeBack(settings) {
  let rows;
  try {
    rows = await g.readTable(TAB);
  } catch {
    return 0; // no tab yet: nothing was ever sent in holiday mode
  }
  const due = rows.filter((r) => r.reply_id && !String(r.digested_at || '').trim());
  if (!due.length) return 0;
  const replies = await g.readTable('Replies').catch(() => []);
  const waiting = replies.filter((r) => r.reply_id && r.status === 'awaiting').length;
  const gid = await g.getSheetGid('Replies');
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${g.spreadsheetId()}/edit${gid === null ? '' : `#gid=${gid}`}`;
  const id = await g.sendMail({
    to: process.env.ALERT_TO || process.env.GMAIL_USER,
    subject: `Welcome back: ${due.length} repl${due.length === 1 ? 'y' : 'ies'} sent while you were away (Lenches)`,
    text: buildText(due, waiting, sheetUrl),
    html: buildHtml(due, waiting, sheetUrl),
    fromName: g.fromNameFor(settings),
  });
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(Date.now());
  for (const r of due) await g.updateRow(TAB, r._row, { digested_at: stamp });
  console.log(`Welcome-back digest sent: ${due.length} reply(ies), ${waiting} waiting. Gmail id ${id}.`);
  return due.length;
}

module.exports = { logHolidaySend, sendWelcomeBack, TAB, HEADERS };
