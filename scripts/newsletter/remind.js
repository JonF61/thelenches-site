// scripts/newsletter/remind.js
// Step 5b part 3: Thursday 12:00 and 17:00 reminders (fired by the Worker cron).
// Emails Settings preview_to only if this week's issue still needs Jon:
//   tested               not sent yet: Send / Rebuild / Approve buttons again
//   built, failed, none  the build didn't finish: Rebuild button
// Silent when sent, sending, shadow or aborted, when newsletter_mode is off, and in
// holiday mode (the 08:00 auto-send covers that).
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, APPROVAL_SIGNING_KEY, WORKER_URL; ISSUE_DATE
// (default today, UK).
'use strict';

const g = require('../ingest/google');
const { buttons } = require('./actions');
const { actionsBlock, dateParts } = require('./render');

const TZ = 'Europe/London';
const PREVIEW_ALLOWED = ['jon@thelenches.org.uk'];
const TRUE = /^(true|yes|y|on|1)$/i;

const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();
const londonDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main() {
  const issueDate = str(process.env.ISSUE_DATE) || londonDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error(`ISSUE_DATE must be YYYY-MM-DD, got "${issueDate}"`);

  const [{ settings }, pending, issues, subscribers, dns] = await Promise.all([
    g.readSettings(), g.readTable('Pending'), g.readTable('Issues'),
    g.readTable('Subscribers'), g.readTable('Do Not Send'),
  ]);
  const mode = lc(settings.newsletter_mode) || 'off';
  if (mode === 'off') { console.log('newsletter_mode is off: no reminder.'); return; }
  if (TRUE.test(str(settings.holiday_mode))) { console.log('Holiday mode: no reminder.'); return; }

  const row = issues.filter((r) => str(r.issue_id) === issueDate).pop();
  const status = row ? lc(row.status) : '';
  if (['sent', 'sending', 'shadow', 'aborted'].includes(status)) {
    console.log(`Issue ${issueDate} is ${status}: no reminder.`);
    return;
  }

  const to = (str(settings.preview_to) || PREVIEW_ALLOWED[0]).toLowerCase();
  if (!PREVIEW_ALLOWED.includes(to)) throw new Error(`preview_to "${to}" is not allowed`);

  const tested = status === 'tested';
  const b = buttons({ issueDate, hash: tested ? str(row.content_hash) : '', settings, subscribers, dns, pending });
  const block = actionsBlock(b);
  const when = dateParts(issueDate).subject;
  const headline = tested
    ? `The newsletter for ${when} hasn't been sent yet.`
    : `The newsletter for ${when} didn't finish building (status: ${status || 'no Issues row'}).`;
  const subject = tested ? `[Reminder] Newsletter for ${when} not sent yet` : `[Reminder] Newsletter for ${when} needs a rebuild`;
  const html = '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"></head>'
    + '<body style="margin:0;padding:16px;background:#F6F1E4;">'
    + '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:2px solid #C0703A;padding:14px 18px;'
    + 'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#2E2A1F;">'
    + `<div style="font-size:15px;font-weight:bold;color:#9A5312;">${esc(headline)}</div>`
    + (tested ? '<div>The test copy and preview went out this morning; the buttons below are the same.</div>' : '')
    + block.html
    + '</div></body></html>';
  const text = `${headline}\n\n${block.text}\n`;

  await g.sendMail({
    to, subject, html, text, fromName: g.fromNameFor(settings),
    headers: { 'Auto-Submitted': 'auto-generated' },
  });
  console.log(`Reminder sent (issue ${issueDate}, status ${status || 'none'}).`);
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
