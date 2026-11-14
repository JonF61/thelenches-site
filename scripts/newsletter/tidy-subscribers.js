// scripts/newsletter/tidy-subscribers.js
// One-off tidy (Jon, 14 Nov): deletes every Subscribers row whose address is on Do Not Send
// (people who unsubscribed before unsubscribing started deleting the row), then Holly emails
// Jon the list. Do Not Send is untouched, so they stay off the newsletter. Safe to re-run.
// Run by unsubscribe.yml's manual run. Logs counts only (the Actions logs are public).
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER.
'use strict';

const g = require('../ingest/google');
const { planTidy } = require('../ingest/subscriptions');

const lc = (v) => String(v ?? '').trim().toLowerCase();

function tidyEmail(emails) {
  const text = [
    'Hi Jon,', '',
    `I've deleted ${emails.length} row${emails.length === 1 ? '' : 's'} from the Subscribers tab for people who had already unsubscribed (they're all on Do Not Send, which keeps them off the newsletter):`, '',
    ...emails.map((e) => `- ${e}`), '',
    'From now on I\'ll do this each time someone unsubscribes, and let you know.', '',
    'Best wishes,', 'Holly', 'Lenches website assistant', '',
  ].join('\n');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = text.trim().split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject: `Subscribers tidied: ${emails.length} unsubscribed ${emails.length === 1 ? 'person' : 'people'} removed`, text, html };
}

async function main() {
  const [subscribers, dns] = await Promise.all([g.readTable('Subscribers'), g.readTable('Do Not Send')]);
  if (!subscribers.some((r) => 'email' in r)) throw new Error('Subscribers has no "email" header');
  const rows = planTidy(subscribers, dns);
  if (!rows.length) { console.log('No Subscribers rows are on Do Not Send. Nothing to do.'); return; }
  const deleted = await g.deleteRows('Subscribers', rows.map((r) => r._row));
  console.log(`Deleted ${deleted} Subscribers row(s) on Do Not Send.`);
  const emails = [...new Set(rows.map((r) => lc(r.email)))];
  const { settings } = await g.readSettings();
  await g.sendMail({ to: process.env.ALERT_TO || process.env.GMAIL_USER, ...tidyEmail(emails), fromName: g.fromNameFor(settings) });
  console.log('Holly emailed Jon the list.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { tidyEmail };
