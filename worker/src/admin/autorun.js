// worker/src/admin/autorun.js
// End of a veto window (autowindow.mjs; Jon, 15 Nov 2026). Called by the Worker's half-hourly
// cron. For each Pending row whose auto_at time has passed and that is still waiting: re-check
// everything (switch, the kind's latest 20, the never-automatic list, replies needing Jon, and
// planPending's own approve checks), then send the ordinary `approve` through decide(): the same
// path as Jon's tap. A row that fails a check is marked "held: <why>" and waits for him.
// Logs print counts and ids only.
import { readTable, readSettingsPairs, checkedWrite } from './sheet.js';
import { planPending } from './actions.js';
import { decide } from '../core.js';
import {
  SETTING, COLUMN, KINDS, MAX_PER_RUN, kindsOn, ukStamp, due, kindProgress, endOfWindow,
} from './autowindow.mjs';

const ITEM_TAB = 'Item feedback';
const real = { readTable, readSettingsPairs, checkedWrite, decide };

export async function runAutoWindow(env, ms, deps = real) {
  const out = { on: [], due: 0, published: 0, held: 0, failed: 0 };
  const pairs = await deps.readSettingsPairs(env);
  const setting = pairs.find((p) => p.key === SETTING);
  out.on = kindsOn(setting && setting.value);
  if (!out.on.length) return out; // switched off: nothing else is read
  const pending = await deps.readTable(env, 'Pending');
  if (!pending.headers.includes(COLUMN)) return out;
  const now = ukStamp(ms);
  const rows = due(pending.rows, now).slice(0, MAX_PER_RUN);
  out.due = rows.length;
  if (!rows.length) return out;
  const [feedback, replies] = await Promise.all([deps.readTable(env, ITEM_TAB), deps.readTable(env, 'Replies')]);
  const progress = Object.fromEntries(KINDS.map((k) => [k, kindProgress(feedback.rows, k)]));
  const write = (row, expected, value) => deps.checkedWrite(env, {
    tab: 'Pending', keyCol: 'id', key: row.id, field: COLUMN, expected, value, onlyStatus: 'pending',
  });
  for (const row of rows) {
    const at = String(row[COLUMN]);
    const mark = (r, value) => write(r, at, value);
    const end = endOfWindow(row, { on: out.on, progress, replies: replies.rows });
    const plan = end.approve ? planPending({ action: 'approve', id: row.id }, row, { hasPeopleOk: pending.headers.includes('people_ok') }) : null;
    const hold = end.hold || (plan && plan.error) || '';
    if (hold) {
      const r = await mark(row, `held: ${hold}`.slice(0, 120));
      if (r.ok) out.held += 1;
      continue;
    }
    // Mark first (stale-checked): if Jon has just held, edited or decided it, nothing is sent.
    const marked = await mark(row, `publishing ${now}`);
    if (!marked.ok) continue;
    if (await deps.decide(env, plan.p)) { out.published += 1; continue; }
    out.failed += 1;
    // GitHub didn't take it: put the time back so the next run tries again.
    await write(row, `publishing ${now}`, at);
  }
  console.log(`Veto window ${now} UK: ${out.due} due, ${out.published} sent to publish, ${out.held} held, ${out.failed} failed.`);
  return out;
}
