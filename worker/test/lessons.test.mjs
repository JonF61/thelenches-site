// worker/test/lessons.test.mjs
// Offline tests for the panel's Holly lessons helpers (admin/lessons.js).
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonRows, cleanLesson, nextId, newLessonRow, planLessonDecision, LESSON_HEADERS } from '../src/admin/lessons.js';
import { dispatchFor } from '../src/core.js';

test('lessonRows: newest first, blank rows dropped', () => {
  const t = lessonRows({ headers: LESSON_HEADERS, rows: [
    { _row: 2, id: 'L20261026-1', created_at: '2026-10-26 13:43', lesson: 'Old', status: 'approved' },
    { _row: 3, id: '', lesson: 'no id' },
    { _row: 4, id: 'L20261027-1', created_at: '2026-10-27 09:00', lesson: 'New', status: 'proposed' },
  ] });
  assert.deepEqual(t.rows.map((r) => [r.id, r._row]), [['L20261027-1', 4], ['L20261026-1', 2]]);
});

test('cleanLesson: one line, 10-300 characters, no addresses or links', () => {
  assert.equal(cleanLesson('  Be   formal\nwith clerks. ').value, 'Be formal with clerks.');
  assert.equal(cleanLesson('short').status, 400);
  assert.equal(cleanLesson('x'.repeat(301)).status, 400);
  assert.equal(cleanLesson('Email someone@example.org about it').status, 400);
  assert.equal(cleanLesson('See https://example.org for the style').status, 400);
});

test('Add: next free id, approved, in header order', () => {
  assert.equal(nextId([{ id: 'L20261026-1' }, { id: 'L20261026-2' }], '2026-10-26'), 'L20261026-3');
  const { row, values } = newLessonRow(['id', 'lesson', 'status', 'notes', 'extra'], [], 'Be formal with clerks.', '2026-10-26', '2026-10-26 14:00');
  assert.equal(row.status, 'approved');
  assert.deepEqual(values, ['L20261026-1', 'Be formal with clerks.', 'approved', 'added in the panel', '']);
});

test('Approve / Reject a suggestion goes through decide()', () => {
  const p = planLessonDecision({ action: 'approve', id: 'L1' }, { id: 'L1', status: 'proposed' });
  assert.deepEqual(dispatchFor(p.p), ['approval', { id: 'L1', action: 'lesson_ok' }]);
  assert.equal(planLessonDecision({ action: 'reject', id: 'L1' }, { id: 'L1', status: 'proposed' }).p.a, 'lesson_no');
  assert.equal(planLessonDecision({ action: 'approve', id: 'L1' }, { id: 'L1', status: 'approved' }).status, 409);
  assert.equal(planLessonDecision({ action: 'approve', id: 'L1' }, null).status, 404);
});
