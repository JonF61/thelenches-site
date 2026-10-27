// scripts/test-signup.js
// Offline tests for the web sign-up workflow script (scripts/signup): send (confirmation,
// "already on the list", held for Do Not Send), confirm (subscribed, held, replays), the
// 30-day wipe of unconfirmed addresses, and that nothing logged contains an address.
// Google and Gmail are faked; nothing leaves the machine. Run: node scripts/test-signup.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.APPROVAL_SIGNING_KEY = 'test-key';
process.env.WORKER_URL = 'https://approvals.example.workers.dev';
process.env.GMAIL_USER = 'jon@example.org';

const signup = require('./signup');
const { signToken } = require('./ingest/links');

const MS = Date.UTC(2026, 9, 27, 10, 0);
const ID = 'su-20261027-abc123';

function world({ signups, subscribers = [], dns = [] }) {
  const tabs = { 'Sign-ups': signups, Subscribers: subscribers, 'Do Not Send': dns };
  const sent = [];
  const updates = [];
  const g = {
    ensureTab: async () => false,
    readTable: async (tab) => tabs[tab].map((r, i) => ({ _row: i + 2, ...r })),
    readSettings: async () => ({ settings: { from_name: 'The Lenches Website and Newsletter Team' } }),
    fromNameFor: (s) => s.from_name,
    sendMail: async (m) => { sent.push(m); return 'msg1'; },
    updateRow: async (tab, row, fields) => { updates.push({ tab, row, fields }); Object.assign(tabs[tab][row - 2], fields); },
    appendRows: async (tab, rows) => { tabs[tab].push(...rows); },
  };
  // The real applyListRequest, on the fake Sheet.
  const google = require('./ingest/google');
  Object.assign(google, { readTable: g.readTable, appendRows: g.appendRows });
  const { applyListRequest } = require('./ingest/subscriptions');
  return { tabs, sent, updates, deps: { g, applyListRequest, signToken } };
}

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

const previews = {};

(async () => {
  // send: a new address gets the confirmation email with a 7-day /s link.
  let w = world({ signups: [{ id: ID, requested: '2026-10-27 10:00', email: 'reader@example.org', status: 'new' }] });
  assert.strictEqual(await signup.run({ action: 'send', id: ID, ms: MS }, w.deps), 'sent');
  assert.strictEqual(w.sent.length, 1);
  const mail = w.sent[0];
  assert.strictEqual(mail.to, 'reader@example.org');
  assert.strictEqual(mail.from, 'website@thelenches.org.uk');
  assert.strictEqual(mail.subject, 'Please confirm: The Lenches Newsletter');
  const link = mail.text.match(/https:\/\/approvals\.example\.workers\.dev\/s\?t=(\S+)/);
  assert.ok(link, 'link to /s');
  const payload = JSON.parse(Buffer.from(link[1].split('.')[0], 'base64url').toString());
  assert.deepStrictEqual({ a: payload.a, i: payload.i }, { a: 'signup', i: ID });
  assert.strictEqual(payload.e, Math.floor(MS / 1000) + 7 * 86400);
  assert.ok(mail.html.includes('width="600"') && mail.html.includes('Yes, add me to the list'), 'Outlook-safe HTML with button');
  assert.ok(!/jon@/i.test(mail.html + mail.text), 'never exposes jon@');
  assert.strictEqual(w.tabs['Sign-ups'][0].status, 'sent');
  previews.confirm = mail;
  // Replayed send: nothing more.
  assert.strictEqual(await signup.run({ action: 'send', id: ID, ms: MS }, w.deps), 'skipped');
  assert.strictEqual(w.sent.length, 1);

  // confirm: added to Subscribers with source "web form".
  assert.strictEqual(await signup.run({ action: 'confirm', id: ID, ms: MS + 3600e3 }, w.deps), 'subscribed');
  const sub = w.tabs.Subscribers[0];
  assert.strictEqual(sub.email, 'reader@example.org');
  assert.strictEqual(sub.status, 'active');
  assert.strictEqual(sub.source, 'web form');
  assert.strictEqual(w.tabs['Sign-ups'][0].status, 'subscribed');
  assert.strictEqual(await signup.run({ action: 'confirm', id: ID, ms: MS + 7200e3 }, w.deps), 'skipped');
  assert.strictEqual(w.tabs.Subscribers.length, 1, 'replayed confirm adds nothing');

  // A confirm too long after the email does nothing.
  w = world({ signups: [{ id: ID, requested: '2026-10-01 10:00', email: 'late@example.org', status: 'sent', sent_at: '2026-10-01 10:01' }] });
  assert.strictEqual(await signup.run({ action: 'confirm', id: ID, ms: MS }, w.deps), 'late');
  assert.strictEqual(w.tabs.Subscribers.length, 0);

  // Already subscribed: the "already on the list" email instead.
  w = world({
    signups: [{ id: ID, requested: '2026-10-27 10:00', email: 'old@example.org', status: 'new' }],
    subscribers: [{ email: 'Old@Example.org', status: 'active' }],
  });
  assert.strictEqual(await signup.run({ action: 'send', id: ID, ms: MS }, w.deps), 'already');
  assert.strictEqual(w.sent[0].subject, 'You\'re already on the list: The Lenches Newsletter');
  assert.ok(!/\/s\?t=/.test(w.sent[0].text), 'no confirm link');
  previews.already = w.sent[0];

  // On Do Not Send: nothing to them, held, Jon emailed.
  w = world({
    signups: [{ id: ID, requested: '2026-10-27 10:00', email: 'gone@example.org', status: 'new' }],
    dns: [{ email: 'gone@example.org' }],
  });
  assert.strictEqual(await signup.run({ action: 'send', id: ID, ms: MS }, w.deps), 'held');
  assert.strictEqual(w.sent.length, 1);
  assert.strictEqual(w.sent[0].to, 'jon@example.org');
  assert.ok(w.sent[0].text.includes('gone@example.org') && w.sent[0].text.includes('row 2'));
  assert.strictEqual(w.tabs['Sign-ups'][0].status, 'held');
  previews.held = w.sent[0];

  // Confirmed, but their Subscribers row has another status: held for Jon.
  w = world({
    signups: [{ id: ID, requested: '2026-10-27 10:00', email: 'odd@example.org', status: 'sent', sent_at: '2026-10-27 10:00' }],
    subscribers: [{ email: 'odd@example.org', status: 'bounced' }],
  });
  assert.strictEqual(await signup.run({ action: 'confirm', id: ID, ms: MS }, w.deps), 'held');
  assert.match(w.tabs['Sign-ups'][0].result, /status "bounced"/);
  assert.strictEqual(w.sent[0].to, 'jon@example.org');

  // 30-day wipe: unconfirmed old rows lose their address; held and subscribed rows don't.
  w = world({
    signups: [
      { id: 'su-20260901-aaaaaa', requested: '2026-09-01 09:00', email: 'a@example.org', status: 'sent' },
      { id: 'su-20260901-bbbbbb', requested: '2026-09-01 09:00', email: 'b@example.org', status: 'held' },
      { id: 'su-20260901-cccccc', requested: '2026-09-01 09:00', email: 'c@example.org', status: 'subscribed' },
      { id: 'su-20261020-dddddd', requested: '2026-10-20 09:00', email: 'd@example.org', status: 'sent' },
      { id: ID, requested: '2026-10-27 10:00', email: 'e@example.org', status: 'new' },
    ],
  });
  await signup.run({ action: 'send', id: ID, ms: MS }, w.deps);
  assert.deepStrictEqual(w.tabs['Sign-ups'].map((r) => r.email), ['', 'b@example.org', 'c@example.org', 'd@example.org', 'e@example.org']);
  assert.strictEqual(w.tabs['Sign-ups'][0].status, 'expired');

  // Unknown id, bad input.
  assert.strictEqual(await signup.run({ action: 'send', id: 'su-20261027-zzzzzz', ms: MS }, w.deps), 'missing');
  await assert.rejects(signup.run({ action: 'delete', id: ID }, w.deps), /ACTION/);
  await assert.rejects(signup.run({ action: 'send', id: 'reader@example.org' }, w.deps), /SIGNUP_ID/);

  assert.ok(!logs.some((l) => l.includes('@')), 'no address in any log line');

  const out = path.join(process.env.PREVIEW_DIR || require('os').tmpdir(), 'signup-previews');
  fs.mkdirSync(out, { recursive: true });
  for (const [k, m] of Object.entries(previews)) fs.writeFileSync(path.join(out, `${k}.html`), m.html);
  console.log = realLog;
  console.log(`test-signup: all passed (previews in ${out})`);
})().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
