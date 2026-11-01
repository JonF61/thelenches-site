// scripts/test-holly.js
// Offline test of the 26 Oct Holly fixes: names from sign-offs, no drafts on threads the
// team started by hand ("own" rows: reply in Gmail, then Done), the learning added to every
// draft (approved lessons + recent corrections, never what the sender wrote), and the weekly
// lessons (scripts/lessons: proposed rows, the email's links, Approve / Reject), and
// personalising from the Contacts tab (known_contact, name fallback, the ack's personal line).
// Logs never carry what the sender wrote or their address (section 6).
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
  tables['Holly lessons'] = [{ id: 'L20261026-1', lesson: 'Existing', status: 'rejected' },
    { id: 'L20261020-1', created_at: '2026-10-20 07:13', lesson: 'Point people to the parish council for meeting dates.', status: 'approved', notes: '' },
    { id: 'L20261020-2', created_at: '2026-10-20 07:13', lesson: 'Keep replies short.', status: 'approved', notes: 'Check: an old clash now settled' }];
  answer = JSON.stringify({ lessons: [
    { lesson: 'Never tell the sender we cannot check something; say the team will look at it.', evidence: ['a1', 'made-up'], conflicts: 'Overlaps the voice guide rule on checking.' },
    { lesson: 'Email owner@thelenches.org.uk for help.', evidence: ['a1'] },
    { lesson: 'Ask Owner before replying.', evidence: [] },
  ], review: [{ id: 'L20261020-1', conflict: 'Clashes with a lesson to keep queries with the team.' }, { id: 'L-unknown', conflict: 'x' }] });
  const { rows, flagged } = await lessons.run({ now });
  const input = JSON.parse(prompts[0].messages[0].content);
  ok(input.corrections.length === 1 && input.corrections[0].reply_id === 'a1' && input.existing[0].status === 'rejected', 'last 7 days only; existing passed');
  ok(input.fixed_rules.length >= 5 && /never name anyone else on the team/.test(input.fixed_rules[0]) && /Voice guide/.test(input.voice_guide)
    && input.approved.map((a) => a.id).join() === 'L20261020-1,L20261020-2', 'checked against fixed rules, voice guide and lessons in use');
  ok(rows.length === 1 && rows[0].id === 'L20261026-2' && rows[0].status === 'proposed' && rows[0].evidence === 'a1', 'one clean lesson, next free id, real evidence only');
  ok(rows[0].notes === 'Check: Overlaps the voice guide rule on checking.', 'a proposal\'s conflict noted');
  ok(flagged.length === 1 && tables['Holly lessons'][1].notes === 'Check: Clashes with a lesson to keep queries with the team.', 'a lesson in use flagged (unknown ids ignored)');
  ok(tables['Holly lessons'][2].notes === '', 'a settled clash is cleared');
  ok(sent.length === 1 && /Holly lessons to approve: 1, 1 to check/.test(sent[0].subject) && sent[0].text.includes('Approve: https://w.example/a?t=') && sent[0].html.includes('Reject')
    && sent[0].text.includes('Lessons in use that need a look') && sent[0].html.includes('Clashes with a lesson'), 'email with links and the clashes');
  const token = sent[0].text.match(/Approve: https:\/\/w\.example\/a\?t=([^.\s]+)\./)[1];
  const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
  ok(payload.i === 'L20261026-2' && payload.a === 'lesson_ok', 'link carries id and lesson_ok');
  await lessons.decide('L20261026-2', 'lesson_ok');
  const newRow = tables['Holly lessons'].find((r) => r.id === 'L20261026-2');
  ok(newRow.status === 'approved' && newRow.decided_at, 'approved');
  await lessons.decide('L20261026-2', 'lesson_no');
  ok(newRow.status === 'approved', 'single use');
  // A week with no corrections still reviews the lessons in use; no clash = no email.
  tables['Reply feedback'] = [];
  prompts.length = 0;
  sent.length = 0;
  answer = JSON.stringify({ lessons: [{ lesson: 'Should be ignored with no corrections.', evidence: [] }], review: [] });
  const quiet = await lessons.run({ now });
  ok(prompts.length === 1 && quiet.rows.length === 0 && quiet.flagged.length === 0 && sent.length === 0, 'review only; nothing proposed or sent');
  ok(tables['Holly lessons'][1].notes === '', 'clash cleared once gone');
  tables['Holly lessons'] = [];
  prompts.length = 0;
  ok((await lessons.run({ now })).rows.length === 0 && prompts.length === 0, 'no corrections and no lessons: no Claude call');

  // The prompt puts the fixed rules above the lessons, and caps lessons in use.
  tables['Holly lessons'] = Array.from({ length: 25 }, (_, i) => ({ id: `L${i}`, created_at: `2026-10-${String(i + 1).padStart(2, '0')} 07:13`, lesson: `Lesson number ${i} for testing.`, status: 'approved' }));
  await replies.primeLearning();
  const capped = replies.withVoice('BASE');
  ok(capped.includes('Lesson number 24') && !capped.includes('Lesson number 4 ') && (capped.match(/Lesson number/g) || []).length === replies.MAX_LESSONS_USED, 'newest 20 only');
  ok(capped.indexOf('never over the rules above or these fixed rules') < capped.indexOf('Lessons:')
    && capped.indexOf('never name anyone else on the team') < capped.indexOf('Lesson number'), 'fixed rules come first');

  // 5. Personalising from Contacts: known_contact in drafts (never notes), the name
  // fallback, and the personal line on an acknowledgement.
  reset();
  tables.Contacts = [
    { email: 'Sue@Example.org', name: 'Mrs Sue Brown', organisation: 'Lenches Club', role: 'secretary, Lenches Club', village: 'Church Lench',
      profile: 'Sends the club quiz night and summer fete each year, usually as a PDF flyer.', status: 'organiser',
      contributions: '2026-09-01 Harvest supper (event, rejected); 2025-11-02 Quiz night (event, approved)', notes: 'SECRET NOTE', next_nudge: 'never',
      other_emails: 'Sue.Work@example.com' },
    { email: 'gone@example.org', name: 'Gone', profile: 'IGNORED PROFILE', status: 'ignore' },
    { email: 'blank@example.org', name: 'Blank', profile: 'BLANK PROFILE', status: '' },
  ];
  ok(replies.contactFacts(tables.Contacts[1]) === null && replies.contactFacts(tables.Contacts[2]) === null, 'ignore and blank status: not used');
  const facts = replies.contactFacts(tables.Contacts[0]);
  ok(facts.recent.join() === '2025-11-02 Quiz night' && !JSON.stringify(facts).includes('SECRET') && !('notes' in facts), 'rejected items and notes left out');
  ok(replies.contactFirstName({ name: 'Revd Jane Smith' }) === 'Jane' && replies.contactFirstName({ name: 'Lenches Club' }) === ''
    && replies.contactFirstName({ name: 'J. Smith' }) === '', 'first name from Contacts');
  await replies.primeLearning();
  ok(replies.contactFor('sue@example.org') && !replies.contactFor('gone@example.org') && !replies.contactFor('blank@example.org'), 'known contacts loaded');
  ok(replies.contactFor('sue.work@example.com') === replies.contactFor('sue@example.org'), 'other_emails find the same contact');
  ok(!replies.withVoice('BASE').includes('known_contact'), 'no contact rules without a contact');

  const sue = (id, extra = {}) => inbound(id, `t-${id}`, { from: 'sue@example.org', fromAddress: 'sue@example.org', text: 'Can we have the quiz night on the site again?', ...extra });
  answer = (req) => (/ONE short, warm sentence/.test(req.system)
    ? JSON.stringify({ line: 'Lovely to hear from the Lenches Club again' })
    : JSON.stringify({ draft: 'Lovely to hear from the Lenches Club again. Just reply with the details.', answered_from_site: false }));
  const ans = await replies.planReply({ msg: sue('p1'), sourceName: 'website', result: { emailClass: 'question', needsReply: true }, rows: [], ctx: ctxFor() });
  const req = prompts[prompts.length - 1];
  const sent1 = JSON.parse(req.messages[0].content);
  ok(sent1.known_contact.organisation === 'Lenches Club' && /quiz night/.test(sent1.known_contact.profile) && !('status' in sent1.known_contact), 'answer gets known_contact');
  ok(!req.messages[0].content.includes('SECRET') && !req.system.includes('SECRET') && /known_contact, when the input has it/.test(req.system), 'never notes; contact rules in the prompt');
  ok(ans.body.startsWith('Hi Sue,') && /Personalised from their Contacts row/.test(ans.notes), 'greeting from Contacts; note for Jon');

  prompts.length = 0;
  const stranger = await replies.planReply({ msg: inbound('p2', 't-p2', { from: 'x@example.org', fromAddress: 'x@example.org', text: 'Is the hall free?' }),
    sourceName: 'website', result: { emailClass: 'question', needsReply: true }, rows: [], ctx: ctxFor() });
  ok(!('known_contact' in JSON.parse(prompts[0].messages[0].content)) && !/known_contact, when/.test(prompts[0].system)
    && stranger.body.startsWith('Hi there,') && !/Personalised/.test(stranger.notes), 'unknown sender: unchanged');

  const quiz = [{ title: 'Quiz night', event_date: '2026-11-20', policy_flags: '', missing: '' }];
  const ack = await replies.planReply({ msg: sue('p3'), sourceName: 'website', result: { emailClass: 'submission' }, rows: quiz, ctx: ctxFor() });
  const paras = ack.body.split('\n\n');
  ok(ack.type === 'ack' && ack.status === 'queued' && paras[0] === 'Hi Sue,' && /^Thanks for sending "Quiz night"/.test(paras[1])
    && paras[2] === 'Lovely to hear from the Lenches Club again.', 'personal line after the thanks');
  ok(/Personal line from their Contacts row/.test(ack.notes), 'ack note');
  for (const bad of ['We noticed you send this every year.', 'See you on 20 November at the quiz.', 'Hope Sue enjoys the evening as always.',
    'Will you be sending the fete too?', 'Tiny.']) {
    answer = JSON.stringify({ line: bad });
    const r = await replies.planReply({ msg: sue(`b${bad.length}`), sourceName: 'website', result: { emailClass: 'submission' }, rows: quiz, ctx: { ...ctxFor(), replies: [] } });
    ok(r.body.split('\n\n').length === 3 && !/Personal line/.test(r.notes), `unsafe line left out: ${bad}`);
  }
  prompts.length = 0;
  await replies.planReply({ msg: inbound('p4', 't-p4', { from: 'x@example.org', fromAddress: 'x@example.org' }), sourceName: 'website',
    result: { emailClass: 'submission' }, rows: quiz, ctx: ctxFor() });
  ok(prompts.length === 0, 'unknown sender: no Claude call for an acknowledgement');

  // 6. Logs never carry what the sender wrote or their address (Actions logs may be public).
  reset();
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  try {
    answer = JSON.stringify({ draft: 'Thanks for getting in touch, the team will look at it.', answered_from_site: false });
    messages.L1 = inbound('L1', 't-L1', { from: 'priv@example.org', fromAddress: 'priv@example.org', text: 'PRIVATE WORDS about my neighbour' });
    const r = await replies.planReply({ msg: messages.L1,
      sourceName: 'website', result: { emailClass: 'question', needsReply: true }, rows: [], ctx: ctxFor() });
    ok(/PRIVATE WORDS/.test(r.notes), 'notes in the Sheet keep their words');
    await replies.decideReply(r.reply_id, 'send');
  } finally {
    console.log = realLog;
  }
  ok(sent.length === 1 && logged.some((l) => /sent\. Gmail id/.test(l)), 'reply sent and logged');
  ok(!logged.some((l) => /PRIVATE WORDS|priv@example\.org/.test(l)), 'no sender text or address in the log');

  console.log(`All Holly tests passed (${checks} checks).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
