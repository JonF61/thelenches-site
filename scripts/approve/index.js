// scripts/approve/index.js
// Applies one button click, sent by the Cloudflare Worker via repository_dispatch.
//   approve / reject  Pending items. Only rows still "pending" change.
//   send / skip       Submitter replies (Replies tab). Only rows still "awaiting" change;
//                     Send uses the body cell as it is now (see scripts/ingest/replies.js).
// Replayed or duplicate clicks therefore do nothing.
'use strict';

const g = require('../ingest/google');
const replies = require('../ingest/replies');

const TZ = 'Europe/London';

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

  const status = action === 'approve' ? 'approved' : 'rejected';
  await g.updateRow('Pending', row._row, { status, decided_at: londonDateTime(Date.now()) });
  console.log(`Item ${id} ("${row.title}") marked ${status}.`);
}

async function main() {
  const id = String(process.env.ITEM_ID || '').trim();
  const action = String(process.env.ACTION || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`Bad id "${id}"`);

  if (['approve', 'reject'].includes(action)) return decideItem(id, action);
  if (['send', 'skip'].includes(action)) return replies.decideReply(id, action);
  throw new Error(`Bad action "${action}"`);
}

main().catch((err) => {
  console.error('Fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
