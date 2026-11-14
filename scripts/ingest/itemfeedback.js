// scripts/ingest/itemfeedback.js
// Item feedback (stage 1 of graduated autonomy, Jon 2 Nov 2026): the submissions twin of the
// Reply feedback tab. Every listing Holly writes up (extract.js) gets one row when it reaches
// Pending, and the row is completed when Jon decides it in the panel (scripts/approve):
//   item_id      Pending id
//   created_at   YYYY-MM-DD HH:MM UK
//   type         category, "-official" for official notices (e.g. event, notice-official)
//   source_kind  email | feed, "-trusted" for a Trusted source (e.g. email-trusted)
//   confidence   Holly's confidence (0 to 1)
//   flags        policy_flags plus urgent, people_in_image, political_commercial, official
//   draft        JSON of Holly's write-up (FIELDS)
//   outcome      approved (as written) | edited (changed in the panel or Sheet, then approved)
//                | rejected | done | auto (holiday mode published it) | ignored:<was> (Jon's Ignore
//                on the panel's Autonomy screen: a test or a slip, left out of stats and learning)
//   changed      fields Jon changed, comma separated (and "wording:own" / "wording:rewrite")
//   final        JSON of the changed fields as approved
//   decided_at   YYYY-MM-DD HH:MM UK
// Stage 2 reads it for per-type stats; Holly's write-ups (extract.js) and the Monday lessons
// (scripts/lessons) learn from the edited rows. The tab is created on first use (at the end).
// Writes here never stop ingestion or a decision: failures only warn. Logs print counts and
// ids only (contacts are personal data; the logs are public).
'use strict';

const g = require('./google');

const TAB = 'Item feedback';
const HEADERS = ['item_id', 'created_at', 'type', 'source_kind', 'confidence', 'flags', 'draft',
  'outcome', 'changed', 'final', 'decided_at'];
// The parts of a write-up Jon can change in the panel (the Edit form) or the Sheet.
const FIELDS = ['title', 'summary', 'category', 'village', 'event_date', 'event_time', 'end_date',
  'cost', 'contact', 'link_text', 'link_url', 'link2_text', 'link2_url', 'road'];
// Never given to Claude as a correction: personal data, or only meaningful with the email.
const PRIVATE = ['contact'];
const RECENT = 8;
// Clear-down (Jon, 2 Nov 2026): decisions before this (UK time) are set aside, in Holly's
// learning (here and replies.js correctionsFrom, so the Monday lessons too) and on the panel's
// Autonomy screen (worker/src/admin/autonomy.js COUNT_FROM, the same value).
const LEARN_FROM = process.env.LEARN_FROM_TEST || '2026-11-02 18:50'; // the env is for offline tests only
const CLIP = 500;

const str = (v) => (v === undefined || v === null ? '' : String(v).replace(/\r\n?/g, '\n').trim());
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));
const warn = (what, err) => console.warn(`Item feedback: ${what} failed: ${(err && err.message) || err}`);
const clip = (t, n = CLIP) => { const f = str(t).replace(/\s+/g, ' '); return f.length > n ? `${f.slice(0, n)}…` : f; };

// Already listed (3 Nov, duplicates.js): its own kind, "duplicate", so the Autonomy screen
// tracks Holly's matching apart from her write-ups.
const dupOf = (row) => { try { const o = JSON.parse(str(row.duplicate)); return o && o.key ? o : null; } catch { return null; } };
const typeOf = (row) => (dupOf(row) ? 'duplicate'
  : `${str(row.category).toLowerCase() || 'notice'}${truthy(row.official) ? '-official' : ''}`);
function sourceKindOf(row) {
  const feed = str(row.message_id).startsWith('rss:');
  const trusted = str(row.notes).split(' | ').some((n) => ['trusted', 'trusted source'].includes(n.trim()));
  return `${feed ? 'feed' : 'email'}${trusted ? '-trusted' : ''}`;
}
const draftOf = (row) => Object.fromEntries(FIELDS.map((f) => [f, str(row[f])]));
function flagsOf(row) {
  const extra = ['urgent', 'people_in_image', 'political_commercial', 'official'].filter((f) => truthy(row[f]));
  return [...new Set([...str(row.policy_flags).split(',').map((s) => s.trim()).filter(Boolean), ...extra])].join(',');
}

// Feedback row for a new Pending row (pure).
function rowFor(row) {
  return {
    item_id: row.id,
    created_at: str(row.received),
    type: typeOf(row),
    source_kind: sourceKindOf(row),
    confidence: row.confidence === undefined ? '' : row.confidence,
    flags: flagsOf(row),
    draft: JSON.stringify(draftOf(row)),
    outcome: row.status === 'auto' ? 'auto' : '',
    changed: '',
    final: '',
    decided_at: '',
  };
}

// Called right after rows are appended to Pending (ingest index.js and rss.js).
async function record(rows) {
  if (!rows || !rows.length) return;
  try {
    await g.ensureTab(TAB, HEADERS);
    await g.appendRows(TAB, rows.map(rowFor));
  } catch (err) {
    warn(`recording ${rows.length} item(s)`, err);
  }
}

function parse(json) {
  try { const o = JSON.parse(json); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// What Jon changed: { changed: [field], final: {field: value} } (pure). Whitespace-only
// differences don't count.
function diff(draft, current) {
  const same = (a, b) => str(a).replace(/\s+/g, ' ') === str(b).replace(/\s+/g, ' ');
  const changed = FIELDS.filter((f) => f in draft && !same(draft[f], current[f]));
  return { changed, final: Object.fromEntries(changed.map((f) => [f, str(current[f])])) };
}

// Outcome for a decision (pure). action: approve | approve_own | approve_rewrite | reject | done.
// row: the Pending row as it stood when Jon decided (his edits included).
// A duplicate (type "duplicate"): Holly proposed "close it" (no new details) or "add these
// details". Taking her proposal as it stands = approved; Done when she proposed details, or Add
// details with Jon's changes = edited; publishing it as a new item = rejected (she was wrong);
// a plain Reject isn't counted (done). merged: the fields Jon added ({} for Done).
function duplicateOutcome(row, action, merged = {}) {
  const proposed = (dupOf(row) || {}).changes || {};
  const flat = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, str(o[k]).replace(/\s+/g, ' ')]));
  if (action === 'reject') return { outcome: 'done', changed: '', final: '' };
  if (action === 'merge') {
    const same = flat(merged) === flat(proposed);
    return { outcome: same ? 'approved' : 'edited', changed: same ? '' : 'details', final: '' };
  }
  if (action === 'done') {
    const none = !Object.keys(proposed).length;
    return { outcome: none ? 'approved' : 'edited', changed: none ? '' : 'details not added', final: '' };
  }
  return { outcome: 'rejected', changed: 'published as a new item', final: '' };
}

function outcomeFor(fb, row, action, wording = '', merged = {}) {
  if (str(fb.type) === 'duplicate') return duplicateOutcome(row, action, merged);
  const draft = parse(fb.draft) || {};
  const { changed, final } = diff(draft, row);
  const status = action === 'reject' ? 'rejected' : action === 'done' ? 'done' : 'approved';
  const outcome = status === 'approved' && changed.length ? 'edited' : status;
  return {
    outcome,
    changed: [...changed, wording ? `wording:${wording}` : ''].filter(Boolean).join(','),
    final: changed.length ? JSON.stringify(final) : '',
  };
}

// Called by scripts/approve when Jon decides an item. Only the first decision counts.
async function resolve(row, action, { wording = '', decidedAt = '', merged = {} } = {}) {
  try {
    const fb = (await g.readTable(TAB)).find((r) => r.item_id === row.id);
    if (!fb) { console.log(`Item feedback: no draft logged for ${row.id} (from before 2 Nov 2026).`); return null; }
    if (str(fb.outcome)) return null;
    const o = outcomeFor(fb, row, action, wording, merged);
    await g.updateRow(TAB, fb._row, { ...o, decided_at: decidedAt });
    console.log(`Item feedback: ${row.id} ${o.outcome}${o.changed ? ` (${o.changed})` : ''}.`);
    return o;
  } catch (err) {
    warn(`resolving ${row.id}`, err);
    return null;
  }
}

// The submitter's own reply filled in details (replies.js applyAnswer): that's still Holly's
// draft, not Jon's edit, so the logged draft follows it while the item is undecided.
async function updateDraft(row) {
  try {
    const fb = (await g.readTable(TAB)).find((r) => r.item_id === row.id);
    if (fb && !str(fb.outcome)) await g.updateRow(TAB, fb._row, { draft: JSON.stringify(draftOf(row)) });
  } catch (err) {
    warn(`updating ${row.id}`, err);
  }
}

// The latest edited write-ups, for Holly's prompt and the weekly lessons (pure): only the
// fields Jon changed, before and after; never a contact.
function correctionsFrom(rows, n = RECENT, since = '') {
  return (rows || [])
    .filter((r) => r.outcome === 'edited' && str(r.decided_at) >= LEARN_FROM && (!since || str(r.decided_at) >= since))
    .sort((a, b) => str(b.decided_at).localeCompare(str(a.decided_at)))
    .map((r) => {
      const draft = parse(r.draft) || {};
      const final = parse(r.final) || {};
      const fields = Object.keys(final).filter((f) => !PRIVATE.includes(f));
      if (!fields.length) return null;
      return {
        item_id: r.item_id,
        type: r.type,
        source_kind: r.source_kind,
        holly_wrote: Object.fromEntries(fields.map((f) => [f, clip(draft[f])])),
        team_changed_to: Object.fromEntries(fields.map((f) => [f, clip(final[f])])),
      };
    })
    .filter(Boolean)
    .slice(0, n);
}

module.exports = {
  TAB, HEADERS, FIELDS, LEARN_FROM, record, resolve, updateDraft, rowFor, diff, outcomeFor, correctionsFrom, typeOf, sourceKindOf,
  duplicateOutcome,
};
