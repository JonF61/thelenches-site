// scripts/digest/index.js
// Thursday digest: one email listing every Pending item awaiting a decision, with
// signed Approve/Reject links (checked by the Cloudflare Worker), an Edit link to the
// Sheet row and a link to the original email. Also lists items auto-published this week.
// Signed links come from scripts/ingest/links.js (shared with the per-run action email);
// the sender display name comes from Settings from_name.
// "Use my wording": official and verbatim items show both versions, with "Approve with
// their wording" and "Approve with rewrite" buttons (wordingview.js).
// Step 7D: a one-line pipeline status from the latest Health row (daily diagnostic),
// listing any problems and flagging the row if it is older than HEALTH_STALE_HOURS.
//
// Daily mode (DIGEST_MODE=daily, Worker cron 07:00 UK every day): only the Pending items
// still "pending" that arrived since the last daily email, plus the items auto-published
// by a trusted source (Trusted tab, scripts/ingest/trusted.js) in that time. Same cards,
// plus "Trust this source" on Gmail and RSS items. Nothing is sent if there is nothing to
// list. Each sent email adds a row to the "Daily" tab (created if missing); its sent_at
// is the next email's cutoff. "Arrived" is the Log tab's processed_at for the item's
// message (falling back to Pending received), so a feed item published days before it
// was read still counts. The weekly digest is unchanged.
'use strict';

const g = require('../ingest/google');
const { signedLink, trustLink, linksEnabled, LINK_DAYS } = require('../ingest/links');
const trust = require('../ingest/trusted');
const { offersChoice } = require('../../lib/wording');
const wv = require('../ingest/wordingview');

const TZ = 'Europe/London';
const AUTO_LOOKBACK_DAYS = 7;  // "auto-published this week" window
const LOW_CONFIDENCE = 0.5;
const HEALTH_STALE_HOURS = 30; // diagnostic runs daily ~02:07 UK (often late); digest 07:03
const DAILY_TAB = 'Daily';
const DAILY_HEADERS = ['sent_at', 'cutoff', 'pending_count', 'trusted_count', 'gmail_id'];
const DAILY_FIRST_HOURS = 24;  // first daily email: look back this far

const C = { green: '#3F5233', cream: '#F6F1E4', orange: '#C0703A', red: '#A33B2B', grey: '#666666' };

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const truthy = (v) => String(v).trim().toUpperCase() === 'TRUE';

function londonDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms); // YYYY-MM-DD
}

// Same format the diagnostic writes to Health.date: "YYYY-MM-DD HH:MM" (UK time).
function londonStamp(ms) {
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${londonDate(ms)} ${t}`;
}

function longDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(`${ymd}T12:00:00Z`));
}

function flagsOf(item) {
  const f = [];
  if (truthy(item.urgent)) f.push('URGENT');
  if (truthy(item.people_in_image)) f.push('Children in photo');
  if (truthy(item.political_commercial)) f.push('Political/commercial');
  if (truthy(item.possible_repeat)) f.push('Possible repeat');
  const conf = Number(item.confidence);
  if (item.confidence !== '' && !Number.isNaN(conf) && conf < LOW_CONFIDENCE) f.push(`Low confidence (${conf})`);
  if (item.image_filename) f.push('Has image');
  return f;
}

function whenOf(item) {
  return [longDate(item.event_date), item.event_time].filter(Boolean).join(', ');
}

/* --------------------------------------------------------------- health -- */

// Latest Health row as { line, problems, level }. Never throws: the digest must
// still send if the Health tab is missing or unreadable.
async function readHealth() {
  let rows;
  try {
    rows = await g.readTable('Health');
  } catch (e) {
    return { line: `Pipeline health: Health tab unreadable (${String(e && e.message || e).slice(0, 120)}).`, problems: [], level: 'bad', tag: 'unreadable' };
  }
  const last = rows.filter((r) => String(r.date || '').trim()).pop();
  if (!last) return { line: 'Pipeline health: no Health rows yet (daily diagnostic has not recorded a run).', problems: [], level: 'bad', tag: 'no data' };

  const date = String(last.date).trim();
  const status = String(last.status || '').trim().toUpperCase() || 'UNKNOWN';
  const summary = String(last.summary || '').trim() || status;
  const problems = String(last.problems || '').split(' | ').map((p) => p.trim()).filter(Boolean);
  // RAW strings in "YYYY-MM-DD HH:MM" UK time compare correctly as text.
  const valid = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date);
  const stale = !valid || date < londonStamp(Date.now() - HEALTH_STALE_HOURS * 3600000);

  let line = `Pipeline health (${date}): ${summary}`;
  if (stale) line += `. STALE: latest check is over ${HEALTH_STALE_HOURS}h old, so the daily diagnostic may not be running.`;
  // CLEARED: Jon cleared the flag by hand in the admin panel (the problems stay listed).
  if (status === 'CLEARED' && !stale) line += ' (cleared by hand in the admin panel)';
  const level = stale ? 'bad' : status === 'CLEARED' ? 'ok'
    : (status === 'PROBLEMS' || problems.length) ? 'bad' : (status === 'OK' ? 'ok' : 'warn');
  const tag = stale ? 'stale' : (level === 'bad' ? 'PROBLEMS' : '');
  return { line, problems, level, tag };
}

/* ----------------------------------------------------------------- HTML -- */

function button(href, label, bg) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;`
    + `font-weight:bold;padding:10px 18px;border-radius:6px;margin:4px 6px 4px 0;font-size:15px;">${esc(label)}</a>`;
}

function textLink(href, label) {
  return `<a href="${esc(href)}" style="color:${C.green};margin-right:14px;font-size:14px;">${esc(label)}</a>`;
}

function healthHtml(h) {
  const colour = { ok: C.green, warn: C.orange, bad: C.red }[h.level];
  const list = h.problems.length
    ? `<ul style="margin:6px 0 0 18px;padding:0;">${h.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '';
  return `<div style="margin-top:10px;padding:8px 12px;background:#ffffff;border-left:4px solid ${colour};`
    + `border-radius:4px;font-size:13px;color:#2b2b2b;"><span style="color:${colour};font-weight:bold;">${esc(h.line)}</span>${list}</div>`;
}

function itemHtml(item, sheetRowUrl, trustSrc) {
  const flags = flagsOf(item);
  const choice = offersChoice(item);
  const meta = [whenOf(item), item.village, item.category].filter(Boolean).join(' · ');
  const details = [
    item.cost && `<b>Cost:</b> ${esc(item.cost)}`,
    item.contact && `<b>Contact:</b> ${esc(item.contact)}`,
    item.link_url && `<b>Link:</b> <a href="${esc(item.link_url)}" style="color:${C.green};">${esc(item.link_text || item.link_url)}</a>`,
  ].filter(Boolean).join('<br>');
  return `
<tr><td style="padding:0 0 16px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e3dccb;">
    <tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;font-size:15px;line-height:1.45;">
      ${flags.length ? `<div style="color:${C.orange};font-weight:bold;font-size:13px;margin-bottom:6px;">${esc(flags.join(' · '))}</div>` : ''}
      <div style="font-size:18px;font-weight:bold;color:${C.green};margin-bottom:4px;">${esc(item.title || '(no title)')}</div>
      ${meta ? `<div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(meta)}</div>` : ''}
      ${choice ? wv.versionsHtml(item, C) : (item.summary ? `<div style="margin-bottom:8px;">${esc(item.summary)}</div>` : '')}
      ${details ? `<div style="margin-bottom:8px;font-size:14px;">${details}</div>` : ''}
      <div style="color:${C.grey};font-size:12px;margin-bottom:10px;">From ${esc(item.source)} · received ${esc(item.received)}${item.notes ? ` · ${esc(item.notes)}` : ''}</div>
      <div>${choice ? wv.buttonsHtml(item, button, C) : `${button(signedLink(item, 'approve'), 'Approve', C.green)}${button(signedLink(item, 'reject'), 'Reject', C.red)}`}</div>
      ${choice ? `<div style="color:${C.grey};font-size:12px;margin-top:4px;">${esc(wv.defaultLine(item))}</div>` : ''}${trustSrc ? `
      <div style="margin-top:6px;">${button(trustLink(item, trustSrc.key), 'Trust this source', C.orange)}</div>
      <div style="color:${C.grey};font-size:12px;margin-top:2px;">Approves this item and publishes future items from ${esc(trustSrc.key)} without asking (except people in images, political/commercial, official, anonymous, out of scope, classified or low confidence).</div>` : ''}
      <div style="margin-top:6px;">${textLink(sheetRowUrl, 'Edit in Sheet')}${item.gmail_link ? textLink(item.gmail_link, 'Original email') : ''}</div>
    </td></tr>
  </table>
</td></tr>`;
}

function buildHtml({ pending, auto, holiday, rowUrl, dateLabel, health, daily, trustFor }) {
  const intro = pending.length
    ? `${pending.length} item${pending.length === 1 ? '' : 's'} to review. Each button opens a confirm page; nothing changes until you confirm.`
    : (daily ? 'Nothing new awaiting approval.' : 'Nothing awaiting approval this week.');
  const autoList = auto.length
    ? `<tr><td style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2b2b2b;">
        <div style="font-weight:bold;color:${C.green};margin-bottom:6px;">${daily ? 'Auto-published from trusted sources since the last email' : `Auto-published in the last ${AUTO_LOOKBACK_DAYS} days`}</div>
        ${auto.map((i) => `<div style="margin-bottom:4px;">${esc(i.title)}${whenOf(i) ? ` <span style="color:${C.grey};">(${esc(whenOf(i))})</span>` : ''} ${textLink(rowUrl(i), 'Sheet')}</div>`).join('')}
      </td></tr>`
    : '';
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};">
  <tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:22px;font-weight:bold;color:${C.green};">${daily ? 'Lenches daily approvals' : 'Lenches digest'}</div>
        <div style="font-size:14px;color:${C.grey};">${esc(dateLabel)}</div>
        ${health ? healthHtml(health) : ''}
        ${holiday ? `<div style="margin-top:8px;font-size:14px;color:${C.orange};font-weight:bold;">Holiday mode is ON: only items that always need a human decision are listed.</div>` : ''}
        <div style="margin-top:10px;font-size:15px;color:#2b2b2b;">${esc(intro)}</div>
      </td></tr>
      ${pending.map((i) => itemHtml(i, rowUrl(i), trustFor ? trustFor(i) : null)).join('')}
      ${autoList}
      <tr><td style="padding:16px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.grey};">
        Links expire after ${LINK_DAYS} days and each item can only be decided once.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildText({ pending, auto, holiday, rowUrl, dateLabel, health, daily, trustFor }) {
  const out = [`${daily ? 'Lenches daily approvals' : 'Lenches digest'}, ${dateLabel}`, ''];
  if (health) {
    out.push(health.line);
    health.problems.forEach((p) => out.push(`- ${p}`));
    out.push('');
  }
  if (holiday) out.push('Holiday mode is ON: only items that always need a human decision are listed.', '');
  out.push(pending.length ? `${pending.length} item(s) to review.`
    : (daily ? 'Nothing new awaiting approval.' : 'Nothing awaiting approval this week.'), '');
  for (const i of pending) {
    const flags = flagsOf(i);
    if (flags.length) out.push(`[${flags.join(', ')}]`);
    out.push(i.title || '(no title)');
    const meta = [whenOf(i), i.village, i.category].filter(Boolean).join(' · ');
    if (meta) out.push(meta);
    const choice = offersChoice(i);
    if (choice) out.push(...wv.versionsText(i));
    else if (i.summary) out.push(i.summary);
    if (i.cost) out.push(`Cost: ${i.cost}`);
    if (i.contact) out.push(`Contact: ${i.contact}`);
    if (i.link_url) out.push(`Link: ${i.link_url}`);
    out.push(`From ${i.source}, received ${i.received}`);
    if (choice) out.push(...wv.linksText(i));
    else {
      out.push(`Approve: ${signedLink(i, 'approve')}`);
      out.push(`Reject: ${signedLink(i, 'reject')}`);
    }
    const src = trustFor ? trustFor(i) : null;
    if (src) out.push(`Trust this source (${src.key}): ${trustLink(i, src.key)}`);
    out.push(`Edit: ${rowUrl(i)}`);
    if (i.gmail_link) out.push(`Original: ${i.gmail_link}`);
    out.push('');
  }
  if (auto.length) {
    out.push(daily ? 'Auto-published from trusted sources since the last email:' : `Auto-published in the last ${AUTO_LOOKBACK_DAYS} days:`);
    auto.forEach((i) => out.push(`- ${i.title}${whenOf(i) ? ` (${whenOf(i)})` : ''}`));
    out.push('');
  }
  out.push(`Links expire after ${LINK_DAYS} days and each item can only be decided once.`);
  return out.join('\n');
}

/* ----------------------------------------------------------------- main -- */

const sortPending = (a, b) => (truthy(b.urgent) - truthy(a.urgent))
  || String(a.event_date || '9999').localeCompare(String(b.event_date || '9999'));

const sheetRowUrl = (gid) => {
  const base = `https://docs.google.com/spreadsheets/d/${g.spreadsheetId()}/edit`;
  return (i) => (gid === null ? base : `${base}#gid=${gid}&range=A${i._row}`);
};

// Daily mode: pure selection, so it can be tested offline.
// arrivedAt(row) -> "YYYY-MM-DD HH:MM" UK. Returns { pending, auto }.
function selectDaily(rows, cutoff, arrivedAt) {
  const fresh = rows.filter((r) => r.id && arrivedAt(r) >= cutoff);
  return {
    pending: fresh.filter((r) => r.status === 'pending').sort(sortPending),
    auto: fresh.filter((r) => r.status === 'auto'
      && String(r.notes || '').split(' | ').some((n) => n.trim() === 'trusted')),
  };
}

async function mainDaily() {
  if (!linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY or WORKER_URL is not set');
  const to = process.env.DIGEST_TO || process.env.GMAIL_USER;
  const startedAt = londonStamp(Date.now());

  await Promise.all([g.ensureTab(DAILY_TAB, DAILY_HEADERS), g.ensureTab(trust.TAB, trust.HEADERS)]);
  const [rows, logRows, dailyRows, { settings, sources }, gid] = await Promise.all([
    g.readTable('Pending'),
    g.readTable('Log'),
    g.readTable(DAILY_TAB),
    g.readSettings(),
    g.getSheetGid('Pending'),
  ]);
  const last = dailyRows.map((r) => String(r.sent_at || '').trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d)).sort().pop();
  const cutoff = last || londonStamp(Date.now() - DAILY_FIRST_HOURS * 3600000);
  const processed = new Map(logRows.map((r) => [r.message_id, String(r.processed_at || '')]));
  const arrivedAt = (r) => processed.get(r.message_id) || String(r.received || '');

  const { pending, auto } = selectDaily(rows, cutoff, arrivedAt);
  if (!pending.length && !auto.length) {
    console.log(`Daily approvals: nothing since ${cutoff}; no email sent.`);
    return;
  }

  const dateLabel = longDate(londonDate(Date.now()));
  const subject = pending.length
    ? `Lenches daily approvals: ${pending.length} to review (${dateLabel})`
    : `Lenches daily approvals: ${auto.length} auto-published (${dateLabel})`;
  const ctx = {
    pending,
    auto,
    holiday: truthy(settings.holiday_mode),
    rowUrl: sheetRowUrl(gid),
    dateLabel,
    health: null,
    daily: true,
    trustFor: (i) => trust.sourceKeyFor(i, sources),
  };
  const id = await g.sendMail({
    to, subject, text: buildText(ctx), html: buildHtml(ctx), fromName: g.fromNameFor(settings),
  });
  await g.appendRows(DAILY_TAB, [{
    sent_at: startedAt, cutoff, pending_count: pending.length, trusted_count: auto.length, gmail_id: id,
  }]);
  console.log(`Daily approvals sent to ${to}: ${pending.length} to review, ${auto.length} trusted auto-published since ${cutoff}. Gmail id ${id}.`);
}

async function main() {
  if (!linksEnabled()) throw new Error('APPROVAL_SIGNING_KEY or WORKER_URL is not set');
  const to = process.env.DIGEST_TO || process.env.GMAIL_USER;

  const [rows, { settings }, gid, health] = await Promise.all([
    g.readTable('Pending'),
    g.readSettings(),
    g.getSheetGid('Pending'),
    readHealth(),
  ]);
  const holiday = truthy(settings.holiday_mode);
  const base = `https://docs.google.com/spreadsheets/d/${g.spreadsheetId()}/edit`;
  const rowUrl = (i) => (gid === null ? base : `${base}#gid=${gid}&range=A${i._row}`);

  const pending = rows
    .filter((r) => r.id && r.status === 'pending')
    .sort((a, b) => (truthy(b.urgent) - truthy(a.urgent))
      || String(a.event_date || '9999').localeCompare(String(b.event_date || '9999')));

  const since = londonDate(Date.now() - AUTO_LOOKBACK_DAYS * 86400000);
  const auto = rows.filter((r) => r.id && r.status === 'auto' && String(r.received).slice(0, 10) >= since);

  const today = londonDate(Date.now());
  const dateLabel = longDate(today);
  const healthTag = health.tag ? ` [health: ${health.tag}]` : '';
  const subject = (pending.length
    ? `Lenches digest: ${pending.length} to review (${dateLabel})`
    : `Lenches digest: nothing to review (${dateLabel})`) + healthTag;

  const ctx = { pending, auto, holiday, rowUrl, dateLabel, health };
  const id = await g.sendMail({
    to,
    subject,
    text: buildText(ctx),
    html: buildHtml(ctx),
    fromName: g.fromNameFor(settings),
  });
  console.log(`Digest sent to ${to}: ${pending.length} to review, ${auto.length} auto-published. ${health.line} Gmail id ${id}.`);
}

if (require.main === module) {
  const daily = String(process.env.DIGEST_MODE || '').toLowerCase() === 'daily';
  // Approval emails off (1 Nov, Jon decides in the admin panel): Settings approval_emails TRUE
  // turns the daily and weekly emails back on.
  const run = async () => {
    const { settings } = await g.readSettings();
    if (!require('../ingest/urgent').approvalEmails(settings)) {
      console.log(`${daily ? 'Daily approvals' : 'Weekly digest'} email not sent: approval emails are off (Settings approval_emails). Decide in the admin panel.`);
      return;
    }
    await (daily ? mainDaily() : main());
  };
  run().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { buildHtml, buildText, selectDaily };
