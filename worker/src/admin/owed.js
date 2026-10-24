// worker/src/admin/owed.js
// "Still owed a reply", read-only, as scripts/ingest/replies.js owedReplies decides it:
// a holding reply sent more than OWED_HOURS ago, not closed, with nothing real sent on
// its thread since. Keep in step with replies.js if that rule changes.

const TZ = 'Europe/London';
export const OWED_HOURS = 48;
const CLOSED_CODE = 'closed';

export function londonDateTime(ms) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${date} ${time}`;
}

const splitCodes = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// rows: every Replies row. Returns [{ holding, draft }] (draft: the reply waiting or the
// latest one for that email, or null).
export function owedReplies(rows, now = Date.now()) {
  const cutoff = londonDateTime(now - OWED_HOURS * 3600000);
  const out = [];
  for (const h of rows) {
    if (h.type !== 'holding' || h.status !== 'sent' || !h.sent_at || String(h.sent_at) > cutoff) continue;
    if (splitCodes(h.policy_codes).includes(CLOSED_CODE)) continue;
    const answered = rows.some((r) => r !== h && r.thread_id === h.thread_id && r.type !== 'holding'
      && ['sent', 'sending'].includes(r.status));
    if (answered) continue;
    const drafts = rows.filter((r) => r.message_id === h.message_id && !['holding', 'none'].includes(r.type)
      && r.status !== 'redrafted');
    out.push({ holding: h, draft: drafts.find((r) => r.status === 'awaiting') || drafts[drafts.length - 1] || null });
  }
  return out;
}
