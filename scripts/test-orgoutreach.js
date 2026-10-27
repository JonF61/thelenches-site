// scripts/test-orgoutreach.js
// Offline test of organisation outreach on the GitHub side: scripts/outreach/orgs.js
// draftOrgCheck as scripts/approve runs it for a Draft check tap (the panel's rules re-checked,
// the fixed template with their entry as the site shows it, opt-out line and Holly's
// signature, no Claude), then Approve (a new thread), the chaser 21 days later (sent on the
// check's thread), a reply stopping the chaser, never / no email / the daily cap, and the
// nudge weekly cap ignoring organisation drafts. Google and Gmail are mocked; nothing
// leaves the machine. Run: node scripts/test-orgoutreach.js
'use strict';

const assert = require('assert');

process.env.GMAIL_USER = 'owner@thelenches.org.uk';
const sdkPath = require.resolve('@anthropic-ai/sdk');
let claudeCalls = 0;
class FakeAnthropic {
  constructor() { this.messages = { create: async () => { claudeCalls += 1; throw new Error('no Claude here'); } }; }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const g = require('./ingest/google');
const fbHeaders = require('./ingest/feedback').HEADERS;
const HEADERS = {
  Replies: ['reply_id', 'message_id', 'thread_id', 'to', 'type', 'status', 'policy_codes', 'subject', 'body',
    'notes', 'created_at', 'sent_at', 'sent_gmail_id', 'decided_at', 'alerted_at', 'class', 'class_confidence', 'hold_reason'],
  Contacts: ['email', 'name', 'status', 'last_contact', 'other_emails'],
  'Org outreach': ['id', 'next_check', 'notes'],
  'Reply feedback': fbHeaders,
};
let tables;
let sent;
let settings;
const pick = (tab, o) => Object.fromEntries(HEADERS[tab].map((h) => [h, o[h] === undefined || o[h] === null ? '' : String(o[h])]));
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings }),
  readTable: async (tab) => {
    if (!tables[tab]) throw new Error(`Unable to parse range: '${tab}'!A1:AZ`);
    return tables[tab].map((r, i) => ({ ...r, _row: i + 2 }));
  },
  appendRows: async (tab, objs) => { tables[tab].push(...objs.map((o) => pick(tab, o))); },
  updateRow: async (tab, n, fields) => { Object.assign(tables[tab][n - 2], fields); },
  ensureTab: async () => false,
  sendAsAddresses: async () => ['owner@thelenches.org.uk', 'website@thelenches.org.uk'],
  sendMail: async (m) => { sent.push(m); return `sent-${sent.length}`; },
  getMessage: async (id) => {
    if (id.startsWith('sent-')) {
      const n = Number(id.slice(5));
      return { fromAddress: sent[n - 1].from, threadId: `thread-${n}`, rfcMessageId: `<msg-${n}@mail.gmail.com>`, references: '' };
    }
    throw new Error(`no message ${id}`);
  },
  getSheetGid: async () => 0,
  spreadsheetId: () => 'sheet',
});

const orgs = require('./outreach/orgs');
const replies = require('./ingest/replies');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now());
const shift = (days) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

function reset() {
  tables = { Replies: [], 'Reply feedback': [], Contacts: [] };
  sent = [];
  settings = { replies_mode: 'live', from_name: 'The Lenches Website and Newsletter Team' };
}

async function main() {
  // Draft check: the Lenches Club (Groups page).
  reset();
  const fresh = await orgs.draftOrgCheck('lenches-club');
  const row = tables.Replies[0];
  ok(fresh && row.type === 'outreach' && row.status === 'awaiting' && row.to === 'lenchesclubmail@gmail.com', 'awaiting outreach row');
  ok(row.policy_codes === 'org_check_lenches-club' && /^org-lenches-club-check-\d{12}$/.test(row.reply_id), 'policy code and slug id');
  ok(row.subject === 'Your entry on thelenches.org.uk' && row.message_id === '' && row.thread_id === '', 'subject; a new thread');
  ok(row.body.startsWith('Hi there,\n\nI help look after thelenches.org.uk,'), 'greeting');
  ok(row.body.includes('The Lenches Club is listed on our Groups & Clubs page, and we\'d like to make sure the details are right:\nhttps://thelenches.org.uk/groups/'), 'page and link');
  ok(row.body.includes('This is what it shows at the moment:\nThe Lenches Club\nlenchesclubmail@gmail.com\n01386 870221\nhttps://thelenchesclub.co.uk/\n\nCould you'), 'their entry as the site shows it');
  ok(row.body.endsWith("If you'd rather we didn't get in touch like this, just say and we won't.\n\nBest wishes,\nHolly\nLenches website assistant"), 'opt-out and Holly sign-off');
  ok(claudeCalls === 0, 'fixed template: no Claude');
  ok(tables['Reply feedback'].some((r) => r.reply_id === row.reply_id), 'logged in Reply feedback');
  console.log('--- sample check email ---\n' + row.body + '\n---');

  ok(await orgs.draftOrgCheck('lenches-club') === null && tables.Replies.length === 1, 'replayed tap: a draft is waiting');
  await replies.sendDueReplies({ ...settings, holiday_mode: 'TRUE' }, true);
  ok(sent.length === 0, 'never sent without Jon, even in holiday mode');

  // Approve: a new thread, no automatic-reply headers.
  await replies.decideReply(row.reply_id, 'send');
  ok(sent.length === 1 && !sent[0].threadId && !sent[0].headers['In-Reply-To'] && !sent[0].headers['Auto-Submitted'], 'sent as a new thread');
  ok(tables.Replies[0].status === 'sent', 'marked sent');
  ok(await orgs.draftOrgCheck('lenches-club') === null, 'just checked: no chaser yet');

  // 22 days on, no reply: the chaser, on the check's thread.
  tables.Replies[0].created_at = `${shift(-22)} 10:00`;
  tables.Replies[0].sent_at = `${shift(-22)} 10:05`;
  const chase = await orgs.draftOrgCheck('lenches-club');
  ok(chase && chase.policy_codes === 'org_chase_lenches-club' && chase.subject === 'Re: Your entry on thelenches.org.uk', 'chaser drafted');
  ok(chase.body === "Hi there,\n\nJust following up on my note about The Lenches Club's entry on our Groups & Clubs page. If everything's still correct, there's no need to reply, and we'll assume it's all fine. If anything has changed, a quick reply is all we need.\n\nBest wishes,\nHolly\nLenches website assistant",
    'chaser wording, no opt-out line');
  console.log('--- sample chaser ---\n' + chase.body + '\n---');
  await replies.decideReply(chase.reply_id, 'send');
  ok(sent[1].threadId === 'thread-1' && sent[1].headers['In-Reply-To'] === '<msg-1@mail.gmail.com>' && !sent[1].headers['Auto-Submitted'], 'chaser on the check\'s thread');
  ok(await orgs.draftOrgCheck('lenches-club') === null, 'chased: nothing more');

  // A reply after the check stops the chaser.
  reset();
  tables.Replies.push(pick('Replies', { reply_id: 'c1', type: 'outreach', to: 'info@rouslench.com', status: 'sent',
    policy_codes: 'org_check_rous-lench-hall', created_at: `${shift(-25)} 09:00`, sent_at: `${shift(-25)} 09:01`, sent_gmail_id: 'x' }));
  tables.Contacts.push(pick('Contacts', { email: 'someone@example.org', other_emails: 'info@rouslench.com', status: 'organiser', last_contact: shift(-20) }));
  ok(await orgs.draftOrgCheck('rous-lench-hall') === null && tables.Replies.length === 1, 'replied (Contacts other_emails): no chaser');

  // Parish council: the clerk's first name.
  reset();
  const pc = await orgs.draftOrgCheck('south-lenches-pc');
  ok(pc.body.startsWith('Hi Kate,') && pc.body.includes('Clerk: Kate Lee') && pc.to === 'clerk@southlenchesparishcouncil.org', 'clerk greeting and entry');

  // A body from another data file, with a hidden outreach address.
  reset();
  const gp = await orgs.draftOrgCheck('grey-gable');
  ok(gp.to === 'grey.gable@nhs.net' && gp.body.includes('Grey Gable Surgery\nHigh St, Inkberrow WR7 4BW\n01386 793007\n')
    && !gp.body.includes('grey.gable@'), 'health.json entry; the address Holly writes to is not quoted');

  // No email, never, the daily cap, replies off.
  reset();
  ok(await orgs.draftOrgCheck('glads') === null && tables.Replies.length === 0, 'no email: nothing');
  ok(await orgs.draftOrgCheck('no-such-org') === null, 'unknown id: nothing');
  tables['Org outreach'] = [pick('Org outreach', { id: 'tennis', next_check: 'never' }), pick('Org outreach', { id: 'cricket', next_check: shift(30) })];
  ok(await orgs.draftOrgCheck('tennis') === null && await orgs.draftOrgCheck('cricket') === null && tables.Replies.length === 0, 'never and done/snoozed');
  tables['Org outreach'][1].next_check = shift(-1);
  ok(await orgs.draftOrgCheck('cricket'), 'next_check passed: due again');
  reset();
  for (let i = 0; i < 10; i += 1) tables.Replies.push(pick('Replies', { reply_id: `o${i}`, type: 'outreach', to: `p${i}@example.org`, status: 'skipped', policy_codes: `org_check_x${i}`, created_at: `${today} 09:0${i}` }));
  ok(await orgs.draftOrgCheck('tennis') === null && tables.Replies.length === 10, 'daily cap of 10');
  const { weekCount } = await import('../worker/src/admin/outreach.mjs');
  ok(weekCount(tables.Replies, today) === 0, 'organisation drafts don\'t use the nudge weekly cap');
  reset();
  settings.replies_mode = 'off';
  ok(await orgs.draftOrgCheck('tennis') === null && tables.Replies.length === 0, 'replies off: nothing');
  reset();
  settings.replies_mode = 'shadow';
  ok((await orgs.draftOrgCheck('tennis')).status === 'shadow', 'shadow mode: logged only');

  console.log(`All organisation outreach tests passed (${checks} checks).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
