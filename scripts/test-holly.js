// scripts/test-holly.js
// Offline test of the 26 Oct Holly fixes: names from sign-offs, no drafts on threads the
// team started by hand ("own" rows: reply in Gmail, then Done), the learning added to every
// draft (approved lessons + recent corrections, never what the sender wrote), and the weekly
// lessons (scripts/lessons: proposed rows, the email's links, Approve / Reject).
// Google, Gmail and Claude are mocked; nothing leaves the machine.
// Run: node scripts/test-holly.js
'use strict';

const assert = require('assert');

process.env.GMAIL_USER = 'owner@thelenches.org.uk';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.WORKER_URL = 'https://w.example';
process.env.APPROVAL_SIGNING_KEY = 'k';

let answer = '';
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
let tables;
let sent;
let messages; // id -> message
let threads;  // threadId -> [ids]
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings: { replies_mode: 'live', reply_sources: 'website', from_name: 'Team' } }),
  readTable: async (tab) => {
    if (!tables[tab]) throw new Error(`Unable to parse range: ${tab}`);
    return tables[tab].map((r, i) => ({ ...r, _row: i + 2 }));
  },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs.map((o) => ({ ...o }))); },
  updateRow: async (tab, n, fields) => { Object.assign(tables[tab][n - 2], fields); },
  ensureTab: async (tab) => { if (tables[tab]) return false; tables[tab] = []; return true; },
  sendAsAddresses: async () => ['owner@thelenches.org.uk', 'website@thelenches.org.uk'],
  sendMail: async (m) => { sent.push(m); return `sent-${sent.length}`; },
  getMessage: async (id) => {
    if (messages[id]) return messages[id];
    if (id.startsWith('sent-')) return { fromAddress: 'website@thelenches.org.uk' };
    throw new Error(`no message ${id}`);
  },
  threadMessageIds: async (t) => threads[t] || [],
  getSheetGid: async () => 0,
  spreadsheetId: () => 'sheet',
});

const replies = require('./ingest/replies');
const lessons = require('./lessons');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

function reset() {
  tables = { Replies: [], 'Reply feedback': [] };
  sent = [];
  messages = {};
  threads = {};
  prompts.length = 0;
}

const ctxFor = () => ({ settings: { replies_mode: 'live', reply_sources: 'website' }, holiday: false, replies: tables.Replies.map((r) => ({ ...r })) });
const inbound = (id, threadId, extra = {}) => ({
  id, threadId, from: 'clerk@example.gov.uk', fromAddress: 'clerk@example.gov.uk', replyTo: '', subject: 'Re: Your feed',
  text: 'Hello\n\nThe host says it is sorted, can you check?\n\nKind regards, Jenny\n\n--\nMrs Jenny Example\nClerk', attachments: [], auto: {}, ...extra,
});

async function main() {
  // 1. Names from sign-offs.
  ok(replies.signOffName('Hello\n\nThanks.\n\nKind regards, Jenny\n\n--\nMrs Jenny Example') === 'Jenny', 'same-line sign-off');
  ok(replies.signOffName('Hi\n\nBest wishes\nTom Smith\n\n> quoted Best wishes, Ann') === 'Tom', 'name on the next line, quoted ignored');
  ok(replies.signOffName('Regards,\nThe Clerk') === '', 'no first name');
  ok(replies.signOffName('Thanks for the update about the bins') === '', '"Thanks for" is not a sign-off name');
  ok(replies.nameFor({ from: '"Sue Brown" <s@example.org>', text: 'Thanks, Bob' }) === 'Sue', 'display name first');
  ok(replies.nameFor({ from: 'clerk@example.gov.uk', text: 'Hello\n\nKind regards, Jenny' }) === 'Jenny', 'sign-off when no display name');

  // 2. A thread started by hand: no draft, an "own" row.
  reset();
  messages.m0 = { id: 'm0', fromAddress: 'website@thelenches.org.uk', auto: {} };
  threads.t1 = ['m0', 'm1'];
  answer = JSON.stringify({ draft: 'should never be asked', answered_from_site: false });
  const own = await replies.planReply({ msg: inbound('m1', 't1'), sourceName: 'website', result: { emailClass: 'other', needsReply: true },
    rows: [], ctx: ctxFor() });
  ok(own && own.type === 'own' && own.status === 'awaiting' && own.body === '', 'own row, no body');
  ok(/Your own thread/.test(own.notes) && /They wrote: "Hello The host says it is sorted, can you check\?"/.test(own.notes), 'note says reply yourself; their words without signature');
  ok(prompts.length === 0, 'Holly drafted nothing');
  await replies.decideReply(own.reply_id, 'send');
  ok(sent.length === 0 && tables.Replies[0].status === 'awaiting', 'Approve sends nothing on an own row');
  await replies.decideReply(own.reply_id, 'skip');
  ok(tables.Replies[0].status === 'skipped', 'Done closes it');

  // Not "own": Holly's own earlier reply, the newsletter, an automatic email.
  for (const [what, m0, extraRow] of [
    ['a Holly reply', { id: 'h0', fromAddress: 'website@thelenches.org.uk', auto: {} }, { reply_id: 'x-ack', thread_id: 'tX', status: 'skipped', sent_gmail_id: 'h0' }],
    ['the newsletter', { id: 'h0', fromAddress: 'website@thelenches.org.uk', auto: { listUnsubscribe: '<mailto:u@x>' } }, null],
    ['an automatic email', { id: 'h0', fromAddress: 'website@thelenches.org.uk', auto: { autoSubmitted: 'auto-replied' } }, null],
  ]) {
    reset();
    messages.h0 = m0;
    threads.t2 = ['h0', 'm2'];
    if (extraRow) tables.Replies.push(extraRow);
    answer = JSON.stringify({ draft: 'Thanks for letting us know, the team will look at it.', answered_from_site: false });
    const r = await replies.planReply({ msg: inbound('m2', 't2'), sourceName: 'website', result: { emailClass: 'question', needsReply: true },
      rows: [], ctx: ctxFor() });
    ok(r && r.type !== 'own', `not own after ${what}`);
  }
  ok(tables.Replies.some((r) => String(r.body).startsWith('Hi Jenny,')), 'greeting uses the sign-off name');

  // 3. Learning: approved lessons and recent corrections go into every draft prompt.
  reset();
  tables['Holly lessons'] = [
    { id: 'L1', lesson: 'Write to council clerks formally and thank them for their help.', status: 'approved' },
    { id: 'L2', lesson: 'A proposed one', status: 'proposed' },
  ];
  tables['Reply feedback'] = [
    { reply_id: 'a1', type: 'answer', outcome: 'edited', they_wrote: 'SECRET SENDER TEXT', draft: 'Hi Ann,\n\nWe can\'t check that.\n\nBest wishes,\nHolly\nLenches website assistant',
      final_text: 'Hi Ann,\n\nWe\'ll check that.\n\nBest wishes,\nHolly\nLenches website assistant', reason: 'never say we cannot check', decided_at: '2026-10-26 10:00' },
    { reply_id: 'a2', type: 'answer', outcome: 'rejected', draft: 'x', reason: '', decided_at: '2026-10-26 11:00' },
    { reply_id: 'a3', type: 'followup', outcome: 'redrafted', draft: 'Hi there,\n\nShort.', reason: 'more formal please', decided_at: '2026-10-25 09:00' },
  ];
  await replies.primeLearning();
  const sys = replies.withVoice('BASE PROMPT');
  ok(sys.startsWith('BASE PROMPT') && sys.includes('Write to council clerks formally') && !sys.includes('A proposed one'), 'approved lessons only');
  ok(sys.includes('never say we cannot check') && sys.includes('"sent_instead":"We\'ll check that."') && sys.includes('more formal please'), 'corrections included');
  ok(!sys.includes('SECRET SENDER TEXT') && !sys.includes('Hi Ann') && !sys.includes('"outcome":"rejected"'), 'never their words, greetings, or reasonless rejections');
  ok(sys.indexOf('never say we cannot check') < sys.indexOf('more formal please'), 'newest first');
  ok(/never say we can't check, see or test something/i.test(require('fs').readFileSync(require('path').join(__dirname, 'replies', 'voice.md'), 'utf8')), 'voice.md rule');

  // 4. Weekly lessons: proposed rows, cleaned, emailed with links; Approve / Reject.
  reset();
  const now = Date.parse('2026-10-26T12:00:00Z');
  tables['Reply feedback'] = [
    { reply_id: 'a1', type: 'answer', outcome: 'edited', draft: 'Hi there,\n\nWe can\'t check.', final_text: 'Hi Jenny,\n\nWe\'ll check.', reason: 'clerk', decided_at: '2026-10-26 10:00' },
    { reply_id: 'old', type: 'answer', outcome: 'edited', draft: 'old', final_text: 'older', reason: '', decided_at: '2026-09-01 10:00' },
  ];
  tables['Holly lessons'] = [{ id: 'L20261026-1', lesson: 'Existing', status: 'rejected' }];
  answer = JSON.stringify({ lessons: [
    { lesson: 'Never tell the sender we cannot check something; say the team will look at it.', evidence: ['a1', 'made-up'] },
    { lesson: 'Email owner@thelenches.org.uk for help.', evidence: ['a1'] },
    { lesson: 'Ask Owner before replying.', evidence: [] },
  ] });
  const rows = await lessons.run({ now });
  const input = JSON.parse(prompts[0].messages[0].content);
  ok(input.corrections.length === 1 && input.corrections[0].reply_id === 'a1' && input.existing[0].status === 'rejected', 'last 7 days only; existing passed');
  ok(rows.length === 1 && rows[0].id === 'L20261026-2' && rows[0].status === 'proposed' && rows[0].evidence === 'a1', 'one clean lesson, next free id, real evidence only');
  ok(sent.length === 1 && /Holly lessons to approve: 1/.test(sent[0].subject) && sent[0].text.includes('Approve: https://w.example/a?t=') && sent[0].html.includes('Reject'), 'email with links');
  const token = sent[0].text.match(/Approve: https:\/\/w\.example\/a\?t=([^.\s]+)\./)[1];
  const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
  ok(payload.i === 'L20261026-2' && payload.a === 'lesson_ok', 'link carries id and lesson_ok');
  await lessons.decide('L20261026-2', 'lesson_ok');
  ok(tables['Holly lessons'][1].status === 'approved' && tables['Holly lessons'][1].decided_at, 'approved');
  await lessons.decide('L20261026-2', 'lesson_no');
  ok(tables['Holly lessons'][1].status === 'approved', 'single use');
  tables['Reply feedback'] = [];
  prompts.length = 0;
  ok((await lessons.run({ now })).length === 0 && prompts.length === 0, 'no corrections: no Claude call');

  console.log(`All Holly tests passed (${checks} checks).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
