// Offline test: unsubscribing deletes the Subscribers row(s) and Holly emails Jon (14 Nov).
// node scripts/test-unsubscribe-tidy.js
'use strict';

const assert = require('assert');
const { removeFromSubscribers, unsubscribedEmail, planTidy } = require('./ingest/subscriptions');
const { tidyEmail } = require('./newsletter/tidy-subscribers');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log(`ok - ${m}`); };

(async () => {
  process.env.GMAIL_USER = 'team@example.org';
  const sent = [];
  let deleted = null;
  const fake = {
    readTable: async () => [
      { _row: 2, email: 'a@example.com', status: 'active' },
      { _row: 3, email: ' Gone@Example.com ', status: 'active' },
      { _row: 7, email: 'gone@example.com', status: '' },
    ],
    deleteRows: async (tab, rows) => { deleted = { tab, rows }; return rows.length; },
    readSettings: async () => ({ settings: {} }),
    fromNameFor: () => 'The Lenches Website and Newsletter Team',
    sendMail: async (m) => { sent.push(m); return 'id'; },
  };

  const n = await removeFromSubscribers('GONE@example.com', 'link', { g: fake });
  ok(n === 2 && deleted.tab === 'Subscribers' && deleted.rows.join() === '3,7', 'every row for the address deleted, case-insensitive');
  ok(sent.length === 1 && sent[0].to === 'team@example.org', 'one email to Jon');
  ok(/^Unsubscribed: gone@example\.com$/.test(sent[0].subject), 'subject names the address');
  ok(/unsubscribe link in the newsletter/.test(sent[0].text) && /\(2 rows\)/.test(sent[0].text), 'says how and how many rows');
  ok(/Best wishes,\nHolly\nLenches website assistant/.test(sent[0].text), 'signed by Holly');

  const none = unsubscribedEmail('x@example.com', 'email', 0);
  ok(/by emailing website@/.test(none.text) && /no row in the Subscribers tab/.test(none.text), 'no-row wording');

  const plan = planTidy(
    [{ _row: 2, email: 'keep@example.com' }, { _row: 3, email: 'Off@example.com' }],
    [{ email: 'off@example.com' }, { email: '' }],
  );
  ok(plan.length === 1 && plan[0]._row === 3, 'tidy picks only rows on Do Not Send');

  const t = tidyEmail(['a@x.com', 'b@x.com']);
  ok(/deleted 2 rows/.test(t.text) && /- a@x\.com\n- b@x\.com/.test(t.text) && /2 unsubscribed people/.test(t.subject), 'tidy email lists them');

  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
