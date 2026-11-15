// worker/src/admin/autowindow.mjs
// Veto window (graduated autonomy stage 3; Jon, 15 Nov 2026). An emailed listing write-up of a
// kind Jon has switched on, while that kind's latest 20 decisions were all approved as written,
// gets a time (Pending `auto_at`) after which it publishes itself unless Jon stops it. Shared by
// the Worker (cron and panel) and scripts/ingest (await import()). Pure: no Sheet calls here.
//   Switch      Settings `auto_window`: the kinds switched on, comma separated ("event",
//               "event,notice"); blank or "off" = nothing is automatic. Panel: Autonomy screen.
//   Qualifies   NEEDED decisions on that kind's emailed write-ups since COUNT_FROM, the latest
//               NEEDED all approved as written (worked out afresh each time, so one edit or
//               rejection stops new windows until the latest NEEDED are clean again).
//   Window      WINDOW_MIN minutes counted only between DAY_START and DAY_END UK time.
//   Never       blockers(): anything on the never-automatic list, whatever the numbers.
//   auto_at     "YYYY-MM-DD HH:MM" (UK) = publishes itself then; "held: <why>" = stopped (Jon's
//               Hold or edit, or a check at the end of the window); "publishing <time>" = the
//               Worker has sent the approve; "published <time>" = scripts/approve applied it.
//   End         the Worker's half-hourly cron sends the ordinary `approve` through decide(),
//               after planPending's own checks: the same path as Jon's tap, never a second one.
//   Audit       Item feedback outcome `window` (published itself, not yet looked at) ->
//               `window_ok` (Fine: counts as approved as written) or `window_bad` (Not right:
//               counts as a rejection, so the kind stops qualifying).

export const SETTING = 'auto_window';
export const EMAIL_SETTING = 'auto_window_emails';
export const COLUMN = 'auto_at';
export const KINDS = ['event', 'notice'];
export const KIND_LABELS = { event: 'Emailed events', notice: 'Emailed notices' };
export const NEEDED = 20;
export const WINDOW_MIN = 240;
export const DAY_START = 8 * 60;
export const DAY_END = 21 * 60;
export const MIN_CONFIDENCE = 0.8;
export const AUDIT_SAMPLE = 5;
export const MAX_PER_RUN = 10;
// As autonomy.js COUNT_FROM (the 2 Nov clear-down).
export const COUNT_FROM = '2026-11-02 18:50';
const TZ = 'Europe/London';
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const IGNORED = 'ignored:';

const str = (v) => String(v ?? '').trim();
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));
const pad = (n) => String(n).padStart(2, '0');

// Settings value -> the kinds switched on.
export function kindsOn(value) {
  return [...new Set(str(value).toLowerCase().split(/[\s,;]+/).filter((k) => KINDS.includes(k)))];
}
// The Settings value for a set of kinds (panel toggle), or null if any is unknown.
export function settingFor(kinds) {
  const list = [...new Set((kinds || []).map((k) => str(k).toLowerCase()).filter(Boolean))];
  if (list.some((k) => !KINDS.includes(k))) return null;
  return KINDS.filter((k) => list.includes(k)).join(',');
}

// UK wall-clock "YYYY-MM-DD HH:MM" for a time in ms.
export function ukStamp(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export const isWindowTime = (v) => STAMP.test(str(v));

// When a window opened at `stamp` (UK wall clock) ends: WINDOW_MIN minutes later, counting only
// the minutes between DAY_START and DAY_END. Wall-clock arithmetic, so a clock change can move
// it by an hour, which doesn't matter here.
export function windowEnd(stamp, minutes = WINDOW_MIN) {
  if (!isWindowTime(stamp)) return '';
  const [d, t] = stamp.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  let day = Date.UTC(y, mo - 1, da);
  let at = Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let left = minutes;
  for (let guard = 0; guard < 60; guard += 1) {
    if (at < DAY_START) at = DAY_START;
    if (at >= DAY_END) { day += 86400000; at = DAY_START; }
    const room = DAY_END - at;
    if (left <= room) { at += left; break; }
    left -= room;
    day += 86400000;
    at = DAY_START;
  }
  const dt = new Date(day);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
}

// An Item feedback outcome as the Autonomy screen counts it: unchanged | changed | rejected | ''.
export function itemVerdict(outcome) {
  const o = str(outcome).toLowerCase();
  if (o === 'approved' || o === 'window_ok') return 'unchanged';
  if (o === 'edited') return 'changed';
  if (o === 'rejected' || o === 'window_bad') return 'rejected';
  return '';
}
// Never automatic, whatever the numbers (as the Autonomy screen's "Never automatic").
export const itemNever = (type, flags) => /-official$/.test(str(type)) || /\b(people_in_image|political_commercial|official)\b/.test(str(flags));

// Progress of one kind (event | notice) of emailed write-up towards its window, from the Item
// feedback rows: { decided, run, toGo, clean }. run = how many of the newest decisions in a
// row were approved as written; clean = at least NEEDED decided and the newest NEEDED all so.
export function kindProgress(feedbackRows, kind) {
  const list = (feedbackRows || [])
    .filter((r) => (str(r.type) || 'notice') === kind && (str(r.source_kind) || 'email') === 'email' && !itemNever(r.type, r.flags))
    .map((r) => ({ at: str(r.decided_at || r.created_at), v: str(r.outcome).startsWith(IGNORED) ? '' : itemVerdict(r.outcome) }))
    .filter((d) => d.v && d.at >= COUNT_FROM)
    .sort((a, b) => b.at.localeCompare(a.at));
  let run = 0;
  while (run < list.length && list[run].v === 'unchanged') run += 1;
  const clean = list.length >= NEEDED && run >= NEEDED;
  return { decided: list.length, run, toGo: Math.max(0, NEEDED - Math.min(run, list.length)), clean };
}

// Why a Pending row never gets (or loses) a window: [] when nothing stops it. Works on the row as
// ingest builds it (booleans) and as the Sheet returns it (strings). extra: { outOfScope } from
// the extraction of the whole email (ingest only).
const OK_FLAGS = new Set(['too_early', 'after_deadline']);
export function blockers(row, extra = {}) {
  const why = [];
  const notes = str(row.notes);
  const kind = str(row.category).toLowerCase();
  if (str(row.status) !== 'pending') why.push('not waiting');
  if (!KINDS.includes(kind)) why.push('not an event or notice');
  if (!str(row.message_id) || str(row.message_id).startsWith('rss:')) why.push('not from an email');
  if (truthy(row.official)) why.push('official');
  if (truthy(row.people_in_image)) why.push('people in the image');
  if (truthy(row.political_commercial)) why.push('political or commercial');
  if (truthy(row.verbatim_requested)) why.push('asked for their own wording');
  if (str(row.duplicate) || /Already listed:/.test(notes)) why.push('already listed');
  if (truthy(row.possible_repeat) || /Possible repeat/.test(notes)) why.push('possible repeat');
  if (/Regular activity:/.test(notes)) why.push('regular activity');
  if (/Possible spam/i.test(notes)) why.push('possible spam');
  if (/(^|,)\s*(where|date)\s*(,|$)/.test(str(row.missing))) why.push('date or place missing');
  if (extra.outOfScope) why.push('out of scope');
  const flags = str(row.policy_flags).split(',').map(str).filter(Boolean).filter((f) => !OK_FLAGS.has(f));
  if (flags.length) why.push(`flagged ${flags.join(', ').replace(/_/g, ' ')}`);
  const choice = str(row.image_choice).toLowerCase();
  if (choice && choice !== 'none') why.push('a suggested image was chosen');
  if (!(Number(row.confidence) >= MIN_CONFIDENCE)) why.push('low confidence');
  return [...new Set(why)];
}

// Ingest: the auto_at for a new Pending row, or ''. win: { on: [kinds], progress: { kind: kindProgress } }.
export function planWindow(row, win, nowStamp, extra = {}) {
  if (!win || !isWindowTime(nowStamp)) return '';
  const kind = str(row.category).toLowerCase();
  if (!(win.on || []).includes(kind)) return '';
  if (!((win.progress || {})[kind] || {}).clean) return '';
  if (blockers(row, extra).length) return '';
  return windowEnd(nowStamp);
}

// Pending rows whose window has ended (still waiting), oldest first.
export function due(rows, nowStamp) {
  return (rows || []).filter((r) => str(r.status) === 'pending' && isWindowTime(r[COLUMN]) && str(r[COLUMN]) <= nowStamp)
    .sort((a, b) => str(a[COLUMN]).localeCompare(str(b[COLUMN])));
}

// A reply on the item's email that needs Jon (a question, held mail, a follow-up, his own
// thread): the item waits for him too. An acknowledgement or a Now on the website email is fine.
const REPLY_FINE = new Set(['', 'ack', 'live', 'none', 'list']);
export function replyBlocks(repliesRows, messageId) {
  const id = str(messageId);
  return Boolean(id) && (repliesRows || []).some((r) => str(r.message_id) === id && !REPLY_FINE.has(str(r.type).toLowerCase()));
}

// The end-of-window decision for one due row (pure): { approve: true } or { hold: 'why' }.
export function endOfWindow(row, { on, progress, replies }) {
  const kind = str(row.category).toLowerCase();
  if (!(on || []).includes(kind)) return { hold: 'switched off' };
  if (!((progress || {})[kind] || {}).clean) return { hold: 'the latest 20 are no longer all as written' };
  const why = blockers(row);
  if (why.length) return { hold: why[0] };
  if (replyBlocks(replies, row.message_id)) return { hold: 'a reply on this email needs you' };
  return { approve: true };
}

// Fine / Not right on an item that published itself: { field, expected, value } for a
// stale-checked write to Item feedback, or { error, status }.
export function planAudit(row, { op, expected }) {
  if (!row) return { error: 'Not found: reload the page', status: 404 };
  const now = str(row.outcome);
  if (now !== str(expected)) return { error: 'Changed in the Sheet since you loaded the page', status: 409, current: now };
  if (!['window', 'window_ok', 'window_bad'].includes(now)) return { error: 'This item did not publish itself', status: 400 };
  if (op === 'fine') return { field: 'outcome', expected: now, value: 'window_ok' };
  if (op === 'bad') return { field: 'outcome', expected: now, value: 'window_bad' };
  return { error: `Unknown action "${op}"`, status: 400 };
}

const parse = (j) => { try { const o = JSON.parse(j); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

// The Autonomy screen's veto-window card. settingValue: Settings auto_window (undefined = the
// row is missing); feedbackRows: Item feedback; pendingRows: Pending.
export function windowStatus({ settingValue, feedbackRows = [], pendingRows = [], hasColumn = true }) {
  const on = kindsOn(settingValue);
  const unseen = feedbackRows.filter((r) => str(r.outcome) === 'window')
    .sort((a, b) => str(a.decided_at).localeCompare(str(b.decided_at)));
  return {
    ready: settingValue !== undefined && hasColumn,
    missing: settingValue === undefined ? 'Settings has no auto_window row' : hasColumn ? '' : 'Pending has no auto_at column yet (the next Ingest run adds it)',
    value: str(settingValue),
    needed: NEEDED,
    hours: WINDOW_MIN / 60,
    kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k], on: on.includes(k), ...kindProgress(feedbackRows, k) })),
    waiting: pendingRows.filter((r) => str(r.status) === 'pending' && isWindowTime(r[COLUMN]))
      .sort((a, b) => str(a[COLUMN]).localeCompare(str(b[COLUMN])))
      .map((r) => ({ id: str(r.id), title: str(r.title), at: str(r[COLUMN]) })),
    // The audit: the oldest few that published themselves and haven't been looked at.
    auditTotal: unseen.length,
    audit: unseen.slice(0, AUDIT_SAMPLE).map((r) => ({
      id: str(r.item_id), outcome: str(r.outcome), at: str(r.decided_at), title: str(parse(r.draft).title), kind: str(r.type),
    })),
  };
}

// Heads-up email to Jon after an ingest run (plain text; to the team inbox only).
export function headsUp(items, panelUrl) {
  const n = items.length;
  return {
    subject: `${n} item${n === 1 ? '' : 's'} will publish ${n === 1 ? 'itself' : 'themselves'} (Lenches)`,
    text: [
      `Holly has written up ${n === 1 ? 'this item' : 'these items'}. ${n === 1 ? 'It publishes itself' : 'Each publishes itself'} at the time shown unless you stop it.`,
      '',
      ...items.map((i) => `- ${i.title} (${i.kind}): ${i.at}`),
      '',
      `To stop one, open Submissions in the panel and tap Hold (Edit, Reject and Done already stop it too): ${panelUrl}`,
      'To stop these emails, set auto_window_emails to FALSE in Settings. To switch the veto window off, use the Autonomy screen.',
    ].join('\n'),
  };
}
