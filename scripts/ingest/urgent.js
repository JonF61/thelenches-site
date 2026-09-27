// scripts/ingest/urgent.js
// The per-run "action needed" email to jon@. One email per run at most, covering:
//   - urgent items (cancellation, emergency road closure): SUGGESTS a one-off extra send;
//     nothing ever goes to subscribers from here, including in holiday mode
//   - submitter replies awaiting a decision (Send/Skip), shadow-mode drafts, and replies
//     stuck at "sending" (never resent automatically)
//
// Retry-safe: Pending and Replies "alerted_at" are stamped only after the email is sent,
// so a failed send is retried on the next run. Pending rows that don't qualify are
// stamped "skipped: ..." so they are never reconsidered.
'use strict';

const g = require('./google');
const { signedLink, linksEnabled, LINK_DAYS } = require('./links');
const replies = require('./replies');

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

// Replies row -> what Jon should know about it.
function replyLine(r, liveButtons) {
  if (r.status === 'shadow') return 'Shadow mode: drafted and logged only. Nothing has been sent.';
  if (r.status === 'sending') {
    return `Stuck at "sending" since ${r.sent_at}. It may or may not have gone: check jon@ Sent mail. `
      + 'It will never be resent automatically; set the status by hand once checked.';
  }
  const when = r.status === 'awaiting'
    ? ` If you do nothing, it goes without the question ${replies.AWAIT_HOURS}h after ${r.created_at}.`
    : '';
  return `Awaiting your decision: Send uses the body cell as it is when you confirm.${when}`
    + `${liveButtons ? '' : ' Buttons unavailable; edit the status in the Sheet.'}`;
}

/* ----------------------------------------------------------------- HTML -- */

function button(href, label, bg) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;`
    + `font-weight:bold;padding:10px 18px;border-radius:6px;margin:4px 6px 4px 0;font-size:15px;">${esc(label)}</a>`;
}

function textLink(href, label) {
  return `<a href="${esc(href)}" style="color:${C.green};margin-right:14px;font-size:14px;">${esc(label)}</a>`;
}

function card(inner, border) {
  return `
<tr><td style="padding:0 0 16px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:2px solid ${border};">
    <tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;font-size:15px;line-height:1.45;">${inner}</td></tr>
  </table>
</td></tr>`;
}

function heading(text, colour) {
  return `<tr><td style="padding:8px 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;color:${colour};">${esc(text)}</td></tr>`;
}

function itemHtml(row, rowUrl, buttons) {
  const meta = [whenOf(row), row.village, row.category].filter(Boolean).join(' · ');
  const showButtons = buttons && row.status === 'pending';
  return card(`
      <div style="font-size:18px;font-weight:bold;color:${C.green};margin-bottom:4px;">${esc(row.title || '(no title)')}</div>
      ${meta ? `<div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(meta)}</div>` : ''}
      ${row.summary ? `<div style="margin-bottom:8px;">${esc(row.summary)}</div>` : ''}
      ${row.contact ? `<div style="margin-bottom:8px;font-size:14px;"><b>Contact:</b> ${esc(row.contact)}</div>` : ''}
      <div style="color:${C.grey};font-size:12px;margin-bottom:8px;">From ${esc(row.source)} · received ${esc(row.received)}${row.notes ? ` · ${esc(row.notes)}` : ''}</div>
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${esc(statusLine(row, buttons))}</div>
      ${showButtons ? `<div>${button(signedLink(row, 'approve'), 'Approve', C.green)}${button(signedLink(row, 'reject'), 'Reject', C.red)}</div>` : ''}
      <div style="margin-top:6px;">${textLink(rowUrl(row), 'Edit in Sheet')}${row.gmail_link ? textLink(row.gmail_link, 'Original email') : ''}</div>`,
  C.orange);
}

function replyHtml(r, ctx) {
  const showButtons = ctx.liveButtons && r.status === 'awaiting';
  const link = { id: r.reply_id, title: `Reply to ${r.to}` };
  const border = r.status === 'sending' ? C.red : C.green;
  return card(`
      <div style="font-size:16px;font-weight:bold;color:${C.green};margin-bottom:4px;">To ${esc(r.to)}</div>
      <div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(r.subject)}${r.policy_codes ? ` · ${esc(r.policy_codes)}` : ''}</div>
      <div style="white-space:pre-wrap;background:${C.cream};border-radius:6px;padding:10px 12px;font-size:14px;margin-bottom:8px;">${esc(r.body)}</div>
      ${r.notes ? `<div style="color:${C.grey};font-size:12px;margin-bottom:8px;">${esc(r.notes)}</div>` : ''}
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${esc(replyLine(r, ctx.liveButtons))}</div>
      ${showButtons ? `<div>${button(signedLink(link, 'send'), 'Send', C.green)}${button(signedLink(link, 'skip'), 'Skip', C.red)}</div>` : ''}
      <div style="margin-top:6px;">${textLink(ctx.replyUrl(r), 'Edit in Sheet')}${ctx.gmailFor(r) ? textLink(ctx.gmailFor(r), 'Original email') : ''}</div>`,
  border);
}

const SUGGESTION = 'Suggested: a one-off extra send to subscribers. There is no Send button yet (step 5b), '
  + 'so send it yourself if it is worth it. Extra sends are never automatic, including in holiday mode.';

function buildHtml(ctx) {
  const { items, drafts, stuck, holiday, rowUrl, buttons } = ctx;
  const awaiting = drafts.filter((r) => r.status === 'awaiting');
  const shadow = drafts.filter((r) => r.status === 'shadow');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.cream};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};">
  <tr><td align="center" style="padding:20px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:22px;font-weight:bold;color:${items.length ? C.red : C.green};">${esc(ctx.title)}</div>
        ${holiday ? `<div style="margin-top:6px;font-size:14px;color:${C.orange};font-weight:bold;">Holiday mode is ON.</div>` : ''}
      </td></tr>
      ${items.length ? `${heading(`Urgent item${items.length === 1 ? '' : 's'}`, C.red)}
      <tr><td style="padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:15px;color:#2b2b2b;background:#ffffff;border-left:4px solid ${C.orange};padding:10px 12px;">${esc(SUGGESTION)}</div>
      </td></tr>
      ${items.map((r) => itemHtml(r, rowUrl, buttons)).join('')}` : ''}
      ${stuck.length ? `${heading('Replies stuck at "sending"', C.red)}${stuck.map((r) => replyHtml(r, ctx)).join('')}` : ''}
      ${awaiting.length ? `${heading('Replies needing your decision', C.green)}${awaiting.map((r) => replyHtml(r, ctx)).join('')}` : ''}
      ${shadow.length ? `${heading('Reply drafts (shadow mode, not sent)', C.green)}${shadow.map((r) => replyHtml(r, ctx)).join('')}` : ''}
      <tr><td style="padding:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.grey};">
        Buttons open a confirm page, expire after ${LINK_DAYS} days, and each can only be used once.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildText(ctx) {
  const { items, drafts, stuck, holiday, rowUrl, buttons } = ctx;
  const out = [ctx.title, ''];
  if (holiday) out.push('Holiday mode is ON.', '');
  if (items.length) {
    out.push('URGENT ITEMS', SUGGESTION, '');
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
  }
  const section = (label, list) => {
    if (!list.length) return;
    out.push(label, '');
    for (const r of list) {
      out.push(`To ${r.to}: ${r.subject}${r.policy_codes ? ` [${r.policy_codes}]` : ''}`);
      out.push('---', r.body, '---');
      if (r.notes) out.push(r.notes);
      out.push(replyLine(r, ctx.liveButtons));
      if (ctx.liveButtons && r.status === 'awaiting') {
        const link = { id: r.reply_id, title: `Reply to ${r.to}` };
        out.push(`Send: ${signedLink(link, 'send')}`);
        out.push(`Skip: ${signedLink(link, 'skip')}`);
      }
      out.push(`Edit: ${ctx.replyUrl(r)}`);
      if (ctx.gmailFor(r)) out.push(`Original: ${ctx.gmailFor(r)}`);
      out.push('');
    }
  };
  section('REPLIES STUCK AT "SENDING"', stuck);
  section('REPLIES NEEDING YOUR DECISION', drafts.filter((r) => r.status === 'awaiting'));
  section('REPLY DRAFTS (SHADOW MODE, NOT SENT)', drafts.filter((r) => r.status === 'shadow'));
  return out.join('\n');
}

function subjectFor(items, drafts, stuck) {
  if (items.length) {
    return items.length === 1
      ? `URGENT: ${items[0].title || 'new item'} (Lenches)`
      : `URGENT: ${items.length} items (Lenches)`;
  }
  if (stuck.length) return `Action needed: ${stuck.length} reply(ies) stuck (Lenches)`;
  const awaiting = drafts.filter((r) => r.status === 'awaiting').length;
  if (awaiting) return `Action needed: ${awaiting} reply(ies) to approve (Lenches)`;
  return `Reply drafts (shadow): ${drafts.length} (Lenches)`;
}

/* ----------------------------------------------------------------- main -- */

async function sheetUrl(tab) {
  const gid = await g.getSheetGid(tab);
  const base = `https://docs.google.com/spreadsheets/d/${g.spreadsheetId()}/edit`;
  return (row) => (gid === null ? base : `${base}#gid=${gid}&range=A${row._row}`);
}

// Returns the number of things alerted. Throws if the email can't be sent (rows stay
// unstamped, so the next run retries).
async function sendUrgentAlerts(settings, holiday) {
  const rows = await g.readTable('Pending');
  if (rows.length && !('alerted_at' in rows[0])) {
    throw new Error('Pending tab has no "alerted_at" header; add it so urgent alerts are not repeated');
  }

  // Urgent items.
  const today = londonDate(Date.now());
  const windowDays = Number(settings.urgent_window_days) || DEFAULT_WINDOW_DAYS;
  const windowEnd = addDays(today, windowDays);
  const since = addDays(today, -RECENT_DAYS);
  const candidates = rows.filter((r) => r.id && truthy(r.urgent) && !String(r.alerted_at).trim()
    && String(r.received).slice(0, 10) >= since);
  const items = [];
  for (const r of candidates) {
    const c = classify(r, today, windowEnd, windowDays);
    if (c === 'alert') items.push(r);
    else await g.updateRow('Pending', r._row, { alerted_at: c });
  }

  // Replies.
  const mode = replies.repliesMode(settings);
  let drafts = [];
  let stuck = [];
  if (mode !== 'off') {
    const replyRows = await g.readTable('Replies');
    if (replyRows.length && !('alerted_at' in replyRows[0])) {
      throw new Error('Replies tab has no "alerted_at" header (O1); add it so drafts are not repeated');
    }
    ({ drafts, stuck } = replies.rowsForAlert(replyRows));
  }
  if (!items.length && !drafts.length && !stuck.length) return 0;

  const buttons = linksEnabled();
  if (!buttons) console.warn('WORKER_URL or APPROVAL_SIGNING_KEY not set: email sent without buttons.');
  const gmailByMessage = new Map(rows.map((r) => [r.message_id, r.gmail_link]));
  const ctx = {
    items,
    drafts,
    stuck,
    holiday,
    buttons,
    liveButtons: buttons && mode === 'live',
    rowUrl: items.length ? await sheetUrl('Pending') : null,
    replyUrl: drafts.length || stuck.length ? await sheetUrl('Replies') : null,
    gmailFor: (r) => gmailByMessage.get(r.message_id) || '',
    title: items.length ? 'Urgent and action needed' : 'Action needed',
  };

  const id = await g.sendMail({
    to: process.env.ALERT_TO || process.env.GMAIL_USER,
    subject: subjectFor(items, drafts, stuck),
    text: buildText(ctx),
    html: buildHtml(ctx),
    fromName: g.fromNameFor(settings),
  });

  const stamp = londonDateTime(Date.now());
  for (const r of items) await g.updateRow('Pending', r._row, { alerted_at: stamp });
  for (const r of drafts) await g.updateRow('Replies', r._row, { alerted_at: stamp });
  for (const r of stuck) await g.updateRow('Replies', r._row, { alerted_at: `stuck-flagged ${stamp}` });
  console.log(`Action email sent: ${items.length} urgent, ${drafts.length} draft(s), ${stuck.length} stuck. Gmail id ${id}.`);
  return items.length + drafts.length + stuck.length;
}

module.exports = { sendUrgentAlerts };
