// scripts/signup/index.js
// Newsletter sign-up by web form, double opt-in (Growth part 3). signup.yml runs this on
// repository_dispatch "signup" from the Worker (worker/src/signup.js):
//   send     the form saved a Sign-ups row (status "new"). On Do Not Send: nothing is
//            sent, the row is "held" and Jon gets a short email. Already subscribed: one
//            "you're already on the list" email ("already"). Otherwise one confirmation
//            email with a signed /s link lasting LINK_DAYS ("sent").
//   confirm  the reader pressed the button behind that link. applyListRequest
//            (scripts/ingest/subscriptions.js) adds them to Subscribers, refusing anyone on
//            Do Not Send or with another Subscribers status ("held", Jon emailed).
// Each run also wipes the address from rows never confirmed within KEEP_DAYS ("expired"),
// as the privacy page promises. Rows are found by id only, so a replayed dispatch does
// nothing once the row has moved on. Never logs an address: this repo's Actions logs are public.
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, APPROVAL_SIGNING_KEY, WORKER_URL, ACTION, SIGNUP_ID.
'use strict';

const g = require('../ingest/google');
const { signToken, linksEnabled } = require('../ingest/links');
const { applyListRequest } = require('../ingest/subscriptions');

const TAB = 'Sign-ups';
const HEADERS = ['id', 'requested', 'email', 'status', 'sent_at', 'confirmed_at', 'result'];
const FROM = 'website@thelenches.org.uk';
const LINK_DAYS = 7;
const KEEP_DAYS = 30;
const TZ = 'Europe/London';
const C = { green: '#3F5233', cream: '#F6F1E4', grey: '#666666' };
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1k-9oxqMVfWCb4wIY_RbSiSszarb2d029_UXnKIFdNRI/edit';

const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function stamp(ms = Date.now()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 'YYYY-MM-DD HH:MM' (UK) -> rough age in days (an hour out at most across a clock change).
function ageDays(when, ms) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(when));
  if (!m) return Infinity;
  return (ms - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000;
}

/* --------------------------------------------------------------- emails -- */

// Outlook-safe: 600px table, inline CSS. before: paragraphs above the button (if any),
// after: paragraphs below it.
function emailHtml(before, button, after = []) {
  const p = (t) => `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#2b2b2b;">${esc(t)}</p>`;
  const btn = button ? `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px 0;"><tr>
<td bgcolor="${C.green}" style="background:${C.green};border-radius:6px;padding:12px 22px;">
<a href="${esc(button.url)}" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(button.text)}</a>
</td></tr></table>` : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${C.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.cream};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;"><tr><td style="padding:28px 32px;">
<p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:${C.green};">The Lenches Newsletter</p>
${before.map(p).join('\n')}${btn}
${after.map(p).join('\n')}
<p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;color:${C.grey};">thelenches.org.uk</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

function confirmEmail(url) {
  const paras = [
    'Hello,',
    'Someone, hopefully you, asked to get The Lenches Newsletter at this address. It\'s free and comes out every Thursday morning.',
    `This link works for ${LINK_DAYS} days. If you didn't ask, just ignore this email and you won't hear from us again.`,
  ];
  return {
    subject: 'Please confirm: The Lenches Newsletter',
    html: emailHtml(paras.slice(0, 2), { text: 'Yes, add me to the list', url }, paras.slice(2)),
    text: `${paras[0]}\n\n${paras[1]}\n\nYes, add me to the list:\n${url}\n\n${paras[2]}\n`,
  };
}

function alreadyEmail() {
  const paras = [
    'Hello,',
    'Someone, hopefully you, asked to get The Lenches Newsletter at this address. Good news: you\'re already on the list, so it should be with you every Thursday morning.',
    'If it isn\'t turning up, it\'s worth a quick look in your spam folder. If you didn\'t ask, you can ignore this email.',
  ];
  return {
    subject: 'You\'re already on the list: The Lenches Newsletter',
    html: emailHtml(paras, null),
    text: `${paras.join('\n\n')}\n`,
  };
}

// To Jon only (private mail, so the address may appear).
function heldEmail(email, row, why) {
  const text = `A newsletter sign-up from the website has been held: ${why}.\n\n`
    + `Address: ${email}\nSign-ups tab, row ${row._row} (id ${row.id}).\n\n`
    + 'Nothing has been sent to them. To add them, delete their Do Not Send row (or fix their Subscribers row) '
    + 'and add them to Subscribers by hand. To leave it, delete the Sign-ups row.\n\n'
    + `Sheet: ${SHEET_URL}\n`;
  return {
    subject: 'Newsletter sign-up held for you (Lenches)',
    text,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2b2b2b;">${esc(text).replace(/\n/g, '<br>')}</div>`,
  };
}

/* ------------------------------------------------------------------ run -- */

async function tidy(deps, rows, ms) {
  const old = rows.filter((r) => str(r.email) && ['new', 'sent', 'failed'].includes(lc(r.status)) && ageDays(r.requested, ms) > KEEP_DAYS);
  for (const r of old) await deps.g.updateRow(TAB, r._row, { email: '', status: 'expired' });
  return old.length;
}

async function run({ action, id, ms = Date.now() }, deps = { g, applyListRequest, signToken }) {
  if (!['send', 'confirm'].includes(action)) throw new Error('ACTION must be send or confirm');
  if (!/^su-\d{8}-[a-z0-9]{6}$/.test(id)) throw new Error('SIGNUP_ID is missing or malformed');
  await deps.g.ensureTab(TAB, HEADERS);
  const rows = await deps.g.readTable(TAB);
  const now = stamp(ms);
  const tidied = await tidy(deps, rows, ms);
  if (tidied) console.log(`${tidied} unconfirmed sign-up(s) over ${KEEP_DAYS} days: address wiped.`);

  const row = rows.find((r) => str(r.id) === id);
  if (!row) { console.log('No Sign-ups row has this id. Nothing to do.'); return 'missing'; }
  const email = lc(row.email);
  const status = lc(row.status);
  const { settings } = await deps.g.readSettings();
  const fromName = deps.g.fromNameFor(settings);
  const toJon = async (why) => {
    const m = heldEmail(email, row, why);
    await deps.g.sendMail({ to: process.env.ALERT_TO || process.env.GMAIL_USER, ...m, fromName });
  };

  if (action === 'send') {
    if (status !== 'new' || !email) { console.log(`Row is "${status}", not new. Nothing to do.`); return 'skipped'; }
    const [subscribers, dns] = await Promise.all([deps.g.readTable('Subscribers'), deps.g.readTable('Do Not Send')]);
    if (dns.some((r) => lc(r.email) === email)) {
      await deps.g.updateRow(TAB, row._row, { status: 'held', result: 'on Do Not Send' });
      await toJon('the address is on the Do Not Send tab');
      console.log('Held: on Do Not Send. Jon emailed; nothing sent to them.');
      return 'held';
    }
    const active = (r) => !('status' in r) || !str(r.status) || lc(r.status) === 'active';
    const headers = { 'Auto-Submitted': 'auto-generated' };
    if (subscribers.some((r) => lc(r.email) === email && active(r))) {
      await deps.g.sendMail({ to: email, ...alreadyEmail(), from: FROM, fromName, headers });
      await deps.g.updateRow(TAB, row._row, { status: 'already', sent_at: now, result: 'already subscribed' });
      console.log('Already subscribed: "already on the list" email sent.');
      return 'already';
    }
    if (deps.signToken === signToken && !linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY and WORKER_URL are needed for the link');
    const e = Math.floor(ms / 1000) + LINK_DAYS * 86400;
    const url = deps.signToken({ a: 'signup', i: id, e }, '/s');
    await deps.g.sendMail({ to: email, ...confirmEmail(url), from: FROM, fromName, headers });
    await deps.g.updateRow(TAB, row._row, { status: 'sent', sent_at: now });
    console.log('Confirmation email sent.');
    return 'sent';
  }

  // confirm
  if (status !== 'sent' || !email) { console.log(`Row is "${status}", not awaiting confirmation. Nothing to do.`); return 'skipped'; }
  if (ageDays(row.sent_at, ms) > LINK_DAYS + 1) {
    console.log('Confirmation came after the link should have expired. Nothing done.');
    return 'late';
  }
  const res = await deps.applyListRequest('subscribe', email, now, { source: 'web form', notes: 'confirmed by email link' });
  if (res.refused) {
    await deps.g.updateRow(TAB, row._row, { status: 'held', confirmed_at: now, result: res.refused });
    await toJon(`they confirmed, but ${res.refused}`);
    console.log('Confirmed but held for Jon (Do Not Send or another Subscribers status).');
    return 'held';
  }
  const done = res.done === 'subscribed' ? 'subscribed' : 'already';
  await deps.g.updateRow(TAB, row._row, { status: done, confirmed_at: now, result: done === 'already' ? 'already subscribed' : '' });
  console.log(done === 'subscribed' ? 'Confirmed: added to Subscribers.' : 'Confirmed: already subscribed.');
  return done;
}

module.exports = { run, confirmEmail, alreadyEmail, heldEmail, TAB, HEADERS, LINK_DAYS, KEEP_DAYS };

if (require.main === module) {
  run({ action: str(process.env.ACTION), id: str(process.env.SIGNUP_ID) }).catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
