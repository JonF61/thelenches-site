// scripts/newsletter/unsubscribe.js
// One-click unsubscribe (step 5b part 3). repository_dispatch "unsubscribe" from the
// Worker's /u endpoint carries an opaque subscriber id (see unsub.js). Finds the
// matching address in Subscribers and adds it to Do Not Send, once.
// Never logs the address: this repo's Actions logs are public.
// Env: GOOGLE_SA_KEY, SHEET_ID, APPROVAL_SIGNING_KEY, SUB_ID.
'use strict';

const g = require('../ingest/google');
const { subscriberId } = require('./unsub');

const TZ = 'Europe/London';
const str = (v) => String(v ?? '').trim();
const lc = (v) => str(v).toLowerCase();

function stamp(ms = Date.now()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

async function main() {
  const id = str(process.env.SUB_ID);
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error('SUB_ID is missing or malformed');

  const [subscribers, dns] = await Promise.all([g.readTable('Subscribers'), g.readTable('Do Not Send')]);
  const emails = [...new Set(subscribers.map((r) => lc(r.email)).filter(Boolean))];
  const match = emails.find((e) => subscriberId(e) === id);
  if (!match) {
    console.log('No subscriber matches this id (already removed, or a test link). Nothing to do.');
    return;
  }
  if (dns.some((r) => lc(r.email) === match)) {
    console.log('Already on Do Not Send. Nothing to do.');
    return;
  }
  const now = stamp();
  // appendRows fills only the headers that exist on the tab.
  await g.appendRows('Do Not Send', [{
    email: match, reason: 'unsubscribe link', source: 'unsubscribe link',
    date: now.slice(0, 10), added_at: now, notes: 'one-click unsubscribe',
  }]);
  console.log('Added to Do Not Send.');
}

main().catch((err) => {
  console.error('Fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
