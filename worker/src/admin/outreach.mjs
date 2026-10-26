// worker/src/admin/outreach.mjs (.mjs so scripts/outreach can import it without a warning)
// Contacts phase 3, outreach (26 Oct 2026): who is due a friendly nudge from Holly, worked
// out from the Contacts and Replies tabs on each load. Pure: no Google, GitHub or Claude
// calls. Also used by scripts/outreach (dynamic import), so the panel and the drafting run
// apply the same rules.
//   seasonal  sent something last year whose anniversary is 4 weeks away to a week past,
//             and nothing since 60 days before that anniversary
//   quiet     contributor, organiser or collaborator with no email for 90 to 365 days
//   lead      status lead, no contributions, first email 14+ days ago, last within a year
// Left out: ignore rows, any status not named above (e.g. "not a contributor", official,
// business, media or Jon's own text), Contacts next_nudge "never" or a date still to come
// (snoozed), and anyone with an outreach draft in the Replies tab from the last 120 days
// (skipped or failed drafts don't count). At most WEEK_CAP outreach drafts a week.
// A draft is requested from the panel (Draft nudge -> decide() action "nudge", id = idFor
// email, so the address never appears in the public Actions log) and written by
// scripts/outreach as a Replies row of type "outreach", status "awaiting": only Jon's
// Approve or Edit sends it, never the 24h fallback or holiday mode.

export const QUIET_DAYS = 90;
export const DORMANT_DAYS = 365;
export const LEAD_DAYS = 14;
export const GAP_DAYS = 120;
export const SEASON_BEFORE = 28;
export const SEASON_AFTER = 7;
export const SEASON_CLEAR = 60;
export const WEEK_CAP = 5;
export const QUIET_STATUSES = ['contributor', 'organiser', 'collaborator'];
export const NUDGE_TYPE = 'outreach';
// Replies statuses that mean the nudge did (or may yet) go.
const LIVE = ['awaiting', 'queued', 'sending', 'sent', 'shadow'];

const DAY = 864e5;
const str = (v) => String(v ?? '').trim();
const low = (v) => str(v).toLowerCase();
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const ms = (d) => Date.parse(`${d}T12:00:00Z`);
const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY);
const addDays = (d, n) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);

// The panel's id for a contact: "c" + the first 16 hex of SHA-256(lower-cased email).
export async function idFor(email) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(low(email)));
  return `c${[...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Contacts "contributions" cell -> [{ date, title }] (dated entries only, newest first).
export function contributionList(cell) {
  return str(cell).split('; ').map((s) => s.match(/^(\d{4}-\d{2}-\d{2})\s+(.*?)(?:\s+\([^()]*\))?$/))
    .filter(Boolean).map((m) => ({ date: m[1], title: m[2].trim() }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// This contact's outreach rows in Replies, newest first.
export function nudgesFor(email, replies) {
  const e = low(email);
  return (replies || []).filter((r) => r.type === NUDGE_TYPE && low(r.to) === e)
    .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
}

// Outreach drafts made in the 7 days to today (any status).
export function weekCount(replies, today) {
  const from = addDays(today, -6);
  return (replies || []).filter((r) => r.type === NUDGE_TYPE && str(r.created_at).slice(0, 10) >= from).length;
}

// Why this contact is held back from outreach today, or ''.
export function heldBack(row, replies, today) {
  if (low(row.status) === 'ignore') return 'marked ignore';
  const next = low(row.next_nudge);
  if (next === 'never') return 'never nudge';
  if (isDay(next) && next > today) return `snoozed until ${next}`;
  const last = nudgesFor(row.email, replies).find((r) => LIVE.includes(low(r.status)));
  if (last) {
    if (low(last.status) === 'awaiting') return 'a draft is waiting for you';
    const d = str(last.created_at).slice(0, 10);
    if (isDay(d) && daysBetween(d, today) < GAP_DAYS) return `nudged ${d}`;
  }
  return '';
}

// The anniversary of a past contribution that is due today, or null.
// { date, title, anniversary } for the nearest one.
export function seasonalFor(row, today) {
  const items = contributionList(row.contributions);
  let best = null;
  for (const it of items) {
    if (daysBetween(it.date, today) < 300) continue;
    const [, m, d] = it.date.split('-');
    for (const y of [Number(today.slice(0, 4)) - 1, Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
      const a = `${y}-${m}-${d === '29' && m === '02' ? '28' : d}`;
      const gap = daysBetween(today, a); // days until the anniversary
      if (gap > SEASON_BEFORE || gap < -SEASON_AFTER) continue;
      const clear = addDays(a, -SEASON_CLEAR);
      if (items.some((x) => x.date >= clear)) continue; // they've already sent this season
      if (!best || Math.abs(gap) < Math.abs(daysBetween(today, best.anniversary))) best = { ...it, anniversary: a };
    }
  }
  return best;
}

// Why this contact is due, or null: { kind: seasonal|quiet|lead, why, item? }.
export function dueFor(row, today) {
  const status = low(row.status);
  const last = str(row.last_contact);
  const first = str(row.first_contact);
  const since = isDay(last) ? daysBetween(last, today) : null;
  if (status !== 'lead' && !QUIET_STATUSES.includes(status)) return null;
  if (status !== 'lead') {
    const s = seasonalFor(row, today);
    if (s) return { kind: 'seasonal', why: `Last year: ${s.date} ${s.title}`, item: s };
  }
  if (QUIET_STATUSES.includes(status) && since !== null && since >= QUIET_DAYS && since <= DORMANT_DAYS) {
    return { kind: 'quiet', why: `No email since ${last}` };
  }
  if (status === 'lead' && !(Number(row.contribution_count) > 0) && isDay(first)
    && daysBetween(first, today) >= LEAD_DAYS && since !== null && since <= DORMANT_DAYS) {
    return { kind: 'lead', why: `First wrote ${first}; nothing sent yet` };
  }
  return null;
}

// The panel's Outreach view: { seasonal, quiet, lead, held, sent, week, cap } (sent: the latest
// 50 nudges that went, with the contact's name). Each entry is
// { email, id, name, organisation, village, role, status, last_contact, why, held }; held
// (snoozed, a draft waiting, nudged recently) are listed separately so they can be undone.
export async function outreachLists(contacts, replies, today) {
  const names = new Map((contacts || []).map((r) => [low(r.email), str(r.name) || str(r.organisation)]));
  const sent = sentRows(replies, { type: NUDGE_TYPE, limit: 50 }).map((r) => ({ ...r, name: names.get(low(r.to)) || '' }));
  const out = { seasonal: [], quiet: [], lead: [], held: [], sent, week: weekCount(replies, today), cap: WEEK_CAP };
  for (const r of contacts || []) {
    if (!str(r.email)) continue;
    const due = dueFor(r, today);
    if (!due) continue;
    const held = heldBack(r, replies, today);
    const entry = {
      email: str(r.email), id: await idFor(r.email), name: str(r.name), organisation: str(r.organisation),
      village: str(r.village), role: str(r.role), status: str(r.status), last_contact: str(r.last_contact),
      next_nudge: str(r.next_nudge), kind: due.kind, why: due.why, held,
    };
    (held ? out.held : out[due.kind]).push(entry);
  }
  const byLast = (a, b) => a.last_contact.localeCompare(b.last_contact) || (a.name || a.email).localeCompare(b.name || b.email);
  for (const k of ['seasonal', 'quiet', 'lead', 'held']) out[k].sort(byLast);
  return out;
}

// Draft nudge from the panel: { ok } or { error, status }. row: the Contacts row or null.
export function planNudge(row, replies, today) {
  if (!row) return { error: 'No such contact: reload the page', status: 404 };
  const held = heldBack(row, replies, today);
  if (held) return { error: `Not drafted: ${held}`, status: 409 };
  if (!dueFor(row, today)) return { error: 'Not drafted: this contact is not on an outreach list today', status: 409 };
  if (weekCount(replies, today) >= WEEK_CAP) return { error: `Not drafted: ${WEEK_CAP} outreach drafts already this week`, status: 429 };
  return { ok: true };
}

// Sent mail from the Replies tab, newest first: { reply_id, to, type, subject, body, sent_at }.
// type: only that Replies type (e.g. NUDGE_TYPE), else every type. Used by the panel's Replies
// screen (Sent history) and the Outreach view (Sent nudges).
export function sentRows(replies, { type = '', limit = 100 } = {}) {
  return (replies || [])
    .filter((r) => low(r.status) === 'sent' && (!type || r.type === type))
    .sort((a, b) => str(b.sent_at).localeCompare(str(a.sent_at)))
    .slice(0, limit)
    .map((r) => ({ reply_id: str(r.reply_id), to: str(r.to), type: str(r.type), subject: str(r.subject), body: str(r.body), sent_at: str(r.sent_at) }));
}
