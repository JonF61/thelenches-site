// worker/test/summary.test.mjs
// Offline tests for admin/summary.js: the next newsletter (date, deadline, Issues row, On
// this day, item counts), failing runs, subscriber counts and the week coming up.
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueDateFor, lastSentDate, nextIssue, failingRuns, subscriberChanges, comingWeek, ukInstant, minuteKey, devTasks,
} from '../src/admin/summary.js';

test('issueDateFor: this Thursday, or next week once it has gone out', () => {
  assert.equal(issueDateFor('2026-10-28', []), '2026-10-29');
  assert.equal(issueDateFor('2026-10-29', []), '2026-10-29');
  assert.equal(issueDateFor('2026-10-29', [{ issue_date: '2026-10-29', status: 'sent' }]), '2026-11-05');
  assert.equal(issueDateFor('2026-10-30', []), '2026-11-05');
});

test('lastSentDate: the latest sent issue, else the Thursday before', () => {
  const issues = [{ issue_date: '2026-10-15', status: 'sent' }, { issue_date: '2026-10-22', status: 'sent' }, { issue_date: '2026-10-29', status: 'tested' }];
  assert.equal(lastSentDate('2026-10-28', issues), '2026-10-22');
  assert.equal(lastSentDate('2026-10-28', []), '2026-10-22');
  assert.equal(lastSentDate('2026-10-29', []), '2026-10-22');
});

test('ukInstant: Wednesday 6pm in GMT and BST', () => {
  assert.equal(ukInstant('2026-11-04 18:00'), '2026-11-04T18:00:00.000Z');
  assert.equal(ukInstant('2026-10-21 18:00'), '2026-10-21T17:00:00.000Z');
  assert.equal(minuteKey('2026-10-21T16:30:00Z'), '2026-10-21 17:30');
});

test('nextIssue: deadline, preview status, On this day, counts', () => {
  const issues = [{ _row: 5, issue_date: '2026-10-22', status: 'sent' }, { _row: 6, issue_date: '2026-10-29', status: 'tested' }];
  const pending = [
    { title: 'New notice', status: 'approved', category: 'notice', received: '2026-10-25 10:00', decided_at: '2026-10-25 11:00' },
    { title: 'Late notice', status: 'approved', category: 'notice', received: '2026-10-28 19:00', decided_at: '2026-10-28 19:30' },
    { title: 'Old notice', status: 'approved', category: 'notice', received: '2026-10-10 10:00', decided_at: '2026-10-10 11:00' },
    { title: 'Waiting', status: 'pending', category: 'notice', received: '2026-10-26 10:00' },
    { title: 'An event', status: 'auto', category: 'event', received: '2026-10-26 10:00' },
  ];
  const coming = { events: [{ date: '2026-10-28' }, { date: '2026-10-29' }, { date: '2026-11-11' }, { date: '2026-11-12' }] };
  const n = nextIssue({ today: '2026-10-28', issues, pending, coming });
  assert.equal(n.date, '2026-10-29');
  assert.equal(n.deadline, '2026-10-28 18:00');
  assert.equal(n.deadlineAt, '2026-10-28T18:00:00.000Z');
  assert.equal(n.status, 'tested');
  assert.equal(n.row, 6);
  assert.equal(n.events, 2);
  assert.equal(n.fresh, 1);
  assert.match(n.onThisDay, /^In \d{4}/);
  const none = nextIssue({ today: '2026-10-28', issues: [], pending: [], coming: null });
  assert.equal(none.status, '');
  assert.equal(none.events, null);
});

test('failingRuns: only workflows whose latest finished run failed', () => {
  const runs = [
    { name: 'Ingest', status: 'in_progress', conclusion: '' },
    { name: 'Ingest', status: 'completed', conclusion: 'success' },
    { name: 'Ingest', status: 'completed', conclusion: 'failure' },
    { name: 'Publish', status: 'completed', conclusion: 'cancelled' },
    { name: 'Publish', status: 'completed', conclusion: 'failure', started: 's', url: 'u' },
    { name: 'Build site', status: 'completed', conclusion: 'timed_out', started: 't', url: 'v' },
  ];
  assert.deepEqual(failingRuns(runs).map((r) => r.name), ['Publish', 'Build site']);
});

test('subscriberChanges: counts since the date, whichever date column a row has', () => {
  const subs = [
    { email: 'a', status: 'active', added_at: '2026-10-23T09:00:00Z' },
    { email: 'b', status: '', subscribed_date: '2026-10-22 08:00:00' },
    { email: 'c', status: 'active', subscribed_date: '2026-09-01 08:00:00' },
    { email: 'd', status: 'held', added_at: '2026-10-24' },
  ];
  const dns = [{ email: 'x', date: '2026-10-25' }, { email: 'y', date: '2026-10-01' }];
  assert.deepEqual(subscriberChanges(subs, dns, '2026-10-22'), { since: '2026-10-22', joined: 2, left: 1, total: 3 });
});

test('comingWeek: events and works on any of the next 7 days', () => {
  const coming = {
    generated: '2026-10-28',
    events: [{ date: '2026-10-27', end: '' }, { date: '2026-10-26', end: '2026-10-29' }, { date: '2026-11-03' }, { date: '2026-11-04' }],
    roads: [{ start: '2026-10-01', end: '2026-10-27' }, { start: '2026-10-01', end: '' }, { start: '2026-11-03', end: '2026-11-20' }, { start: '2026-11-04', end: '' }],
  };
  const w = comingWeek(coming, '2026-10-28');
  assert.equal(w.events.length, 2);
  assert.equal(w.roads.length, 2);
  assert.ok(comingWeek({ error: 'x' }, '2026-10-28').error);
});

test('devTasks: the bundled list', () => {
  for (const t of devTasks()) assert.ok(t.task);
});
