// scripts/approve/index.js
// Applies one button click, sent by the Cloudflare Worker via repository_dispatch.
//   approve / reject  Pending items. Only rows still "pending" change.
//   approve_own / approve_rewrite
//                     Approve, publishing the submitter's own wording or our rewrite
//                     (Pending "wording" column, lib/wording.js). Same rule as approve.
//   send / skip       Submitter replies (Replies tab). Only rows still "awaiting" change;
//                     Send uses the body cell as it is now (see scripts/ingest/replies.js).
// Replayed or duplicate clicks therefore do nothing.
'use strict';

const g = require('../ingest/google');
const replies = require('../ingest/replies');

const TZ = 'Europe/London';
const WORDING = { approve_own: 'own', approve_rewrite: 'rewrite' };
const ITEM_ACTIONS = ['approve', 'reject', ...Object.keys(WORDING)];

function londonDateTime(ms) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return `${date} ${time}`;
}

async function decideItem(id, action) {
  const rows = await g.readTable('Pending');
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`Item ${id} not found in Pending`);

  if (row.status !== 'pending') {
    console.log(`Item ${id} is already "${row.status}"; nothing to do.`);
    return;
  }

  const status = action === 'reject' ? 'rejected' : 'approved';
  const fields = { status, decided_at: londonDateTime(Date.now()) };
  const wording = WORDING[action];
  if (wording) {
    if (!('wording' in row)) {
      // Approve anyway: refusing would lose the click. The default wording applies.
      console.warn('Pending has no "wording" column; approved with the default wording.');
    } else if (wording === 'own' && !String(row.own_text || '').trim()) {
      console.warn('No own_text on this row; approved with the rewrite.');
      fields.wording = 'rewrite';
    } else {
      fields.wording = wording;
    }
  }
  await g.updateRow('Pending', row._row, fields);
  console.log(`Item ${id} ("${row.title}") marked ${status}${fields.wording ? ` (${fields.wording} wording)` : ''}.`);
}

async function main() {
  const id = String(process.env.ITEM_ID || '').trim();
  const action = String(process.env.ACTION || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`Bad id "${id}"`);

  if (ITEM_ACTIONS.includes(action)) return decideItem(id, action);
  if (['send', 'skip'].includes(action)) return replies.decideReply(id, action);
  throw new Error(`Bad action "${action}"`);
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
