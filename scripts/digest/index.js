// scripts/digest/index.js
// Thursday digest: one email listing every Pending item awaiting a decision, with
// signed Approve/Reject links (checked by the Cloudflare Worker), an Edit link to the
// Sheet row and a link to the original email. Also lists items auto-published this week.
'use strict';

const crypto = require('crypto');
const g = require('../ingest/google');

const TZ = 'Europe/London';
const LINK_DAYS = 14;          // approval links expire after this
const AUTO_LOOKBACK_DAYS = 7;  // "auto-published this week" window
const LOW_CONFIDENCE = 0.5;

const WORKER_URL = String(process.env.WORKER_URL || '').replace(/\/+$/, '');
const KEY = process.env.APPROVAL_SIGNING_KEY;

const C = { green: '#3F5233', cream: '#F6F1E4', orange: '#C0703A', red: '#A33B2B', grey: '#666666' };

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const truthy = (v) => String(v).trim().toUpperCase() === 'TRUE';

function londonDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms); // YYYY-MM-DD
}

function longDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(`${ymd}T12:00:00Z`));
}

// Signed link: base64url(JSON).base64url(HMAC-SHA256). The Worker verifies with the same key.
function signedLink(item, action) {
  const payload = {
    i: item.id,
    a: action,
    t: String(item.title || '').slice(0, 80),
    e: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
  return `${WORKER_URL}/a?t=${body}.${sig}`;
}

function flagsOf(item) {
  const f = [];
  if (truthy(item.urgent)) f.push('URGENT');
  if (truthy(item.people_in_image)) f.push('People in image');
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

/* ----------------------------------------------------------------- HTML -- */

function button(href, label, bg) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;`
    + `font-weight:bold;padding:10px 18px;border-radius:6px;margin:4px 6px 4px 0;font-size:15px;">${esc(label)}</a>`;
}

function textLink(href, label) {
  return `<a href="${esc(href)}" style="color:${C.green};margin-right:14px;font-size:14px;">${esc(label)}</a>`;
}

function itemHtml(item, sheetRowUrl) {
  const flags = flagsOf(item);
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
      ${item.summary ? `<div style="margin-bottom:8px;">${esc(item.summary)}</div>` : ''}
      ${details ? `<div style="margin-bottom:8px;font-size:14px;">${details}</div>` : ''}
      <div style="color:${C.grey};font-size:12px;margin-bottom:10px;">From ${esc(item.source)} · received ${esc(item.received)}${item.notes ? ` · ${esc(item.notes)}` : ''}</div>
      <div>${button(signedLink(item, 'approve'), 'Approve', C.green)}${button(signedLink(item, 'reject'), 'Reject', C.red)}</div>
      <div style="margin-top:6px;">${textLink(sheetRowUrl, 'Edit in Sheet')}${item.gmail_link ? textLink(item.gmail_link, 'Original email') : ''}</div>
    </td></tr>
  </table>
</td></tr>`;
}

function buildHtml({ pending, auto, holiday, rowUrl, dateLabel }) {
  const intro = pending.length
    ? `${pending.length} item${pending.length === 1 ? '' : 's'} to review. Each button opens a confirm page; nothing changes until you confirm.`
    : 'Nothing awaiting approval this week.';
  const autoList = auto.length
    ? `<tr><td style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2b2b2b;">
        <div style="font-weight:bold;color:${C.green};margin-bottom:6px;">Auto-published in the last ${AUTO_LOOKBACK_DAYS} days</div>
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
        <div style="font-size:22px;font-weight:bold;color:${C.green};">Lenches digest</div>
        <div style="font-size:14px;color:${C.grey};">${esc(dateLabel)}</div>
        ${holiday ? `<div style="margin-top:8px;font-size:14px;color:${C.orange};font-weight:bold;">Holiday mode is ON: only items that always need a human decision are listed.</div>` : ''}
        <div style="margin-top:10px;font-size:15px;color:#2b2b2b;">${esc(intro)}</div>
      </td></tr>
      ${pending.map((i) => itemHtml(i, rowUrl(i))).join('')}
      ${autoList}
      <tr><td style="padding:16px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.grey};">
        Links expire after ${LINK_DAYS} days and each item can only be decided once.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildText({ pending, auto, holiday, rowUrl, dateLabel }) {
  const out = [`Lenches digest, ${dateLabel}`, ''];
  if (holiday) out.push('Holiday mode is ON: only items that always need a human decision are listed.', '');
  out.push(pending.length ? `${pending.length} item(s) to review.` : 'Nothing awaiting approval this week.', '');
  for (const i of pending) {
    const flags = flagsOf(i);
    if (flags.length) out.push(`[${flags.join(', ')}]`);
    out.push(i.title || '(no title)');
    const meta = [whenOf(i), i.village, i.category].filter(Boolean).join(' · ');
    if (meta) out.push(meta);
    if (i.summary) out.push(i.summary);
    if (i.cost) out.push(`Cost: ${i.cost}`);
    if (i.contact) out.push(`Contact: ${i.contact}`);
    if (i.link_url) out.push(`Link: ${i.link_url}`);
    out.push(`From ${i.source}, received ${i.received}`);
    out.push(`Approve: ${signedLink(i, 'approve')}`);
    out.push(`Reject: ${signedLink(i, 'reject')}`);
    out.push(`Edit: ${rowUrl(i)}`);
    if (i.gmail_link) out.push(`Original: ${i.gmail_link}`);
    out.push('');
  }
  if (auto.length) {
    out.push(`Auto-published in the last ${AUTO_LOOKBACK_DAYS} days:`);
    auto.forEach((i) => out.push(`- ${i.title}${whenOf(i) ? ` (${whenOf(i)})` : ''}`));
    out.push('');
  }
  out.push(`Links expire after ${LINK_DAYS} days and each item can only be decided once.`);
  return out.join('\n');
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  if (!KEY) throw new Error('APPROVAL_SIGNING_KEY is not set');
  if (!WORKER_URL) throw new Error('WORKER_URL is not set');
  const to = process.env.DIGEST_TO || process.env.GMAIL_USER;

  const [rows, { settings }, gid] = await Promise.all([
    g.readTable('Pending'),
    g.readSettings(),
    g.getSheetGid('Pending'),
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
  const subject = pending.length
    ? `Lenches digest: ${pending.length} to review (${dateLabel})`
    : `Lenches digest: nothing to review (${dateLabel})`;

  const ctx = { pending, auto, holiday, rowUrl, dateLabel };
  const id = await g.sendMail({
    to,
    subject,
    text: buildText(ctx),
    html: buildHtml(ctx),
    fromName: 'Lenches Pipeline',
  });
  console.log(`Digest sent to ${to}: ${pending.length} to review, ${auto.length} auto-published. Gmail id ${id}.`);
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
