// scripts/contacts/contacts.js
// Pure helpers for the Contacts tab (no Google or Claude calls; tested offline by
// scripts/test-contacts.js). One row per person who has written to website@:
//   email               lower-cased sender address (the key)
//   name                display name, or as Claude read it from the signature
//   organisation        club, church, council, business... they write for ('' if just themselves)
//   village             where they are, if known
//   role                e.g. "secretary, Lenches Club"
//   profile             2-4 sentences to help us deal with them
//   contributions       what they have sent us (from Pending), newest first, "; " separated
//   contribution_count  Pending rows from this address
//   first_contact       YYYY-MM-DD of their first email to website@
//   last_contact        YYYY-MM-DD of their latest email to website@
//   message_count       emails to website@ counted
//   status              what they are to us: contributor, lead (a potential contributor),
//                       collaborator, official, organiser, business, media or other. Claude
//                       picks it for a new contact; code never changes it once set (set by
//                       hand in the panel or Sheet). ignore = the row is cleared to just email
//                       and status (a "deleted" contact that a later run can't re-add) and Read
//                       Sheet tab skips it. Someone who writes only to subscribe, ask a question
//                       and so on (Claude: "none") is never added.
//   notes               Jon's own notes; never written by code
//   profile_source      auto = code may rewrite name/organisation/village/role/profile;
//                       anything else (e.g. manual) = left alone
//   updated_at          YYYY-MM-DD HH:MM UK of the last code update
'use strict';

const TAB = 'Contacts';
const HEADERS = ['email', 'name', 'organisation', 'village', 'role', 'profile', 'contributions',
  'contribution_count', 'first_contact', 'last_contact', 'message_count', 'status', 'notes',
  'profile_source', 'updated_at'];
const WEBSITE = 'website@thelenches.org.uk';
const MAX_RECIPIENTS = 10;      // a reply-all to a bigger list is not someone writing to us
const MAX_CONTRIBUTIONS = 40;   // listed in the cell (the count covers all)
const PROFILE_FIELDS = ['name', 'organisation', 'village', 'role', 'profile'];
// Status choices (the panel's dropdown offers the same, plus ignore).
const STATUSES = ['contributor', 'lead', 'collaborator', 'official', 'organiser', 'business', 'media', 'other'];
// Statuses from phase 1 (worked out by code) that the one-off RECLASSIFY run may replace.
const OLD_AUTO = ['', 'contributor', 'lead', 'dormant'];
// Mail from before this UK date is never read (agreed 25 Oct 2026, after Jon's one-off tidy of
// the tab): so deleted contacts can't come back from old mail, even on a FULL run.
const CUTOFF = '2026-10-26';
// The panel's Delete logs each deletion here; mail from that address sent before then is ignored.
const DELETED_TAB = 'Deleted contacts';
const DELETED_HEADERS = ['email', 'deleted_at'];

// Never contacts: our own mail, platforms and services.
const EXCLUDED_DOMAINS = /(^|\.)(thelenches\.org\.uk|facebook\.com|facebookmail\.com|mailerlite\.com|feedrabbit\.com|google\.com|github\.com|cloudflare\.com|anthropic\.com|123-reg\.co\.uk)$/i;
const AUTO_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?)([+._-]|$)/i;
const AUTO_SUBJECT = /^\s*\[?\s*(automatic reply|auto[-\s]?reply|autoreply|out of (the )?office|undeliverable|delivery status notification)\b/i;

const norm = (s) => String(s || '').trim().toLowerCase();
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

function addressesIn(value) {
  return (String(value || '').match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map(norm);
}

function excludedAddress(addr) {
  const a = norm(addr);
  if (!a.includes('@')) return true;
  const [local, domain] = a.split('@');
  return EXCLUDED_DOMAINS.test(domain) || AUTO_LOCAL.test(local);
}

// Reason this message does not count as someone writing to website@, or ''.
// msg is scripts/ingest/google.js getMessage() output; labelled = it has the Pipeline
// label (mail Bcc'd to website@ may not name it in any header).
function skipReason(msg, labelled = false) {
  if (excludedAddress(msg.fromAddress)) return 'excluded sender';
  const a = msg.auto || {};
  const as = norm(a.autoSubmitted);
  if ((as && as !== 'no') || a.xAutoreply || a.xAutorespond || a.returnPath === '') return 'automated';
  if (AUTO_SUBJECT.test(String(msg.subject || ''))) return 'automated';
  const recipients = addressesIn(msg.recipients);
  if (!labelled && !recipients.includes(WEBSITE)) return 'not to website@';
  const people = new Set(recipients.filter((r) => r !== WEBSITE));
  if (msg.inReplyTo && people.size > MAX_RECIPIENTS) return 'reply-all to a list';
  return '';
}

// Why this (otherwise counted) message is too old to read, or ''. deleted: Map email -> ms.
function tooOld(msg, deleted = new Map()) {
  if (ymd(msg.internalDate) < CUTOFF) return 'before cut-off';
  const d = deleted.get(norm(msg.fromAddress));
  if (d !== undefined && Number(msg.internalDate) <= d) return 'before deletion';
  return '';
}

// Deleted contacts tab rows -> Map email -> latest deletion time (ms).
function deletedMap(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const e = norm(r.email);
    const t = Date.parse(String(r.deleted_at || ''));
    if (e && !Number.isNaN(t) && !(out.get(e) >= t)) out.set(e, t);
  }
  return out;
}

const validStatus = (s) => (STATUSES.includes(norm(s)) ? norm(s) : '');

// Display name from "Name <a@b>", '' if none.
function displayName(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*</);
  const name = m ? m[1].trim() : '';
  return name.includes('@') ? '' : name;
}

// Pending rows from this address -> { list: 'YYYY-MM-DD title (category, status); ...', count }.
function contributionsFor(email, pendingRows, addressOf) {
  const mine = pendingRows
    .filter((r) => addressOf(r.from) === email && String(r.title || '').trim())
    .sort((a, b) => String(b.received).localeCompare(String(a.received)));
  const list = mine.slice(0, MAX_CONTRIBUTIONS).map((r) => {
    const tags = [r.category, r.status].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
    return `${String(r.received || '').slice(0, 10)} ${String(r.title).trim()}${tags ? ` (${tags})` : ''}`.trim();
  });
  return { list: list.join('; '), count: mine.length };
}

// Group counted messages by sender: Map email -> { email, name, messages: [msg...] } (oldest first).
function groupBySender(messages) {
  const by = new Map();
  for (const m of [...messages].sort((a, b) => a.internalDate - b.internalDate)) {
    const e = norm(m.fromAddress);
    if (!by.has(e)) by.set(e, { email: e, name: '', messages: [] });
    const c = by.get(e);
    c.messages.push(m);
    c.name = displayName(m.from) || c.name;
  }
  return by;
}

// New status for a row: Claude's choice, only while the status is blank; else null (kept).
function statusFor(current, proposed) {
  if (norm(current)) return null;
  return validStatus(proposed) || null;
}

// Whether a new sender goes on the list: only if Claude placed them (not "none" or failed).
const shouldAdd = (profile) => Boolean(profile && validStatus(profile.status));

// The fields code writes for one contact. existing: current Sheet row or null.
// profile: Claude's { name, organisation, village, role, profile, status } or null (not asked this run).
function mergeRow(existing, sender, contrib, profile, nowUk) {
  const ex = existing || {};
  const dates = sender.messages.map((m) => ymd(m.internalDate));
  const first = [ex.first_contact, dates[0]].filter(Boolean).sort()[0] || '';
  const last = [ex.last_contact, dates[dates.length - 1]].filter(Boolean).sort().pop() || '';
  const newCount = sender.messages.filter((m) => !ex.last_contact || ymd(m.internalDate) > ex.last_contact).length;
  const out = {
    email: sender.email,
    contributions: contrib.list,
    contribution_count: contrib.count,
    first_contact: first,
    last_contact: last,
    message_count: (existing ? Number(ex.message_count) || 0 : 0) + (existing ? newCount : sender.messages.length),
    updated_at: nowUk,
  };
  const status = statusFor(existing ? ex.status : '', profile && profile.status);
  if (status) out.status = status;
  if (!existing) out.profile_source = 'auto';
  const auto = !existing || norm(ex.profile_source) === 'auto';
  if (auto && profile) {
    for (const f of PROFILE_FIELDS) if (String(profile[f] || '').trim()) out[f] = String(profile[f]).trim();
  }
  if (!out.name && !ex.name && sender.name) out.name = sender.name;
  return out;
}

// Whether code may touch this existing row at all.
function locked(existing) {
  return Boolean(existing) && norm(existing.status) === 'ignore';
}

// Fields to blank on an ignore row (everything but email and status), or null if already clear.
function clearIgnored(existing) {
  const out = {};
  for (const h of HEADERS) {
    if (h !== 'email' && h !== 'status' && String(existing[h] ?? '').trim()) out[h] = '';
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  TAB, HEADERS, WEBSITE, PROFILE_FIELDS, STATUSES, OLD_AUTO, CUTOFF, DELETED_TAB, DELETED_HEADERS,
  norm, ymd, excludedAddress, skipReason, tooOld, deletedMap, validStatus, displayName, contributionsFor, groupBySender,
  mergeRow, locked, clearIgnored, statusFor, shouldAdd,
};
