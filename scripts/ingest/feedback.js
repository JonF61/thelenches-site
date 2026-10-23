// scripts/ingest/feedback.js
// Learning log (agreed 23 Oct): the "Reply feedback" tab records each reply Holly drafted
// beside what actually happened to it, so Jon can now and then distil the lessons into
// voice.md and templates.md. Nothing reads it automatically.
//
// One row per drafted reply (clarify, answer, whattodo, held, followup, sorry), written
// when the draft is made; outcome, final_text, reason and decided_at are filled in later:
//   approved     Jon pressed Approve and the draft went as written
//   edited       Jon changed it (Edit email, or the Replies body cell) before it went
//   rejected     Jon pressed Reject (reason from the confirm page, if given)
//   auto_sent    sent by Holly in holiday mode
//   timed_out    no decision in 24h: the acknowledgement went without the question
//   shadow       shadow mode: never sent
// Jon can type a reason in the tab by hand at any time.
// The tab is created (at the end, after every other tab) the first time it is needed.
// Writes here never stop a reply: failures only warn.
'use strict';

const g = require('./google');

const TAB = 'Reply feedback';
const HEADERS = ['reply_id', 'created_at', 'type', 'class', 'class_confidence', 'mode', 'they_wrote',
  'draft', 'outcome', 'final_text', 'reason', 'decided_at'];
const TYPES = ['clarify', 'answer', 'whattodo', 'held', 'followup', 'sorry'];
const EXCERPT = 600;

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const excerpt = (s) => (flat(s).length > EXCERPT ? `${flat(s).slice(0, EXCERPT)}…` : flat(s));

const warn = (what, err) => console.warn(`Reply feedback: ${what} failed: ${(err && err.message) || err}`);

// row: the Replies row just written. theyWrote: the sender's text (quoted text removed).
async function record(row, { theyWrote = '', mode = '' } = {}) {
  if (!TYPES.includes(row.type)) return;
  try {
    await g.ensureTab(TAB, HEADERS);
    await g.appendRows(TAB, [{
      reply_id: row.reply_id,
      created_at: row.created_at,
      type: row.type,
      class: row.class || '',
      class_confidence: row.class_confidence === undefined ? '' : row.class_confidence,
      mode,
      they_wrote: excerpt(theyWrote),
      draft: row.body,
      outcome: row.status === 'shadow' ? 'shadow' : '',
    }]);
  } catch (err) {
    warn(`recording ${row.reply_id}`, err);
  }
}

// Fills in what happened. "approved" becomes "edited" when the text sent differs from the
// draft (body cell edited in the Sheet). Only the first decision is recorded.
async function resolve(replyId, { outcome, finalText = '', reason = '', decidedAt = '' }) {
  try {
    const rows = await g.readTable(TAB).catch(() => []);
    const row = rows.find((r) => r.reply_id === replyId);
    if (!row || String(row.outcome || '').trim()) return;
    let out = outcome;
    if (out === 'approved' && finalText && flat(finalText) !== flat(row.draft)) out = 'edited';
    await g.updateRow(TAB, row._row, {
      outcome: out,
      final_text: out === 'rejected' ? '' : finalText,
      reason: reason || row.reason || '',
      decided_at: decidedAt,
    });
  } catch (err) {
    warn(`updating ${replyId}`, err);
  }
}

module.exports = { record, resolve, TAB, HEADERS, TYPES };
