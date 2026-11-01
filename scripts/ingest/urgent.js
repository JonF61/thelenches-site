// scripts/ingest/urgent.js
// The per-run "action needed" email to jon@. One email per run at most, covering:
//   - urgent items (cancellation, emergency road closure): SUGGESTS a one-off extra send;
//     nothing ever goes to subscribers from here, including in holiday mode
//   - official notices awaiting a decision: their wording and our rewrite, with "Approve
//     with their wording" / "Approve with rewrite" buttons (wordingview.js). Urgent items
//     that offer the choice (official or "use my wording") show it too.
//   - replies held for Jon (complaints, data/GDPR, legal or press, children or
//     safeguarding, money, who runs the site: a holding reply has gone), follow-ups
//     needing a human (a question or new issue on a thread we've replied to), other
//     drafts awaiting a decision (Approve / Edit / Reject; Edit opens the Worker's edit
//     form, or for a draft too long for a link an email to Jon himself, edits.js), shadow-mode drafts, and replies stuck at "sending" (never
//     resent automatically). Each shows the email's class and confidence. Every card
//     also has Redraft (23 Oct): Jon says what to change, Holly writes a new draft and
//     a fresh card comes by itself (sendReplyCard, from scripts/approve).
//   - at the top, "Still owed a reply" (23 Oct): emails whose holding reply went 2 days
//     ago with no real reply since (replies.owedReplies), with Redraft, a "reply myself"
//     note and "Close, no reply needed". Shown in every action email until answered or
//     closed; on their own they trigger one at most once a day.
//
// Retry-safe: Pending and Replies "alerted_at" are stamped only after the email is sent,
// so a failed send is retried on the next run. Pending rows that don't qualify are
// stamped "skipped: ..." so they are never reconsidered.
'use strict';

const g = require('./google');
const { signedLink, editFormLink, redraftLink, linksEnabled, LINK_DAYS } = require('./links');
const replies = require('./replies');
const { offersChoice, isOfficial } = require('../../lib/wording');
const wv = require('./wordingview');
const { editLink } = require('./edits');

const TZ = 'Europe/London';
const DEFAULT_WINDOW_DAYS = 7; // override with Settings key urgent_window_days
const RECENT_DAYS = 3;         // only items received this recently are considered

const C = { green: '#3F5233', cream: '#F6F1E4', orange: '#C0703A', red: '#A33B2B', grey: '#666666', slate: '#4A5D73' };

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const truthy = (v) => String(v).trim().toUpperCase() === 'TRUE';
const isFollowup = (r) => r.type === 'followup';
const isHeld = (r) => r.type === 'held';
const isOutreach = (r) => r.type === 'outreach';
const isOwn = (r) => r.type === 'own';
const alertTo = () => process.env.ALERT_TO || process.env.GMAIL_USER;
const classLine = (r) => [r.class && `Class: ${r.class}${r.class_confidence !== '' && r.class_confidence !== undefined ? ` (${r.class_confidence})` : ''}`,
  r.policy_codes].filter(Boolean).join(' · ');

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
  const noButtons = liveButtons ? '' : ' Buttons unavailable; edit the status in the Sheet.';
  const how = 'Approve sends it (as the Sheet body cell stands); Edit opens it in a form to change and '
    + 'send (a long draft opens an email to yourself instead); Redraft asks Holly for a new version '
    + 'with your instructions (a fresh card follows); Reject sends nothing.';
  if (isFollowup(r)) {
    return 'They wrote again on a thread we already answered (see the note). This draft is never sent '
      + `unless you approve or edit it, including in holiday mode. ${how}${noButtons}`;
  }
  if (isOwn(r)) {
    return 'Your own thread: you wrote to them by hand, so Holly has not drafted anything (she can\'t sign as you). '
      + `Reply to them in Gmail (Their email, below), then tap Done.${noButtons}`;
  }
  if (isOutreach(r)) {
    return 'Outreach: a new email from Holly to this contact, which you asked for in the panel (see the note '
      + `for why). Never sent unless you approve or edit it, including in holiday mode. ${how}${noButtons}`;
  }
  if (isHeld(r) && r.hold_reason === 'possible auto-responder') {
    return 'This may be an automatic reply (see the note), so nothing has been sent, not even a holding reply. '
      + `Approve only if a real person wrote it; otherwise Reject. ${how}${noButtons}`;
  }
  if (isHeld(r)) {
    return 'They have had a holding reply. This draft never goes unless you approve or edit it, even in '
      + `holiday mode; Reject if you'd rather reply yourself (from website@). ${how}${noButtons}`;
  }
  const when = r.status === 'awaiting' && replies.FALLBACK_TYPES.includes(r.type || 'ack')
    && !String(r.policy_codes || '').includes('sender_limit')
    ? ` If you do nothing, it goes without the question ${replies.AWAIT_HOURS}h after ${r.created_at}.`
    : ' Never sent unless you approve or edit it.';
  return `Awaiting your decision. ${how}${when}${noButtons}`;
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

function itemHtml(row, rowUrl, buttons, border = C.orange) {
  const meta = [whenOf(row), row.village, row.category].filter(Boolean).join(' · ');
  const showButtons = buttons && row.status === 'pending';
  const choice = offersChoice(row);
  let buttonRow = '';
  if (showButtons) {
    buttonRow = choice
      ? `<div>${wv.buttonsHtml(row, button, C)}</div><div style="color:${C.grey};font-size:12px;margin-top:4px;">${esc(wv.defaultLine(row))}</div>`
      : `<div>${button(signedLink(row, 'approve'), 'Approve', C.green)}${button(signedLink(row, 'reject'), 'Reject', C.red)}</div>`;
  }
  return card(`
      <div style="font-size:18px;font-weight:bold;color:${C.green};margin-bottom:4px;">${esc(row.title || '(no title)')}</div>
      ${meta ? `<div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(meta)}</div>` : ''}
      ${choice ? wv.versionsHtml(row, C) : (row.summary ? `<div style="margin-bottom:8px;">${esc(row.summary)}</div>` : '')}
      ${row.contact ? `<div style="margin-bottom:8px;font-size:14px;"><b>Contact:</b> ${esc(row.contact)}</div>` : ''}
      <div style="color:${C.grey};font-size:12px;margin-bottom:8px;">From ${esc(row.source)} · received ${esc(row.received)}${row.notes ? ` · ${esc(row.notes)}` : ''}</div>
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${esc(statusLine(row, buttons))}</div>
      ${buttonRow}
      <div style="margin-top:6px;">${textLink(rowUrl(row), 'Edit in Sheet')}${row.gmail_link ? textLink(row.gmail_link, 'Original email') : ''}</div>`,
  border);
}

function replyHtml(r, ctx) {
  const showButtons = ctx.liveButtons && r.status === 'awaiting';
  const link = { id: r.reply_id, title: `Reply to ${r.to}` };
  let border = C.green;
  if (r.status === 'sending' || isHeld(r)) border = C.red;
  else if (isFollowup(r)) border = C.orange;
  // Follow-ups and enquiries: their words matter more than our draft, so the note sits
  // above the body.
  const noteFirst = !replies.FALLBACK_TYPES.includes(r.type || 'ack');
  const noteHtml = r.notes
    ? `<div style="color:${noteFirst ? '#2b2b2b' : C.grey};font-size:${noteFirst ? 14 : 12}px;margin-bottom:8px;">${esc(r.notes)}</div>`
    : '';
  return card(`
      <div style="font-size:16px;font-weight:bold;color:${C.green};margin-bottom:4px;">To ${esc(r.to)}</div>
      <div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(r.subject)}${classLine(r) ? ` · ${esc(classLine(r))}` : ''}</div>
      ${noteFirst ? noteHtml : ''}
      ${isOwn(r) ? '' : `<div style="white-space:pre-wrap;background:${C.cream};border-radius:6px;padding:10px 12px;font-size:14px;margin-bottom:8px;">${esc(r.body)}</div>`}
      ${noteFirst ? '' : noteHtml}
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${esc(replyLine(r, ctx.liveButtons))}</div>
      ${showButtons && isOwn(r) ? `<div>${ctx.gmailFor(r) ? button(ctx.gmailFor(r), 'Reply in Gmail', C.green) : ''}${button(signedLink(link, 'skip'), 'Done', C.slate)}</div>` : ''}
      ${showButtons && !isOwn(r) ? `<div>${button(signedLink(link, 'send'), 'Approve', C.green)}${button(editFormLink(r) || editLink(r, alertTo()), 'Edit', C.orange)}${button(redraftLink(r), 'Redraft', C.slate)}${button(signedLink(link, 'skip'), 'Reject', C.red)}</div>` : ''}
      <div style="margin-top:6px;">${showButtons && editFormLink(r) ? textLink(editLink(r, alertTo()), 'Edit by email') : ''}${textLink(ctx.replyUrl(r), 'Open in Sheet')}${ctx.gmailFor(r) ? textLink(ctx.gmailFor(r), !replies.FALLBACK_TYPES.includes(r.type || 'ack') ? 'Their email' : 'Original email') : ''}</div>`,
  border);
}

const REPLY_MYSELF = 'Reply myself: answer them from website@ in Gmail (Their email, below), then tap '
  + '"Close, no reply needed" so this stops.';

// Still owed a reply: the holding reply went, the real one hasn't.
function owedLine(o) {
  const d = o.draft;
  const state = !d ? 'No draft.'
    : d.status === 'awaiting' ? 'The draft below is still waiting for you.'
      : d.status === 'skipped' ? `You rejected the draft below${d.decided_at ? ` (${d.decided_at})` : ''}.`
        : `The draft below is "${d.status}".`;
  return `Holding reply sent ${o.holding.sent_at}; no real reply yet. ${state}`;
}

function owedHtml(o, ctx) {
  const d = o.draft || o.holding;
  const live = ctx.liveButtons;
  const link = (r) => ({ id: r.reply_id, title: `Reply to ${r.to}` });
  const waiting = o.draft && o.draft.status === 'awaiting';
  const buttons = live ? [
    waiting ? button(signedLink(link(o.draft), 'send'), 'Approve', C.green) : '',
    waiting ? button(editFormLink(o.draft) || editLink(o.draft, alertTo()), 'Edit', C.orange) : '',
    o.draft ? button(redraftLink(o.draft), 'Redraft', C.slate) : '',
    button(signedLink(link(o.holding), 'close'), 'Close, no reply needed', C.grey),
  ].join('') : '';
  return card(`
      <div style="font-size:16px;font-weight:bold;color:${C.green};margin-bottom:4px;">To ${esc(d.to)}</div>
      <div style="color:${C.grey};font-size:14px;margin-bottom:8px;">${esc(d.subject)}${classLine(d) ? ` · ${esc(classLine(d))}` : ''}</div>
      <div style="font-weight:bold;font-size:14px;margin-bottom:6px;">${esc(owedLine(o))}</div>
      ${o.draft && o.draft.notes ? `<div style="font-size:14px;margin-bottom:8px;">${esc(o.draft.notes)}</div>` : ''}
      ${o.draft ? `<div style="white-space:pre-wrap;background:${C.cream};border-radius:6px;padding:10px 12px;font-size:14px;margin-bottom:8px;">${esc(o.draft.body)}</div>` : ''}
      <div style="font-size:14px;margin-bottom:6px;">${esc(REPLY_MYSELF)}${live ? '' : ' Buttons unavailable; set the status in the Sheet.'}</div>
      ${buttons ? `<div>${buttons}</div>` : ''}
      <div style="margin-top:6px;">${textLink(ctx.replyUrl(d), 'Open in Sheet')}${ctx.gmailFor(d) ? textLink(ctx.gmailFor(d), 'Their email') : ''}</div>`,
  C.red);
}

function owedText(o, ctx, out) {
  const d = o.draft || o.holding;
  out.push(`To ${d.to}: ${d.subject}${classLine(d) ? ` [${classLine(d)}]` : ''}`, owedLine(o));
  if (o.draft) {
    if (o.draft.notes) out.push(o.draft.notes);
    out.push('---', o.draft.body, '---');
  }
  out.push(REPLY_MYSELF);
  if (ctx.liveButtons) {
    const link = (r) => ({ id: r.reply_id, title: `Reply to ${r.to}` });
    if (o.draft && o.draft.status === 'awaiting') {
      out.push(`Approve: ${signedLink(link(o.draft), 'send')}`);
      out.push(`Edit: ${editFormLink(o.draft) || editLink(o.draft, alertTo())}`);
    }
    if (o.draft) out.push(`Redraft: ${redraftLink(o.draft)}`);
    out.push(`Close, no reply needed: ${signedLink(link(o.holding), 'close')}`);
  }
  out.push(`Sheet: ${ctx.replyUrl(d)}`);
  if (ctx.gmailFor(d)) out.push(`Their email: ${ctx.gmailFor(d)}`);
  out.push('');
}

const SUGGESTION = 'Suggested: a one-off extra send to subscribers. There is no Send button yet (step 5b), '
  + 'so send it yourself if it is worth it. Extra sends are never automatic, including in holiday mode.';

function buildHtml(ctx) {
  const { items, choices, drafts, stuck, owed, holiday, rowUrl, buttons } = ctx;
  const held = drafts.filter((r) => r.status === 'awaiting' && isHeld(r));
  const followups = drafts.filter((r) => r.status === 'awaiting' && isFollowup(r));
  const awaiting = drafts.filter((r) => r.status === 'awaiting' && !isFollowup(r) && !isHeld(r));
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
      ${owed.length ? `${heading('Still owed a reply', C.red)}${owed.map((o) => owedHtml(o, ctx)).join('')}` : ''}
      ${items.length ? `${heading(`Urgent item${items.length === 1 ? '' : 's'}`, C.red)}
      <tr><td style="padding:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:15px;color:#2b2b2b;background:#ffffff;border-left:4px solid ${C.orange};padding:10px 12px;">${esc(SUGGESTION)}</div>
      </td></tr>
      ${items.map((r) => itemHtml(r, rowUrl, buttons)).join('')}` : ''}
      ${choices.length ? `${heading('Choose the wording', C.green)}${choices.map((r) => itemHtml(r, rowUrl, buttons, C.green)).join('')}` : ''}
      ${stuck.length ? `${heading('Replies stuck at "sending"', C.red)}${stuck.map((r) => replyHtml(r, ctx)).join('')}` : ''}
      ${held.length ? `${heading('Held for you', C.red)}${held.map((r) => replyHtml(r, ctx)).join('')}` : ''}
      ${followups.length ? `${heading('Follow-ups needing a human', C.orange)}${followups.map((r) => replyHtml(r, ctx)).join('')}` : ''}
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

function itemText(r, out, rowUrl, buttons) {
  const choice = offersChoice(r);
  out.push(r.title || '(no title)');
  const meta = [whenOf(r), r.village, r.category].filter(Boolean).join(' · ');
  if (meta) out.push(meta);
  if (choice) out.push(...wv.versionsText(r));
  else if (r.summary) out.push(r.summary);
  if (r.contact) out.push(`Contact: ${r.contact}`);
  out.push(`From ${r.source}, received ${r.received}`);
  out.push(statusLine(r, buttons));
  if (buttons && r.status === 'pending') {
    if (choice) out.push(...wv.linksText(r));
    else {
      out.push(`Approve: ${signedLink(r, 'approve')}`);
      out.push(`Reject: ${signedLink(r, 'reject')}`);
    }
  }
  out.push(`Edit: ${rowUrl(r)}`);
  if (r.gmail_link) out.push(`Original: ${r.gmail_link}`);
  out.push('');
}

function buildText(ctx) {
  const { items, choices, drafts, stuck, owed, holiday, rowUrl, buttons } = ctx;
  const out = [ctx.title, ''];
  if (holiday) out.push('Holiday mode is ON.', '');
  if (owed.length) {
    out.push('STILL OWED A REPLY', '');
    for (const o of owed) owedText(o, ctx, out);
  }
  if (items.length) {
    out.push('URGENT ITEMS', SUGGESTION, '');
    for (const r of items) itemText(r, out, rowUrl, buttons);
  }
  if (choices.length) {
    out.push('CHOOSE THE WORDING', '');
    for (const r of choices) itemText(r, out, rowUrl, buttons);
  }
  const section = (label, list) => {
    if (!list.length) return;
    out.push(label, '');
    for (const r of list) {
      const noteFirst = !replies.FALLBACK_TYPES.includes(r.type || 'ack');
      out.push(`To ${r.to}: ${r.subject}${classLine(r) ? ` [${classLine(r)}]` : ''}`);
      if (noteFirst && r.notes) out.push(r.notes);
      if (!isOwn(r)) out.push('---', r.body, '---');
      if (!noteFirst && r.notes) out.push(r.notes);
      out.push(replyLine(r, ctx.liveButtons));
      if (ctx.liveButtons && r.status === 'awaiting' && isOwn(r)) {
        out.push(`Done: ${signedLink({ id: r.reply_id, title: `Reply to ${r.to}` }, 'skip')}`);
      } else if (ctx.liveButtons && r.status === 'awaiting') {
        const link = { id: r.reply_id, title: `Reply to ${r.to}` };
        out.push(`Approve: ${signedLink(link, 'send')}`);
        if (editFormLink(r)) out.push(`Edit: ${editFormLink(r)}`);
        out.push(`Edit by email: ${editLink(r, alertTo())}`);
        out.push(`Redraft: ${redraftLink(r)}`);
        out.push(`Reject: ${signedLink(link, 'skip')}`);
      }
      out.push(`Sheet: ${ctx.replyUrl(r)}`);
      if (ctx.gmailFor(r)) out.push(`Original: ${ctx.gmailFor(r)}`);
      out.push('');
    }
  };
  section('REPLIES STUCK AT "SENDING"', stuck);
  section('HELD FOR YOU', drafts.filter((r) => r.status === 'awaiting' && isHeld(r)));
  section('FOLLOW-UPS NEEDING A HUMAN', drafts.filter((r) => r.status === 'awaiting' && isFollowup(r)));
  section('REPLIES NEEDING YOUR DECISION', drafts.filter((r) => r.status === 'awaiting' && !isFollowup(r) && !isHeld(r)));
  section('REPLY DRAFTS (SHADOW MODE, NOT SENT)', drafts.filter((r) => r.status === 'shadow'));
  return out.join('\n');
}

function subjectFor(items, choices, drafts, stuck, owed = []) {
  if (items.length) {
    return items.length === 1
      ? `URGENT: ${items[0].title || 'new item'} (Lenches)`
      : `URGENT: ${items.length} items (Lenches)`;
  }
  if (choices.length) {
    return choices.length === 1
      ? `Choose the wording: ${choices[0].title || 'new item'} (Lenches)`
      : `Choose the wording: ${choices.length} items (Lenches)`;
  }
  if (stuck.length) return `Action needed: ${stuck.length} reply(ies) stuck (Lenches)`;
  if (owed.length) return `Action needed: ${owed.length} email(s) still owed a reply (Lenches)`;
  const held = drafts.filter((r) => r.status === 'awaiting' && isHeld(r)).length;
  if (held) return `Action needed: ${held} email(s) held for you (Lenches)`;
  const follow = drafts.filter((r) => r.status === 'awaiting' && isFollowup(r)).length;
  if (follow) return `Action needed: ${follow} follow-up(s) need a reply (Lenches)`;
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

// Approval emails (1 Nov, Jon): off unless Settings approval_emails is TRUE. Jon decides in
// the admin panel; drafts, wording choices and owed replies are no longer emailed, and no
// per-draft cards are sent. Urgent items and replies stuck at "sending" still email him.
const approvalEmails = (settings) => truthy((settings || {}).approval_emails);

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

  // Official notices awaiting a decision (urgent ones are above). "Use my wording" items
  // default to their wording, so they wait for the digest.
  const choices = rows.filter((r) => r.id && r.status === 'pending' && offersChoice(r) && isOfficial(r)
    && !truthy(r.urgent) && !String(r.alerted_at).trim() && String(r.received).slice(0, 10) >= since);

  // Replies.
  const mode = replies.repliesMode(settings);
  let drafts = [];
  let stuck = [];
  let owed = [];
  if (mode !== 'off') {
    const replyRows = await g.readTable('Replies');
    if (replyRows.length && !('alerted_at' in replyRows[0])) {
      throw new Error('Replies tab has no "alerted_at" header (O1); add it so drafts are not repeated');
    }
    ({ drafts, stuck } = replies.rowsForAlert(replyRows));
    owed = replies.owedReplies(replyRows);
    // A draft shown under "Still owed a reply" isn't shown again below.
    const inOwed = new Set(owed.map((o) => o.draft && o.draft.reply_id).filter(Boolean));
    drafts = drafts.filter((r) => !inOwed.has(r.reply_id));
  }
  if (!approvalEmails(settings)) { choices.length = 0; drafts = []; owed = []; }
  // Owed emails go in every action email, but trigger one on their own only once a day.
  const owedNow = replies.owedDue(owed).length;
  if (!items.length && !choices.length && !drafts.length && !stuck.length && !owedNow) return 0;

  const buttons = linksEnabled();
  if (!buttons) console.warn('WORKER_URL or APPROVAL_SIGNING_KEY not set: email sent without buttons.');
  const gmailByMessage = new Map(rows.map((r) => [r.message_id, r.gmail_link]));
  const ctx = {
    items,
    choices,
    drafts,
    stuck,
    owed,
    holiday,
    buttons,
    liveButtons: buttons && mode === 'live',
    rowUrl: items.length || choices.length ? await sheetUrl('Pending') : null,
    replyUrl: drafts.length || stuck.length || owed.length ? await sheetUrl('Replies') : null,
    // Follow-ups have no Pending row, so fall back to a link built from the message id.
    gmailFor: (r) => gmailByMessage.get(r.message_id)
      || (r.message_id ? `https://mail.google.com/mail/u/0/#all/${r.message_id}` : ''),
    title: items.length ? 'Urgent and action needed' : 'Action needed',
  };

  const id = await g.sendMail({
    to: process.env.ALERT_TO || process.env.GMAIL_USER,
    subject: subjectFor(items, choices, drafts, stuck, owed),
    text: buildText(ctx),
    html: buildHtml(ctx),
    fromName: g.fromNameFor(settings),
  });

  const stamp = londonDateTime(Date.now());
  for (const r of [...items, ...choices]) await g.updateRow('Pending', r._row, { alerted_at: stamp });
  for (const r of drafts) await g.updateRow('Replies', r._row, { alerted_at: stamp });
  for (const r of stuck) await g.updateRow('Replies', r._row, { alerted_at: `stuck-flagged ${stamp}` });
  for (const o of owed) {
    await g.updateRow('Replies', o.holding._row, { alerted_at: `owed ${stamp}` });
    if (o.draft && !String(o.draft.alerted_at || '').trim()) await g.updateRow('Replies', o.draft._row, { alerted_at: stamp });
  }
  console.log(`Action email sent: ${owed.length} owed, ${items.length} urgent, ${choices.length} wording choice(s), ${drafts.length} draft(s), ${stuck.length} stuck. Gmail id ${id}.`);
  return items.length + choices.length + drafts.length + stuck.length + owed.length;
}

// One fresh card for one reply (the redraft Jon asked for), sent from scripts/approve.
// Stamps alerted_at once sent; if this fails the next ingestion run's action email shows it.
// title / subject: the card's heading and subject line (default: a redraft). Outreach
// drafts (scripts/outreach) pass their own.
async function sendReplyCard(replyId, settings, { title = 'Redrafted reply', subject = '' } = {}) {
  const rows = await g.readTable('Replies');
  const r = rows.find((x) => x.reply_id === replyId);
  if (!r) throw new Error(`Reply ${replyId} not found in Replies`);
  if (!approvalEmails(settings)) {
    console.log(`${title} card for ${replyId} not emailed: approval emails are off (it is in the admin panel).`);
    return null;
  }
  const mode = replies.repliesMode(settings);
  const buttons = linksEnabled();
  if (!buttons) console.warn('WORKER_URL or APPROVAL_SIGNING_KEY not set: card sent without buttons.');
  const ctx = {
    items: [], choices: [], drafts: [r], stuck: [], owed: [],
    holiday: String(settings.holiday_mode || '').toUpperCase() === 'TRUE',
    buttons,
    liveButtons: buttons && mode === 'live',
    rowUrl: null,
    replyUrl: await sheetUrl('Replies'),
    gmailFor: (x) => (x.message_id ? `https://mail.google.com/mail/u/0/#all/${x.message_id}` : ''),
    title,
  };
  const id = await g.sendMail({
    to: alertTo(),
    subject: subject || `Redraft ready: reply to ${r.to} (Lenches)`,
    text: buildText(ctx),
    html: buildHtml(ctx),
    fromName: g.fromNameFor(settings),
  });
  await g.updateRow('Replies', r._row, { alerted_at: londonDateTime(Date.now()) });
  console.log(`${title} card for ${replyId} sent. Gmail id ${id}.`);
  return id;
}

module.exports = {
  approvalEmails, sendUrgentAlerts, sendReplyCard };
