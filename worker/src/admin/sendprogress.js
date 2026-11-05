// worker/src/admin/sendprogress.js
// Send progress (5 Nov, Jon): after Send to all, the panel's draft bar shows how far the send has
// got, from the Sends tab rows scripts/newsletter/send.js writes (queued -> sending -> sent /
// failed / stuck) and the Issues row's status. Counts only: no address leaves the Worker.

const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();
export const PROGRESS_MODES = ['live', 'canary'];

// { issue, mode, total, sent, failed, stuck, queued, sending, status, done }
export function sendProgress(sends, issues, issueDate, mode = 'live') {
  const key = mode === 'canary' ? `${issueDate}:canary` : issueDate;
  const mine = (sends || []).filter((r) => str(r.issue_id) === key);
  const n = (s) => mine.filter((r) => lc(r.status) === s).length;
  const row = (issues || []).find((r) => str(r.issue_date).slice(0, 10) === issueDate || str(r.issue_id) === issueDate);
  const status = row ? lc(row.status) : '';
  const out = { issue: issueDate, mode, total: mine.length, sent: n('sent'), failed: n('failed'), stuck: n('stuck'), queued: n('queued'), sending: n('sending'), status };
  // Live: done once the Issues row says sent. Canary leaves the status alone: done when nothing waits.
  out.done = mode === 'live' ? status === 'sent' : out.total > 0 && !out.queued && !out.sending;
  return out;
}
