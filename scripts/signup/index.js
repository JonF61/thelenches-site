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
//   resend   (27 Nov 2026, Jon; manual only, signup.yml Run workflow) a one-off reminder to a
//            row still "sent" (first email 2+ days ago): "Still want …?" with a fresh signed link
//            that lasts LINK_DAYS but never past the KEEP_DAYS wipe, so the privacy page's
//            30 days still hold; the email says the last day it works. Status stays "sent",
//            result "reminder sent"; a row already reminded is never sent a second one.
//   alert    (27 Nov 2026, Jon) the Worker refused a sign-up, or the page reported a failure,
//            with an address: a Sign-ups row "review" (result = why). Unless the address has
//            since gone through (a later new/sent/subscribed/already row, or active in
//            Subscribers: then "reviewed", nothing sent), Jon gets one email at once; the
//            panel's Summary lists it until he taps Reviewed.
//   added    (27 Nov 2026, Jon; manual only, signup.yml Run workflow with action "added") a
//            failed sign-up ("review" row) Jon has checked: added to Subscribers straight away
//            (applyListRequest, so Do Not Send still refuses) and sent one "you're on the list"
//            email (addedEmail, wording approved by Jon 27 Nov). The Facebook app's http://
//            origin refused 11 Harvington sign-ups that day.
// Each run also wipes the address from rows never confirmed within KEEP_DAYS ("expired"),
// as the privacy page promises. Rows are found by id only, so a replayed dispatch does
// nothing once the row has moved on. Never logs an address: this repo's Actions logs are public.
// Env: GOOGLE_SA_KEY, SHEET_ID, GMAIL_USER, APPROVAL_SIGNING_KEY, WORKER_URL, ACTION, SIGNUP_ID.
'use strict';

const g = require('../ingest/google');
const { signToken, linksEnabled } = require('../ingest/links');
const { applyListRequest } = require('../ingest/subscriptions');
const { siteConfig, sheetId, shortName, SITE } = require('../../lib/site.js');

const TAB = 'Sign-ups';
const HEADERS = ['id', 'requested', 'email', 'status', 'sent_at', 'confirmed_at', 'result'];
// Each site's own address, domain and newsletter (its site.json; Harvington stage 7).
const CFG = siteConfig();
const FROM = CFG.email || 'website@thelenches.org.uk';
const DOMAIN = CFG.domain || 'thelenches.org.uk';
const NEWSLETTER = CFG.newsletterName || 'The Lenches Newsletter';
const LINK_DAYS = 7;
const KEEP_DAYS = 30;
const TZ = 'Europe/London';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${sheetId()}/edit`;

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

// Deliberately plain, like a personal email: no header, colours or button, so Gmail is
// less likely to file it under Promotions (27 Oct). link: { text, url } shown as a line
// of text with the address written out beneath it, after the paragraphs in before.
function emailHtml(before, link, after = []) {
  const p = (t) => `<p style="margin:0 0 14px 0;">${t}</p>`;
  const linkHtml = link ? p(`${esc(link.text)}:<br><a href="${esc(link.url)}" style="word-break:break-all;">${esc(link.url)}</a>`) : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222222;">
${[...before.map((t) => p(esc(t))), linkHtml, ...after.map((t) => p(esc(t)))].filter(Boolean).join('\n')}
${p(DOMAIN)}
</body></html>`;
}

function confirmEmail(url) {
  const paras = [
    'Hello,',
    `Someone, hopefully you, asked to get ${NEWSLETTER} at this address. It's free and comes out every Thursday morning.`,
    `This link works for ${LINK_DAYS} days. If you didn't ask, just ignore this email and you won't hear from us again.`,
  ];
  return {
    subject: `Please confirm: ${NEWSLETTER}`,
    html: emailHtml(paras.slice(0, 2), { text: 'Yes, add me to the list', url }, paras.slice(2)),
    text: `${paras[0]}\n\n${paras[1]}\n\nYes, add me to the list:\n${url}\n\n${paras[2]}\n\n${DOMAIN}\n`,
  };
}

// The day a link stops working, for the email: 'Saturday 28 November' (UK).
function lastDay(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(ms - 1);
}

// The one-off reminder (wording approved by Jon, 27 Nov 2026; "works until" so the link
// never outlives the 30-day wipe).
function reminderEmail(url, untilMs) {
  const paras = [
    'Hello,',
    `A few weeks ago someone, hopefully you, asked to get ${NEWSLETTER} at this address, but the confirmation link wasn't used, so you're not on the list yet. It's free and comes out every Thursday morning.`,
    `This link works until ${lastDay(untilMs)}. If you'd rather not, just ignore this email and you won't hear from us again.`,
  ];
  return {
    subject: `Still want ${NEWSLETTER}?`,
    html: emailHtml(paras.slice(0, 2), { text: 'Yes, add me to the list', url }, paras.slice(2)),
    text: `${paras[0]}\n\n${paras[1]}\n\nYes, add me to the list:\n${url}\n\n${paras[2]}\n\n${DOMAIN}\n`,
  };
}

function alreadyEmail() {
  const paras = [
    'Hello,',
    `Someone, hopefully you, asked to get ${NEWSLETTER} at this address. Good news: you\'re already on the list, so it should be with you every Thursday morning.`,
    'If it isn\'t turning up, it\'s worth a quick look in your spam folder. If you didn\'t ask, you can ignore this email.',
  ];
  return {
    subject: `You're already on the list: ${NEWSLETTER}`,
    html: emailHtml(paras, null),
    text: `${paras.join('\n\n')}\n\n${DOMAIN}\n`,
  };
}

// Wording approved by Jon, 27 Nov 2026.
function addedEmail() {
  const paras = [
    'Hello,',
    `Thank you for signing up to ${NEWSLETTER} on our website. Our sign-up form had a problem at the time, so we've added you to the list ourselves. It's free and comes out every Thursday morning.`,
    'If you didn\'t ask to join, or would rather not have it, just reply to this email or use the unsubscribe link at the foot of any issue.',
  ];
  return {
    subject: `You're on the list: ${NEWSLETTER}`,
    html: emailHtml(paras, null),
    text: `${paras.join('\n\n')}\n\n${DOMAIN}\n`,
  };
}

// To Jon only (private mail, so the address may appear): a sign-up that didn't go through.
function failedEmail(email, row) {
  const text = `Someone tried to join ${NEWSLETTER} on the website, but it didn't go through.\n\n`
    + `Address: ${email}\nWhen: ${str(row.requested)}\n${str(row.result) || 'Didn\'t go through.'}\n\n`
    + 'They may well try again; this email is only sent once per address a day. If they don\'t get on the list, '
    + 'you could add them to Subscribers by hand, reply to them, or ask Kryten to send them a confirmation link. '
    + 'When you have dealt with it, tap Reviewed on the panel\'s Summary.\n\n'
    + `Sign-ups tab, row ${row._row} (id ${row.id}). Sheet: ${SHEET_URL}\n`;
  return {
    subject: `Sign-up didn't go through: please check (${shortName(SITE)})`,
    text,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2b2b2b;">${esc(text).replace(/\n/g, '<br>')}</div>`,
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
    subject: `Newsletter sign-up held for you (${shortName(SITE)})`,
    text,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2b2b2b;">${esc(text).replace(/\n/g, '<br>')}</div>`,
  };
}

/* ------------------------------------------------------------------ run -- */

async function tidy(deps, rows, ms) {
  const old = rows.filter((r) => str(r.email) && ['new', 'sent', 'failed', 'review', 'reviewed'].includes(lc(r.status)) && ageDays(r.requested, ms) > KEEP_DAYS);
  for (const r of old) await deps.g.updateRow(TAB, r._row, { email: '', status: 'expired' });
  return old.length;
}

async function run({ action, id, ms = Date.now() }, deps = { g, applyListRequest, signToken }) {
  if (!['send', 'confirm', 'resend', 'alert', 'added'].includes(action)) throw new Error('ACTION must be send, confirm, resend, alert or added');
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

  if (action === 'alert') {
    if (status !== 'review' || !email) { console.log(`Row is "${status}", not a failed sign-up to review. Nothing to do.`); return 'skipped'; }
    const subscribers = await deps.g.readTable('Subscribers');
    const active = (r) => !('status' in r) || !str(r.status) || lc(r.status) === 'active';
    const through = rows.some((r) => r !== row && lc(r.email) === email && ['new', 'sent', 'subscribed', 'already'].includes(lc(r.status))
      && str(r.requested) >= str(row.requested))
      || subscribers.some((r) => lc(r.email) === email && active(r));
    if (through) {
      await deps.g.updateRow(TAB, row._row, { status: 'reviewed', result: `${str(row.result)} · went through another way` });
      console.log('Failed sign-up has since gone through. Nothing sent.');
      return 'resolved';
    }
    const m = failedEmail(email, row);
    await deps.g.sendMail({ to: process.env.ALERT_TO || process.env.GMAIL_USER, ...m, fromName });
    console.log('Failed sign-up: Jon emailed.');
    return 'alerted';
  }

  if (action === 'added') {
    if (!['review', 'reviewed'].includes(status) || !email) { console.log(`Row is "${status}", not a failed sign-up. Nothing to do.`); return 'skipped'; }
    const res = await deps.applyListRequest('subscribe', email, now, { source: 'web form', notes: 'added by Jon after a failed sign-up' });
    if (res.refused) {
      await deps.g.updateRow(TAB, row._row, { status: 'held', result: res.refused });
      console.log('Not added: Do Not Send or another Subscribers status. Nothing sent.');
      return 'held';
    }
    if (res.done !== 'subscribed') {
      await deps.g.updateRow(TAB, row._row, { status: 'already', result: 'already subscribed' });
      console.log('Already subscribed. Nothing sent.');
      return 'already';
    }
    await deps.g.sendMail({ to: email, ...addedEmail(), from: FROM, fromName, headers: { 'Auto-Submitted': 'auto-generated' } });
    await deps.g.updateRow(TAB, row._row, { status: 'subscribed', sent_at: now, confirmed_at: now, result: 'added by Jon after a failed sign-up' });
    console.log('Added to Subscribers; "you\'re on the list" email sent.');
    return 'added';
  }

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

  if (action === 'resend') {
    if (status !== 'sent' || !email) { console.log(`Row is "${status}", not awaiting confirmation. Nothing to do.`); return 'skipped'; }
    if (lc(row.result) === 'reminder sent') { console.log('A reminder was sent already. Nothing to do.'); return 'skipped'; }
    if (ageDays(row.sent_at, ms) < 2) { console.log('The first email went under 2 days ago. Nothing to do.'); return 'skipped'; }
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(row.requested));
    const wipe = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) + KEEP_DAYS * 86400000 : 0;
    const until = Math.min(ms + LINK_DAYS * 86400000, wipe);
    if (until - ms < 12 * 3600000) { console.log('Under 12 hours before the address is wiped. Nothing sent.'); return 'too-late'; }
    const [subscribers, dns] = await Promise.all([deps.g.readTable('Subscribers'), deps.g.readTable('Do Not Send')]);
    const active = (r) => !('status' in r) || !str(r.status) || lc(r.status) === 'active';
    if (dns.some((r) => lc(r.email) === email) || subscribers.some((r) => lc(r.email) === email && active(r))) {
      console.log('On Do Not Send or already subscribed. Nothing sent.');
      return 'skipped';
    }
    if (deps.signToken === signToken && !linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY and WORKER_URL are needed for the link');
    const url = deps.signToken({ a: 'signup', i: id, e: Math.floor(until / 1000) }, '/s');
    await deps.g.sendMail({ to: email, ...reminderEmail(url, until), from: FROM, fromName, headers: { 'Auto-Submitted': 'auto-generated' } });
    await deps.g.updateRow(TAB, row._row, { sent_at: now, result: 'reminder sent' });
    console.log('Reminder sent.');
    return 'reminded';
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

module.exports = { run, addedEmail, confirmEmail, reminderEmail, alreadyEmail, heldEmail, failedEmail, emailHtml, stamp, ageDays, TAB, HEADERS, LINK_DAYS, KEEP_DAYS };

if (require.main === module) {
  // A manual "added" run may name several row ids, comma separated (one at a time, in turn).
  const action = str(process.env.ACTION);
  const ids = action === 'added' ? str(process.env.SIGNUP_ID).split(',').map(str).filter(Boolean) : [str(process.env.SIGNUP_ID)];
  (async () => { for (const id of ids) await run({ action, id }); })().catch((err) => {
    console.error('Fatal:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
