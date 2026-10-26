// worker/src/admin/lessons.js
// The panel's Holly lessons screen (26 Oct 2026): the "Holly lessons" tab that every Holly
// draft reads (approved rows only; scripts/ingest/replies.js primeLearning). Pure helpers;
// index.js does the Sheet calls.
//   Approve / Reject a proposed lesson: through decide() (lesson_ok / lesson_no), the same
//     path as the weekly email's links (scripts/lessons decide).
//   Edit: one stale-checked write of the lesson cell (expected = the text the page loaded).
//   Add: a new row, status approved, notes "added in the panel".
//   Delete: removes the row, refused if its text changed since the page loaded.

export const LESSONS_TAB = 'Holly lessons';
// Same as replies.js LESSON_HEADERS.
export const LESSON_HEADERS = ['id', 'created_at', 'lesson', 'evidence', 'status', 'decided_at', 'notes'];
export const MIN_LESSON = 10;
export const MAX_LESSON = 300;

const str = (v) => String(v ?? '').trim();
const refuse = (status, error) => ({ error, status });

// Every lesson, newest first.
export function lessonRows(table) {
  if (!table || table.error) return table;
  const rows = table.rows.filter((r) => str(r.id) && str(r.lesson))
    .map((r) => Object.fromEntries([['_row', r._row], ...LESSON_HEADERS.map((k) => [k, str(r[k])])]))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return { headers: table.headers, rows };
}

// A lesson's text as typed: one line, MIN_LESSON..MAX_LESSON characters, no email address or
// link (lessons are general rules). { value } or { error, status }.
export function cleanLesson(v) {
  const t = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < MIN_LESSON) return refuse(400, `A lesson needs at least ${MIN_LESSON} characters`);
  if (t.length > MAX_LESSON) return refuse(400, `A lesson can be up to ${MAX_LESSON} characters`);
  if (/@|https?:\/\/|www\./i.test(t)) return refuse(400, 'Keep lessons general: no email addresses or links');
  return { value: t };
}

// Next free id for a lesson made on ukDay (YYYY-MM-DD): "L<yyyymmdd>-<n>".
export function nextId(rows, ukDay) {
  const day = String(ukDay).replace(/-/g, '');
  const used = new Set((rows || []).map((r) => str(r.id)));
  let n = 1;
  while (used.has(`L${day}-${n}`)) n += 1;
  return `L${day}-${n}`;
}

// A new row for Add, in the tab's header order.
export function newLessonRow(headers, rows, text, ukDay, ukNow) {
  const row = { id: nextId(rows, ukDay), created_at: ukNow, lesson: text, evidence: '', status: 'approved', decided_at: ukNow, notes: 'added in the panel' };
  return { row, values: headers.map((h) => row[h] ?? '') };
}

// Approve / Reject from the panel: { p } for decide(), or { error, status }.
export function planLessonDecision({ action, id }, row) {
  if (!row) return refuse(404, 'No such lesson: reload the page');
  if (str(row.status).toLowerCase() !== 'proposed') return refuse(409, `This lesson is already "${str(row.status)}"`);
  const a = { approve: 'lesson_ok', reject: 'lesson_no' }[action];
  if (!a) return refuse(400, `Unknown action "${action}"`);
  return { p: { a, i: str(row.id) } };
}
