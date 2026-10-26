// scripts/test-outreach.js
// Offline test of outreach (Contacts phase 3) on the GitHub side: scripts/outreach draftNudge
// as scripts/approve runs it for a Draft nudge tap (the panel's rules re-checked, the
// awaiting Replies row with greeting, opt-out line and Holly's signature), then the usual
// Approve (a new thread: no threading or Auto-Submitted headers), Redraft (opt-out kept
// once) and the card. Google, Gmail and Claude are mocked; nothing leaves the machine.
// Run: node scripts/test-outreach.js
'use strict';

const assert = require('assert');

process.env.ANTHROPIC_API_KEY = 'test';
process.env.GMAIL_USER = 'owner@thelenches.org.uk';

let answer = '';      // Claude's next reply text
const prompts = [];
const sdkPath = require.resolve('@anthropic-ai/sdk');
class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (req) => {
        prompts.push(req);
        return { content: [{ type: 'text', text: typeof answer === 'function' ? answer(req) : answer }], stop_reason: 'end_turn', usage: {} };
      },
    };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const g = require('./ingest/google');
const fbHeaders = require('./ingest/feedback').HEADERS;
const HEADERS = {
  Replies: ['reply_id', 'message_id', 'thread_id', 'to', 'type', 'status', 'policy_codes', 'subject', 'body',
    'notes', 'created_at', 'sent_at', 'sent_gmail_id', 'decided_at', 'alerted_at', 'class', 'class_confidence', 'hold_reason'],
  Contacts: ['email', 'name', 'organisation', 'village', 'role', 'profile', 'contributions', 'contribution_count',
    'first_contact', 'last_contact', 'message_count', 'status', 'notes', 'profile_source', 'updated_at', 'next_nudge'],
  'Reply feedback': fbHeaders,
};
let tables;
let sent;
let settings;
const pick = (tab, o) => Object.fromEntries(HEADERS[tab].map((h) => [h, o[h] === undefined || o[h] === null ? '' : String(o[h])]));
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings }),
  readTable: async (tab) => tables[tab].map((r, i) => ({ ...r, _row: i + 2 })),
  appendRows: async (tab, objs) => { tables[tab].push(...objs.map((o) => pick(tab, o))); },
  updateRow: async (tab, n, fields) => { Object.assign(tables[tab][n - 2], fields); },
  ensureTab: async () => false,
  sendAsAddresses: async () => ['owner@thelenches.org.uk', 'website@thelenches.org.uk'],
  sendMail: async (m) => { sent.push(m); return `sent-${sent.length}`; },
  getMessage: async (id) => {
    if (id.startsWith('sent-')) return { fromAddress: sent[Number(id.slice(5)) - 1].from || 'owner@thelenches.org.uk' };
    throw new Error(`no message ${id}`);
  },
  getSheetGid: async () => 0,
  spreadsheetId: () => 'sheet',
});

const outreach = require('./outreach');
const replies = require('./ingest/replies');
const { sendReplyCard } = require('./ingest/urgent');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now());
const shift = (days) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const lastYear = (days) => shift(days - 365);

const contact = (email, extra) => ({
  email, name: '', organisation: '', village: '', role: '', profile: '', contributions: '', contribution_count: '0',
  first_contact: shift(-400), last_contact: shift(-200), message_count: '3', status: 'contributor', notes: 'PRIVATE NOTE',
  profile_source: 'auto', updated_at: '', next_nudge: '', ...extra,
});

function reset() {
  tables = {
    Replies: [],
    'Reply feedback': [],
    Contacts: [
      contact('jane@example.org', { name: 'Jane Smith', organisation: 'Lenches Club', role: 'Secretary', status: 'organiser',
        profile: 'Sends quiz-night flyers as PDF.', contributions: `${lastYear(14)} Quiz night (event, approved)`, contribution_count: '1',
        last_contact: lastYear(14) }),
      contact('snoozed@example.org', { name: 'Sam Snooze', next_nudge: shift(30) }),
      contact('quiet@example.org', { name: 'Quinn Quiet', last_contact: shift(-150) }),
    ],
  };
  sent = [];
  settings = { replies_mode: 'live', from_name: 'The Lenches Website and Newsletter Team' };
  prompts.length = 0;
}

const GOOD = JSON.stringify({
  subject: 'Quiz night again this year?',
  draft: "We loved having the Lenches Club quiz night in last year. If there's one planned this year, just reply with the date and details, or a flyer.\n\nhttps://thelenches.org.uk/contact/#submit",
});

async function main() {
  const { idFor } = await import('../worker/src/admin/outreach.mjs');
  const id = (e) => idFor(e);

  // Draft nudge: a seasonal contact.
  reset();
  answer = GOOD;
  const fresh = await outreach.draftNudge(await id('jane@example.org'));
  const row = tables.Replies[0];
  ok(fresh && row.type === 'outreach' && row.status === 'awaiting' && row.to === 'jane@example.org', 'awaiting outreach row');
  ok(row.message_id === '' && row.thread_id === '' && /^out-c[0-9a-f]{16}-\d{12}$/.test(row.reply_id), 'no message or thread; id carries no address');
  ok(row.subject === 'Quiz night again this year?' && row.policy_codes === 'outreach_seasonal', 'subject and kind');
  ok(row.body.startsWith('Hi Jane,\n\n') && row.body.endsWith("If you'd rather we didn't get in touch like this, just say and we won't.\n\nBest wishes,\nHolly\nLenches website assistant"),
    'greeting, opt-out line and Holly sign-off');
  ok(/^Outreach \(seasonal\), as you asked in the panel: Last year: /.test(row.notes), 'note says why');
  const input = JSON.parse(prompts[0].messages[0].content);
  ok(input.reason === 'seasonal' && input.contact.organisation === 'Lenches Club' && input.last_year.title === 'Quiz night', 'Claude sees the contact');
  ok(!JSON.stringify(input).includes('PRIVATE NOTE') && !JSON.stringify(input).includes('@'), 'never Jon\'s notes or the address');
  ok(tables['Reply feedback'].some((r) => r.reply_id === row.reply_id && r.type === 'outreach'), 'logged in Reply feedback');

  // A second tap does nothing: a draft is waiting.
  ok(await outreach.draftNudge(await id('jane@example.org')) === null && tables.Replies.length === 1, 'replayed tap: nothing');

  // Never sent by the end-of-run sender, even in holiday mode.
  await replies.sendDueReplies({ ...settings, holiday_mode: 'TRUE' }, true);
  ok(sent.length === 0 && tables.Replies[0].status === 'awaiting', 'never sent without Jon');

  // Card to Jon.
  await sendReplyCard(row.reply_id, settings, { title: 'Outreach draft', subject: 'Outreach draft ready: x (Lenches)' });
  ok(sent[0].subject === 'Outreach draft ready: x (Lenches)' && sent[0].text.includes('Outreach draft') && sent[0].text.includes('Outreach: a new email from Holly'), 'card');
  sent.length = 0;

  // Redraft keeps the opt-out line once.
  answer = JSON.stringify({ draft: "Is the Lenches Club quiz night happening again this year? Just reply with the details if so.\n\nhttps://thelenches.org.uk/contact/#submit" });
  const re = await replies.redraftReply(row.reply_id, 'shorter please');
  const redraftIn = JSON.parse(prompts[prompts.length - 1].messages[0].content);
  ok(!redraftIn.previous_draft.includes("rather we didn't") && redraftIn.reply_type === 'outreach', 'redraft input without the opt-out');
  ok(re.type === 'outreach' && re.body.split("If you'd rather").length === 2 && re.body.endsWith('Lenches website assistant'), 'redraft keeps opt-out once');

  // Approve: a new thread, no automatic-reply headers.
  await replies.decideReply(re.reply_id, 'send');
  ok(sent.length === 1 && sent[0].to === 'jane@example.org' && sent[0].from === 'website@thelenches.org.uk', 'sent from website@');
  ok(sent[0].threadId === undefined && !sent[0].headers['In-Reply-To'] && !sent[0].headers['Auto-Submitted'], 'new thread, not marked automatic');
  ok(tables.Replies.find((r) => r.reply_id === re.reply_id).status === 'sent', 'row sent');

  // Refused: snoozed, not due, unknown id, weekly cap, shadow mode, bad Claude output.
  ok(await outreach.draftNudge(await id('snoozed@example.org')) === null, 'snoozed: nothing');
  ok(await outreach.draftNudge('c0000000000000000') === null, 'unknown id: nothing');
  reset();
  for (let i = 0; i < 5; i += 1) tables.Replies.push(pick('Replies', { reply_id: `x${i}`, type: 'outreach', to: `p${i}@example.org`, status: 'skipped', created_at: `${today} 09:0${i}` }));
  ok(await outreach.draftNudge(await id('quiet@example.org')) === null && tables.Replies.length === 5, 'weekly cap');
  reset();
  settings.replies_mode = 'shadow';
  answer = GOOD;
  const sh = await outreach.draftNudge(await id('quiet@example.org'));
  ok(sh.status === 'shadow' && JSON.parse(prompts[0].messages[0].content).reason === 'quiet', 'shadow mode: logged only');
  reset();
  answer = JSON.stringify({ subject: 'Hi', draft: 'Email jo@example.com with your news please, thank you.' });
  await assert.rejects(outreach.draftNudge(await id('quiet@example.org')), /failed the checks/);
  ok(tables.Replies.length === 0, 'unusable draft: nothing written');

  console.log(`All outreach tests passed (${checks} checks).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
