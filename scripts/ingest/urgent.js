// scripts/ingest/urgent.js
// Immediate alert to jon@ when ingestion creates an urgent item (cancellation,
// emergency road closure). One email per run, however many items.
// It only SUGGESTS a one-off extra send: nothing ever goes to subscribers from here,
// including in holiday mode.
//
// Pending column "alerted_at" makes this retry-safe: rows are stamped only after the
// email is sent, so a failed send is retried on the next run. Rows that don't qualify
// are stamped "skipped: ..." so they are never reconsidered.
'use strict';

const g = require('./google');
const { signedLink, linksEnabled, LINK_DAYS } = require('./links');

const TZ = 'Europe/London';
const DEFAULT_WINDOW_DAYS = 7; // override with Settings key urgent_window_days
const RECENT_DAYS = 3;         // only items received this recently are considered

const C = { green: '#3F5233', cream: '#F6F1E4', orange: '#C0703A', red: '#A33B2B', grey: '#666666' };

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const truthy = (v) => String(v).trim().toUpperCase() === 'TRUE';

function londonDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms); // YYYY-MM-DD
}

function londonDateTime(ms) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${londonDate(ms)} ${time}`;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function longDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(`${ymd}T12:00:00Z`));
}

const whenOf = (i) => [longDate(i.event_date), i.event_time].filter(Boolean).join(', ');

// 'alert', or the reason it is skipped. Undated items always alert (emergencies often have no date).
function classify(row, today, windowEnd, windowDays) {
  if (row.status === 'rejected') return 'skipped: rejected';
  const d = String(row.event_date || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    if (d < today) return 'skipped: event already past';
    if (d > windowEnd) return `skipped: event more than ${windowDays} days away`;
  }
  return 'alert';
}

function statusLine(row, buttons) {
  if (row.status === 'auto') return 'Already live on the website (auto-published).';
  if (row.status === 'approved') return 'Already approved.';
  const why = [
    truthy(row.people_in_image) && 'people in image',
    truthy(row.political_commercial) && 'political/commercial',
  ].filter(Boolean).join(', ');
  return `Awaiting your decision${why ? ` (${why})` : ''}.${buttons ? '' : ' Buttons unavailable; use Edit in Sheet.'}`;
}

/* ----------------------------------------------------------------- HTML -- */

function button(href, label, bg) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;`
    + `font-weight:bold;padding:10px 18px;border-radius:6px;margin:4px 6px 4px 0;font-size:15px;">${esc(label)}</a>`;
}

function textLink(href, label) {
  return `<a href="${esc(href)}" style="color:${C.green};margin-right:14px;font-size:14px;">${esc(label)}</a>`;
}

function itemHtml(row, rowUrl, buttons) {
  const meta = [whenOf(row), row.village, row.category].filter(Boolean).join(' · ');
  const showButtons = buttons && row.status === 'pending';
  return `
<tr><td style="padding:0 0 16px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:2px solid ${C.orange};">
    <tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;font-size:15px;line-height:1.45;">
      <div style="font-size:18px;font-weight:bold;color:${C.green};margin-bottom:4px;">${esc(row.title || '(no title)')}</div>
      ${meta ? `<div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(meta)}</div>` : ''}
      ${row.summary ? `<div style="margin-bottom:8px;">${esc(row.summary)}</div>` : ''}
      ${row.contact ? `<div style="margin-bottom:8px;font-size:14px;"><b>Contact:</b> ${esc(row.contact)}</div>` : ''}
      <div style="color:${C.grey};font-size:12px;margin-bottom:8px;">From ${esc(row.source)} · received ${esc(row.received)}${row.notes ? ` · ${esc(row.notes)}` : ''}</div>
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${esc(statusLine(row, buttons))}</div>
      ${showButtons ? `<div>${button(signedLink(row, 'approve'), 'Approve', C.green)}${button(signedLink(row, 'reject'), 'Reject', C.red)}</div>` : ''}
      <div style="margin-top:6px;">${textLink(rowUrl(row), 'Edit in Sheet')}${row.gmail_link ? textLink(row.gmail_link, 'Original email') : ''}</div>
    </td></tr>
  </table>
</td></tr>`;
}

const SUGGESTION = 'Suggested: a one-off extra send to subscribers. There is no Send button yet (step 5b), '
  + 'so send it yourself if it is worth it. Extra sends are never automatic, including in holiday mode.';

function buildHtml(items, rowUrl, buttons, holiday) {
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};">
  <tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:22px;font-weight:bold;color:${C.red};">Urgent item${items.length === 1 ? '' : 's'}</div>
        ${holiday ? `<div style="margin-top:6px;font-size:14px;color:${C.orange};font-weight:bold;">Holiday mode is ON.</div>` : ''}
        <div style="margin-top:10px;font-size:15px;color:#2b2b2b;background:#ffffff;border-left:4px solid ${C.orange};padding:10px 12px;">${esc(SUGGESTION)}</div>
      </td></tr>
      ${items.map((r) => itemHtml(r, rowUrl, buttons)).join('')}
      <tr><td style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.grey};">
        Buttons open a confirm page, expire after ${LINK_DAYS} days, and each item can only be decided once.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildText(items, rowUrl, buttons, holiday) {
  const out = ['Urgent item(s)', ''];
  if (holiday) out.push('Holiday mode is ON.', '');
  out.push(SUGGESTION, '');
  for (const r of items) {
    out.push(r.title || '(no title)');
    const meta = [whenOf(r), r.village, r.category].filter(Boolean).join(' · ');
    if (meta) out.push(meta);
    if (r.summary) out.push(r.summary);
    if (r.contact) out.push(`Contact: ${r.contact}`);
    out.push(`From ${r.source}, received ${r.received}`);
    out.push(statusLine(r, buttons));
    if (buttons && r.status === 'pending') {
      out.push(`Approve: ${signedLink(r, 'approve')}`);
      out.push(`Reject: ${signedLink(r, 'reject')}`);
    }
    out.push(`Edit: ${rowUrl(r)}`);
    if (r.gmail_link) out.push(`Original: ${r.gmail_link}`);
    out.push('');
  }
  return out.join('\n');
}

/* ----------------------------------------------------------------- main -- */

// Returns the number of items alerted. Throws if the email can't be sent (rows stay
// unstamped, so the next run retries).
async function sendUrgentAlerts(settings, holiday) {
  const rows = await g.readTable('Pending');
  if (!rows.length) return 0;
  if (!('alerted_at' in rows[0])) {
    throw new Error('Pending tab has no "alerted_at" header; add it so urgent alerts are not repeated');
  }

  const today = londonDate(Date.now());
  const windowDays = Number(settings.urgent_window_days) || DEFAULT_WINDOW_DAYS;
  const windowEnd = addDays(today, windowDays);
  const since = addDays(today, -RECENT_DAYS);

  const candidates = rows.filter((r) => r.id && truthy(r.urgent) && !String(r.alerted_at).trim()
    && String(r.received).slice(0, 10) >= since);
  if (!candidates.length) return 0;

  const items = [];
  for (const r of candidates) {
    const c = classify(r, today, windowEnd, windowDays);
    if (c === 'alert') items.push(r);
    else await g.updateRow('Pending', r._row, { alerted_at: c });
  }
  if (!items.length) return 0;

  const buttons = linksEnabled();
  if (!buttons) console.warn('WORKER_URL or APPROVAL_SIGNING_KEY not set: alert sent without buttons.');
  const gid = await g.getSheetGid('Pending');
  const base = `https://docs.google.com/spreadsheets/d/${g.spreadsheetId()}/edit`;
  const rowUrl = (i) => (gid === null ? base : `${base}#gid=${gid}&range=A${i._row}`);

  const subject = items.length === 1
    ? `URGENT: ${items[0].title || 'new item'} (Lenches)`
    : `URGENT: ${items.length} items (Lenches)`;
  const id = await g.sendMail({
    to: process.env.ALERT_TO || process.env.GMAIL_USER,
    subject,
    text: buildText(items, rowUrl, buttons, holiday),
    html: buildHtml(items, rowUrl, buttons, holiday),
    fromName: 'Lenches Pipeline',
  });

  const stamp = londonDateTime(Date.now());
  for (const r of items) await g.updateRow('Pending', r._row, { alerted_at: stamp });
  console.log(`Urgent alert sent for ${items.length} item(s). Gmail id ${id}.`);
  return items.length;
}

module.exports = { sendUrgentAlerts };
