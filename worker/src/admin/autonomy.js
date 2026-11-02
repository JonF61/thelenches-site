// worker/src/admin/autonomy.js
// The panel's Autonomy screen (stage 2 of graduated autonomy, Jon 2 Nov 2026): read-only
// progress of each kind of item and reply towards Holly acting on her own. Nothing here
// makes anything automatic: stage 3 (a veto window) needs Jon's tap, one type at a time.
// Pure helpers; index.js does the Sheet calls.
//   Item feedback tab (scripts/ingest/itemfeedback.js): Holly's write-ups and Jon's decision.
//   Reply feedback tab (scripts/ingest/feedback.js): Holly's reply drafts and Jon's decision.
// A decision counts as unchanged (approved as written), changed (edited, or a reply
// redrafted) or rejected. Not counted: done, holiday/roadworks auto, shadow, timed out,
// closed, undecided, and anything Jon marked Ignore (outcome "ignored:<was>", e.g. a test
// or a silly edit; also left out of Holly's learning). Count again restores the outcome.
// Never automatic, whatever the numbers: official notices, people in images, political or
// commercial items, and held, follow-up and outreach replies.

export const ITEM_TAB = 'Item feedback';
export const REPLY_TAB = 'Reply feedback';
export const NEEDED = 30;       // decisions before a type can qualify
export const RATE = 0.95;       // share approved unchanged, over the latest NEEDED
export const CLEAN_LAST = 20;   // no rejection among the latest this many
export const SHADOW_DAYS = 30;  // "If it had been on" window
const RECENT = 10;
const IGNORED = 'ignored:';

const str = (v) => String(v ?? '').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const NEVER_REPLY = new Set(['held', 'followup', 'outreach']);

function verdict(kind, outcome) {
  const o = str(outcome).toLowerCase();
  if (o === 'approved') return 'unchanged';
  if (o === 'edited' || (kind === 'reply' && o === 'redrafted')) return 'changed';
  if (o === 'rejected') return 'rejected';
  return '';
}

// One decided row -> { kind, id, key, label, never, at, verdict, outcome, changed } or null.
function itemDecision(r) {
  const v = verdict('item', r.outcome);
  const ignored = str(r.outcome).startsWith(IGNORED);
  if (!v && !ignored) return null;
  const type = str(r.type) || 'notice';
  const flags = str(r.flags);
  const never = /-official$/.test(type) || /\b(people_in_image|political_commercial|official)\b/.test(flags);
  const src = str(r.source_kind) || 'email';
  const label = `${cap(type.replace(/-official$/, ''))} · ${src.replace('-trusted', ' (trusted)')}`;
  return {
    kind: 'item', id: str(r.item_id), key: `item:${type}:${src}`, label, never, at: str(r.decided_at || r.created_at),
    verdict: ignored ? 'ignored' : v, outcome: str(r.outcome), changed: str(r.changed),
  };
}

function replyDecision(r) {
  const v = verdict('reply', r.outcome);
  const ignored = str(r.outcome).startsWith(IGNORED);
  if (!v && !ignored) return null;
  const type = str(r.type).toLowerCase() || 'reply';
  const cls = str(r.class).toLowerCase();
  const label = type === 'answer' && cls ? `Answer · ${cls}` : cap(type);
  return {
    kind: 'reply', id: str(r.reply_id), key: `reply:${type}${type === 'answer' && cls ? `:${cls}` : ''}`, label,
    never: NEVER_REPLY.has(type), at: str(r.decided_at || r.created_at),
    verdict: ignored ? 'ignored' : v, outcome: str(r.outcome), changed: '',
  };
}

// Progress of one type from its decisions (newest first, ignored ones left out).
function progress(list) {
  const counted = list.filter((d) => d.verdict !== 'ignored');
  const latest = counted.slice(0, NEEDED);
  const unchanged = latest.filter((d) => d.verdict === 'unchanged').length;
  const rate = latest.length ? unchanged / latest.length : 0;
  const rejectedRecently = counted.slice(0, CLEAN_LAST).some((d) => d.verdict === 'rejected');
  return {
    decided: counted.length,
    unchanged: counted.filter((d) => d.verdict === 'unchanged').length,
    changed: counted.filter((d) => d.verdict === 'changed').length,
    rejected: counted.filter((d) => d.verdict === 'rejected').length,
    rate: Math.round(rate * 100),
    toGo: Math.max(0, NEEDED - counted.length),
    qualifies: counted.length >= NEEDED && rate >= RATE && !rejectedRecently,
    rejectedRecently,
  };
}

// The screen's data. tables: { items, replies } as readTable gives them (or { rows: [] }).
// now: ms (for the shadow window).
export function autonomyStats({ items, replies }, now = Date.now()) {
  const all = [
    ...((items && items.rows) || []).map(itemDecision),
    ...((replies && replies.rows) || []).map(replyDecision),
  ].filter((d) => d && d.id).sort((a, b) => b.at.localeCompare(a.at));
  const groups = new Map();
  for (const d of all) {
    if (!groups.has(d.key)) groups.set(d.key, { key: d.key, kind: d.kind, label: d.label, never: d.never, list: [] });
    const gr = groups.get(d.key);
    gr.never = gr.never && d.never; // a type is "never" only if every row of it is
    gr.list.push(d);
  }
  // Never-automatic rows go to their own section, whatever type they share.
  const types = [];
  const never = { decided: 0, items: 0, replies: 0 };
  for (const gr of groups.values()) {
    const ok = gr.list.filter((d) => !d.never);
    const nv = gr.list.filter((d) => d.never && d.verdict !== 'ignored');
    never.decided += nv.length;
    never[gr.kind === 'item' ? 'items' : 'replies'] += nv.length;
    if (!ok.length) continue;
    types.push({
      key: gr.key, kind: gr.kind, label: gr.label, ...progress(ok),
      recent: ok.slice(0, RECENT).map(({ kind, id, at, verdict: v, outcome, changed }) => ({ kind, id, at, verdict: v, outcome, changed })),
    });
  }
  types.sort((a, b) => (a.kind === b.kind ? b.decided - a.decided || a.label.localeCompare(b.label) : a.kind === 'item' ? -1 : 1));
  const since = new Date(now - SHADOW_DAYS * 86400000).toISOString().slice(0, 10);
  const qualifying = new Set(types.filter((t) => t.qualifies).map((t) => t.key));
  const window = all.filter((d) => !d.never && d.verdict !== 'ignored' && qualifying.has(d.key) && d.at.slice(0, 10) >= since);
  return {
    thresholds: { needed: NEEDED, rate: Math.round(RATE * 100), cleanLast: CLEAN_LAST, shadowDays: SHADOW_DAYS },
    automatic: [], // stage 3 not started: no type acts on its own (roadworks alerts and holiday mode aside)
    items: types.filter((t) => t.kind === 'item'),
    replies: types.filter((t) => t.kind === 'reply'),
    shadow: {
      qualifying: [...qualifying],
      wouldHave: window.length,
      wrong: window.filter((d) => d.verdict !== 'unchanged').length,
    },
    never,
  };
}

// Ignore / Count again: { field, expected, value } for a stale-checked write, or { error, status }.
// row: the tab row as it stands; expected: the outcome the page showed.
export function planIgnore(row, { op, expected }) {
  if (!row) return { error: 'Not found: reload the page', status: 404 };
  const now = str(row.outcome);
  if (now !== str(expected)) return { error: 'Changed in the Sheet since you loaded the page', status: 409, current: now };
  if (op === 'ignore') {
    if (now.startsWith(IGNORED)) return { error: 'Already ignored', status: 409, current: now };
    if (!verdict('item', now) && !verdict('reply', now)) return { error: 'Only a decision can be ignored', status: 400 };
    return { field: 'outcome', expected: now, value: `${IGNORED}${now}` };
  }
  if (op === 'restore') {
    if (!now.startsWith(IGNORED)) return { error: 'Not ignored', status: 409, current: now };
    return { field: 'outcome', expected: now, value: now.slice(IGNORED.length) };
  }
  return { error: `Unknown action "${op}"`, status: 400 };
}
