// worker/src/admin/feedback.js
// The panel's Feedback screen (reader feedback form, worker/src/feedback.js). Rows live in
// the Feedback tab; status moves new -> approved -> implemented, or new -> rejected, or
// new -> "postponed until YYYY-MM-DD" (hidden until that date, then waiting again).
// Implemented and rejected items with an email get a reply draft (Holly) for Send / Edit /
// Skip; Reject takes an optional reason, never sent as written, that the draft is built from.
//   Approve, Reject, Postpone, Mark implemented, and the reply's Send, Edit and Skip are
//   decisions: core.js decide() -> approval.yml -> scripts/approve -> scripts/readerfeedback,
//   the one approval path. Mark implemented and Reject draft the reply there (only if an
//   email was given); nothing is sent until Send or Edit, and nothing on postpone.
//   Add note is a stale-checked append to the notes cell (timestamped; the old text is
//   always kept, and a cell changed since the page loaded refuses the write).

import { validPayload, cleanBody, cleanReason } from '../core.js';
import { londonStamp } from '../feedback.js';

const POSTPONED = /^postponed until (\d{4}-\d{2}-\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POSTPONE_DAYS = 366;
const MAX_NOTE = 500;
const MAX_REASON = 300;
const MAX_NOTES_CELL = 20000;
const WAITING = new Set(['', 'new']);

const str = (v) => String(v ?? '').trim();
const refuse = (status, error) => ({ error, status });

export function postponedUntil(row) {
  const m = str(row.status).toLowerCase().match(POSTPONED);
  return m ? m[1] : '';
}

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Where a row sits on the screen ('' = not a feedback row at all).
//   waiting    new, or postponed until today or earlier
//   postponed  hidden until its date
//   approved   approved, awaiting build
//   reply      implemented or rejected, a reply draft waiting for Send / Edit / Skip
//              (also when the reader has written back: scripts/readerfeedback attachReply)
//   done       finished (rejected or implemented, reply sent or skipped or no email): History
export function feedbackState(row, today) {
  if (!str(row.id)) return '';
  const s = str(row.status).toLowerCase();
  if (WAITING.has(s)) return str(row.message) ? 'waiting' : '';
  const until = postponedUntil(row);
  if (until) return until <= today ? 'waiting' : 'postponed';
  if (s === 'approved') return 'approved';
  if (s === 'implemented' || s === 'rejected') return str(row.email) && !str(row.reply_sent) ? 'reply' : 'done';
  return 'done';
}

// Every row, each with _state (History needs the finished ones). A missing tab is empty.
export function feedbackRows(table, today) {
  if (!table || table.error) return table;
  return {
    headers: table.headers,
    rows: table.rows.map((r) => ({ ...r, _state: feedbackState(r, today) })).filter((r) => r._state),
  };
}

// Action -> the decide() payload. row: the Feedback row (null if not found).
// Returns { p, body } or { error, status }.
export function planFeedback({ action, id, date, body, reason }, row, today) {
  const a = `fb_${String(action || '')}`;
  if (!['fb_approve', 'fb_reject', 'fb_postpone', 'fb_done', 'fb_send', 'fb_edit', 'fb_skip'].includes(a)) {
    return refuse(400, `Unknown action "${action}"`);
  }
  if (!row) return refuse(404, `No Feedback row ${id}`);
  const state = feedbackState(row, today);
  const p = { a, i: String(id) };
  if (['fb_approve', 'fb_reject', 'fb_postpone'].includes(a)) {
    if (state !== 'waiting' && state !== 'postponed') return refuse(409, `This feedback is already "${str(row.status)}"`);
    if (a === 'fb_postpone') {
      const d = str(date);
      if (!DATE.test(d) || Number.isNaN(Date.parse(d))) return refuse(400, 'Choose a date');
      if (d <= today) return refuse(400, 'Choose a date after today');
      if (d > addDays(today, MAX_POSTPONE_DAYS)) return refuse(400, 'Choose a date within a year');
      p.d = d;
    }
    if (a === 'fb_reject') {
      const r = cleanReason(reason, MAX_REASON);
      if (!validPayload(p)) return refuse(400, 'Invalid feedback id');
      return { p, reason: r, body: '' };
    }
  } else if (a === 'fb_done') {
    if (state !== 'approved') return refuse(409, `This feedback is "${str(row.status)}", not approved`);
  } else {
    if (state !== 'reply') return refuse(409, 'There is no reply waiting for this feedback');
    if (a !== 'fb_skip' && !str(row.reply_draft)) return refuse(409, 'The reply is not drafted yet: reload in a minute');
    if (a === 'fb_edit') {
      p.b = cleanBody(body);
      if (p.b.length < 10) return refuse(400, 'The reply text is empty');
    }
  }
  if (!validPayload(p)) return refuse(400, 'Invalid feedback id');
  return { p, body: p.b || '' };
}

// Add note: the new notes cell (old text kept, the note on a new line with the UK time).
// Returns { value } or { error, status }.
// Built on expected (the cell as the page loaded it); checkedWrite refuses if it changed.
export function planNote({ note, expected }, row, ms = Date.now()) {
  if (!row) return refuse(404, 'No such Feedback row');
  const n = cleanReason(note, MAX_NOTE + 1);
  if (n.length < 2) return refuse(400, 'Type a note first');
  if (n.length > MAX_NOTE) return refuse(400, `Notes are up to ${MAX_NOTE} characters`);
  const old = String(expected ?? '');
  const value = `${old ? `${old}\n` : ''}${londonStamp(ms)} ${n}`;
  if (value.length > MAX_NOTES_CELL) return refuse(400, 'The notes cell is full');
  return { value };
}
