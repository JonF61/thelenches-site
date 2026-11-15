// worker/test/autowindow.test.mjs
// Veto window (autonomy stage 3; admin/autowindow.mjs and admin/autorun.js). Offline: the Sheet
// and GitHub are faked. Run: node --test worker/test/autowindow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindsOn, settingFor, windowEnd, ukStamp, kindProgress, blockers, planWindow, due, replyBlocks, endOfWindow,
  planAudit, windowStatus, headsUp, itemVerdict, NEEDED,
} from '../src/admin/autowindow.mjs';
import { runAutoWindow } from '../src/admin/autorun.js';
import { autonomyStats, planIgnore } from '../src/admin/autonomy.js';
import { SETTINGS_EDITS } from '../src/admin/sheet.js';
import { PANEL_ONLY } from '../src/core.js';

const fbRows = (n, { type = 'event', outcome = 'approved', from = 0, flags = '', source = 'email' } = {}) => Array.from({ length: n }, (_, i) => ({
  item_id: `${type}-${from + i}`, type, source_kind: source, flags, outcome, draft: JSON.stringify({ title: `T${from + i}` }),
  decided_at: `2026-11-${String(3 + Math.floor((from + i) / 4)).padStart(2, '0')} ${String(10 + ((from + i) % 4)).padStart(2, '0')}:00`,
}));
const good = (extra = {}) => ({
  id: 'm1-1', status: 'pending', category: 'event', message_id: 'm1', title: 'Quiz', confidence: '0.95', notes: '', missing: '', policy_flags: '',
  official: '', people_in_image: '', political_commercial: '', duplicate: '', possible_repeat: '', image_choice: '', ...extra,
});

test('the switch: only known kinds, blank or off = nothing', () => {
  assert.deepEqual(kindsOn('event'), ['event']);
  assert.deepEqual(kindsOn(' Notice, event ,road'), ['notice', 'event']);
  assert.deepEqual(kindsOn(''), []);
  assert.deepEqual(kindsOn('off'), []);
  assert.deepEqual(kindsOn(undefined), []);
  assert.equal(settingFor(['notice', 'event']), 'event,notice');
  assert.equal(settingFor(['']), '');
  assert.equal(settingFor(['replies']), null);
  assert.equal(SETTINGS_EDITS.auto_window('event'), 'event');
  assert.equal(SETTINGS_EDITS.auto_window(''), '');
  assert.equal(SETTINGS_EDITS.auto_window('everything'), null);
});

test('the window: 4 hours counted between 8am and 9pm UK', () => {
  assert.equal(windowEnd('2026-11-16 10:17'), '2026-11-16 14:17');
  assert.equal(windowEnd('2026-11-16 18:30'), '2026-11-17 09:30'); // 2.5h today, 1.5h tomorrow
  assert.equal(windowEnd('2026-11-16 22:17'), '2026-11-17 12:00'); // evening arrival: midday next day
  assert.equal(windowEnd('2026-11-16 06:00'), '2026-11-16 12:00');
  assert.equal(windowEnd('2026-12-31 20:59'), '2027-01-01 11:59');
  assert.equal(windowEnd('nonsense'), '');
  assert.equal(ukStamp(Date.UTC(2026, 6, 1, 12, 0)), '2026-07-01 13:00'); // summer time
  assert.equal(ukStamp(Date.UTC(2026, 10, 16, 12, 0)), '2026-11-16 12:00');
});

test('20 clean: the newest 20 decisions all approved as written', () => {
  assert.equal(kindProgress(fbRows(19), 'event').clean, false);
  assert.deepEqual(kindProgress(fbRows(19), 'event'), { decided: 19, run: 19, toGo: 1, clean: false });
  assert.equal(kindProgress(fbRows(20), 'event').clean, true);
  // One edit among the newest 20 stops it; 20 clean ones after it start it again.
  const edited = [...fbRows(20), ...fbRows(1, { outcome: 'edited', from: 20 })];
  assert.deepEqual(kindProgress(edited, 'event'), { decided: 21, run: 0, toGo: 20, clean: false });
  assert.equal(kindProgress([...edited, ...fbRows(20, { from: 21 })], 'event').clean, true);
  // Other kinds, feeds, trusted sources, never-automatic rows, ignored and uncounted outcomes don't count.
  const noise = [...fbRows(20, { type: 'notice' }), ...fbRows(20, { source: 'feed' }), ...fbRows(20, { source: 'email-trusted' }),
    ...fbRows(20, { flags: 'political_commercial' }), ...fbRows(20, { outcome: 'ignored:approved' }), ...fbRows(20, { outcome: 'auto' }),
    ...fbRows(20, { outcome: 'window' }), ...fbRows(20, { outcome: 'done' })];
  assert.equal(kindProgress(noise, 'event').decided, 0);
  // Audited self-published items count: Fine as written, Not right as a rejection.
  assert.equal(itemVerdict('window_ok'), 'unchanged');
  assert.equal(itemVerdict('window_bad'), 'rejected');
  assert.equal(itemVerdict('window'), '');
  assert.equal(kindProgress([...fbRows(20), ...fbRows(1, { outcome: 'window_bad', from: 20 })], 'event').clean, false);
  assert.equal(kindProgress([...fbRows(15), ...fbRows(5, { outcome: 'window_ok', from: 15 })], 'event').clean, true);
  // Decisions before the 2 Nov clear-down are set aside.
  assert.equal(kindProgress(fbRows(20).map((r) => ({ ...r, decided_at: '2026-11-01 10:00' })), 'event').decided, 0);
});

test('never automatic: every blocker stops a window', () => {
  assert.deepEqual(blockers(good()), []);
  const cases = {
    'not waiting': { status: 'approved' }, 'not an event or notice': { category: 'news' }, 'not from an email': { message_id: 'rss:abc' },
    official: { official: 'TRUE' }, 'people in the image': { people_in_image: true }, 'political or commercial': { political_commercial: 'TRUE' },
    'asked for their own wording': { verbatim_requested: 'TRUE' }, 'already listed': { duplicate: '{"key":"p:x"}' },
    'possible repeat': { possible_repeat: 'TRUE' }, 'regular activity': { notes: 'x | Regular activity: add it to the Regular activities page by hand' },
    'possible spam': { notes: 'Possible spam (confidence 0.6)' }, 'date or place missing': { missing: 'cost,where' },
    'a suggested image was chosen': { image_choice: 's12' }, 'low confidence': { confidence: '0.7' },
  };
  for (const [why, extra] of Object.entries(cases)) assert.ok(blockers(good(extra)).includes(why), why);
  assert.ok(blockers(good({ notes: 'Already listed: "X" (pipeline, Holly 90%)' })).includes('already listed'));
  assert.ok(blockers(good({ policy_flags: 'too_early,classified' })).includes('flagged classified'));
  assert.ok(blockers(good({ policy_flags: 'anonymous' })).includes('flagged anonymous'));
  assert.ok(blockers(good(), { outOfScope: true }).includes('out of scope'));
  // Fine: only time, cost or contact missing (Holly doesn't ask), too early, after the deadline, urgent.
  assert.deepEqual(blockers(good({ missing: 'time,cost,contact', policy_flags: 'too_early,after_deadline', urgent: 'TRUE', image_choice: 'none' })), []);
  assert.ok(blockers(good({ confidence: '' })).includes('low confidence'));
});

test('ingest: a window only when the kind is on, clean and nothing blocks', () => {
  const win = { on: ['event'], progress: { event: { clean: true }, notice: { clean: true } } };
  assert.equal(planWindow(good(), win, '2026-11-16 10:17'), '2026-11-16 14:17');
  assert.equal(planWindow(good({ category: 'notice' }), win, '2026-11-16 10:17'), '', 'kind not switched on');
  assert.equal(planWindow(good(), { on: ['event'], progress: { event: { clean: false } } }, '2026-11-16 10:17'), '', 'not 20 clean yet');
  assert.equal(planWindow(good({ official: true }), win, '2026-11-16 10:17'), '');
  assert.equal(planWindow(good(), win, '2026-11-16 10:17', { outOfScope: true }), '');
  assert.equal(planWindow(good(), null, '2026-11-16 10:17'), '');
});

test('end of window: due rows, replies needing Jon, and the re-check', () => {
  const rows = [good({ auto_at: '2026-11-16 14:17' }), good({ id: 'b', auto_at: '2026-11-16 15:00' }), good({ id: 'c', auto_at: 'held: by you' }),
    good({ id: 'd', auto_at: '2026-11-16 09:00', status: 'approved' }), good({ id: 'e', auto_at: '' })];
  assert.deepEqual(due(rows, '2026-11-16 14:30').map((r) => r.id), ['m1-1']);
  assert.deepEqual(due(rows, '2026-11-16 15:00').map((r) => r.id), ['m1-1', 'b']);
  assert.equal(replyBlocks([{ message_id: 'm1', type: 'ack' }, { message_id: 'm1', type: 'live' }], 'm1'), false);
  for (const type of ['clarify', 'held', 'followup', 'own', 'answer', 'holding']) assert.equal(replyBlocks([{ message_id: 'm1', type }], 'm1'), true, type);
  assert.equal(replyBlocks([{ message_id: 'other', type: 'held' }], 'm1'), false);
  const ctx = { on: ['event'], progress: { event: { clean: true } }, replies: [] };
  assert.deepEqual(endOfWindow(good(), ctx), { approve: true });
  assert.match(endOfWindow(good(), { ...ctx, on: [] }).hold, /switched off/);
  assert.match(endOfWindow(good(), { ...ctx, progress: { event: { clean: false } } }).hold, /no longer/);
  assert.match(endOfWindow(good({ duplicate: '{"key":"p:x"}' }), ctx).hold, /already listed/);
  assert.match(endOfWindow(good(), { ...ctx, replies: [{ message_id: 'm1', type: 'held' }] }).hold, /reply/);
});

// A fake Sheet for the runner: tables as { headers, rows }, checkedWrite stale-checks one cell.
function fakeSheet({ setting = 'event', pending, feedback = fbRows(NEEDED), replies = [], decideOk = true }) {
  const tables = {
    Pending: { headers: ['id', 'status', 'people_ok', 'auto_at'], rows: pending },
    'Item feedback': { headers: [], rows: feedback }, Replies: { headers: [], rows: replies },
  };
  const sent = [];
  const reads = [];
  const deps = {
    readSettingsPairs: async () => (setting === null ? [] : [{ key: 'auto_window', value: setting, _row: 16 }]),
    readTable: async (env, tab) => { reads.push(tab); return tables[tab]; },
    checkedWrite: async (env, { key, field, expected, value, onlyStatus }) => {
      const row = tables.Pending.rows.find((r) => r.id === key);
      if (!row) return { ok: false, status: 404 };
      if (onlyStatus && row.status !== onlyStatus) return { ok: false, status: 409 };
      if (String(row[field] ?? '') !== String(expected ?? '')) return { ok: false, status: 409 };
      row[field] = value;
      return { ok: true, value };
    },
    decide: async (env, p) => { sent.push(p); return decideOk; },
  };
  return { deps, tables, sent, reads };
}
const NOW = Date.UTC(2026, 10, 16, 14, 30); // 14:30 UK

test('runner: switched off reads nothing else and sends nothing', async () => {
  for (const setting of ['', 'off', null]) {
    const f = fakeSheet({ setting, pending: [good({ auto_at: '2026-11-16 14:17' })] });
    const out = await runAutoWindow({}, NOW, f.deps);
    assert.deepEqual([out.due, out.published, f.sent.length, f.reads.length], [0, 0, 0, 0]);
  }
});

test('runner: a due item is marked, then approved through decide() exactly as a tap would be', async () => {
  const f = fakeSheet({ pending: [good({ auto_at: '2026-11-16 14:17' }), good({ id: 'later', auto_at: '2026-11-16 16:00' })] });
  const out = await runAutoWindow({}, NOW, f.deps);
  assert.deepEqual(f.sent, [{ a: 'approve', i: 'm1-1' }]);
  assert.equal(f.tables.Pending.rows[0].auto_at, 'publishing 2026-11-16 14:30');
  assert.equal(f.tables.Pending.rows[1].auto_at, '2026-11-16 16:00', 'not due yet: untouched');
  assert.deepEqual([out.due, out.published, out.held], [1, 1, 0]);
  // A second run finds nothing due: no double send.
  await runAutoWindow({}, NOW + 60000, f.deps);
  assert.equal(f.sent.length, 1);
});

test('runner: anything that fails a check is held, never sent', async () => {
  const held = [
    good({ id: 'h1', auto_at: '2026-11-16 12:00', people_in_image: 'TRUE' }),
    good({ id: 'h2', auto_at: '2026-11-16 12:01', duplicate: '{"key":"p:x"}' }),
    good({ id: 'h3', auto_at: '2026-11-16 12:02', message_id: 'held-mail' }),
    good({ id: 'h4', auto_at: '2026-11-16 12:03', category: 'notice' }), // kind not switched on
  ];
  const f = fakeSheet({ pending: held, replies: [{ message_id: 'held-mail', type: 'held' }] });
  const out = await runAutoWindow({}, NOW, f.deps);
  assert.equal(f.sent.length, 0);
  assert.equal(out.held, 4);
  for (const r of f.tables.Pending.rows) assert.match(r.auto_at, /^held: /);
  // The kind no longer has 20 clean: held too.
  const g2 = fakeSheet({ pending: [good({ auto_at: '2026-11-16 12:00' })], feedback: [...fbRows(NEEDED), ...fbRows(1, { outcome: 'rejected', from: NEEDED })] });
  await runAutoWindow({}, NOW, g2.deps);
  assert.equal(g2.sent.length, 0);
  assert.match(g2.tables.Pending.rows[0].auto_at, /^held: the latest 20/);
});

test('runner: GitHub refusing the dispatch puts the time back for the next run', async () => {
  const f = fakeSheet({ pending: [good({ auto_at: '2026-11-16 14:17' })], decideOk: false });
  const out = await runAutoWindow({}, NOW, f.deps);
  assert.equal(out.failed, 1);
  assert.equal(f.tables.Pending.rows[0].auto_at, '2026-11-16 14:17');
});

test('no second approval path: the window adds no decide() action', () => {
  assert.ok(!PANEL_ONLY.some((a) => /window|auto/.test(a)));
});

test('audit and the Autonomy screen', () => {
  assert.deepEqual(planAudit({ outcome: 'window' }, { op: 'fine', expected: 'window' }), { field: 'outcome', expected: 'window', value: 'window_ok' });
  assert.equal(planAudit({ outcome: 'window' }, { op: 'bad', expected: 'window' }).value, 'window_bad');
  assert.equal(planAudit({ outcome: 'window_ok' }, { op: 'bad', expected: 'window_ok' }).value, 'window_bad');
  assert.equal(planAudit({ outcome: 'approved' }, { op: 'bad', expected: 'approved' }).status, 400);
  assert.equal(planAudit({ outcome: 'window' }, { op: 'fine', expected: 'approved' }).status, 409);
  assert.equal(planAudit(null, { op: 'fine', expected: '' }).status, 404);
  const feedback = [...fbRows(12), ...fbRows(7, { outcome: 'window', from: 12 }), ...fbRows(3, { type: 'notice' })];
  const w = windowStatus({ settingValue: 'event', feedbackRows: feedback, pendingRows: [good({ auto_at: '2026-11-16 14:17' }), good({ id: 'x', auto_at: 'held: by you' })] });
  assert.equal(w.ready, true);
  assert.deepEqual(w.kinds.map((k) => [k.kind, k.on, k.run, k.clean]), [['event', true, 12, false], ['notice', false, 3, false]]);
  assert.deepEqual(w.waiting, [{ id: 'm1-1', title: 'Quiz', at: '2026-11-16 14:17' }]);
  assert.equal(w.auditTotal, 7);
  assert.equal(w.audit.length, 5, 'the sample: the oldest five');
  assert.equal(w.audit[0].title, 'T12');
  assert.equal(windowStatus({ settingValue: undefined }).ready, false);
  assert.equal(windowStatus({ settingValue: 'event', hasColumn: false }).ready, false);
  // The existing stats: an audited item counts, an unaudited one doesn't; a self-published row can be ignored.
  const st = autonomyStats({ items: { rows: [...fbRows(2), ...fbRows(1, { outcome: 'window', from: 2 }), ...fbRows(1, { outcome: 'window_ok', from: 3 }), ...fbRows(1, { outcome: 'window_bad', from: 4 })] }, replies: { rows: [] } });
  assert.deepEqual([st.items[0].decided, st.items[0].unchanged, st.items[0].rejected], [4, 3, 1]);
  assert.equal(planIgnore({ outcome: 'window_bad' }, { op: 'ignore', expected: 'window_bad' }).value, 'ignored:window_bad');
});

test('heads-up email: titles and times only', () => {
  const one = headsUp([{ title: 'Quiz', kind: 'event', at: '2026-11-16 14:17' }], 'https://x/admin');
  assert.equal(one.subject, '1 item will publish itself (Lenches)');
  assert.match(one.text, /- Quiz \(event\): 2026-11-16 14:17/);
  assert.match(one.text, /tap Hold/);
  assert.equal(headsUp([{}, {}], 'u').subject, '2 items will publish themselves (Lenches)');
});
