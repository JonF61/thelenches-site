// scripts/test-replycheck.js
// Offline test of Rimmer reading Holly's reply drafts (autonomy plan step 2, 15 Nov 2026):
// scripts/rimmer/replycheck.js and its use in scripts/ingest/replies.js. He reads each
// Claude-written draft before it is saved; Holly redrafts once with his findings; the row's
// notes say "Rimmer: …"; a failed check never blocks a draft; fixed wording is not checked;
// the log carries counts only. Google, Gmail and Claude are mocked; nothing leaves the machine.
// Run: node scripts/test-replycheck.js
'use strict';

const assert = require('assert');

process.env.GMAIL_USER = 'owner@thelenches.org.uk';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.WORKER_URL = 'https://w.example';
process.env.APPROVAL_SIGNING_KEY = 'k';
delete process.env.RIMMER_REPLIES;
delete process.env.RIMMER_MODEL;

/* ------------------------------------------------------------ Claude mock -- */

let rimmerSays = null;  // Rimmer's answer (object), a function of the request, or 'throw'
let hollySays = null;   // (req, input) => text
const calls = [];       // { who: 'rimmer' | 'holly', system, input, model }
const sdkPath = require.resolve('@anthropic-ai/sdk');
class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (req) => {
        const system = Array.isArray(req.system) ? req.system.map((b) => b.text).join('') : String(req.system);
        const input = JSON.parse(req.messages[0].content);
        const who = system.startsWith('You are Rimmer') ? 'rimmer' : 'holly';
        calls.push({ who, system, input, model: req.model });
        let text;
        if (who === 'rimmer') {
          if (rimmerSays === 'throw') throw new Error('overloaded');
          text = typeof rimmerSays === 'string' ? rimmerSays : JSON.stringify(typeof rimmerSays === 'function' ? rimmerSays(input) : rimmerSays);
        } else text = hollySays({ system }, input);
        return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} };
      },
    };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

/* ------------------------------------------------------------ Google mock -- */

const g = require('./ingest/google');
let tables;
let messages;
let threads;
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings: { replies_mode: 'live', reply_sources: 'website', from_name: 'Team' } }),
  readTable: async (tab) => {
    if (!tables[tab]) throw new Error(`Unable to parse range: ${tab}`);
    return tables[tab].map((r, i) => ({ ...r, _row: i + 2 }));
  },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs.map((o) => ({ ...o }))); },
  updateRow: async (tab, n, fields) => { Object.assign(tables[tab][n - 2], fields); },
  ensureTab: async (tab) => { if (tables[tab]) return false; tables[tab] = []; return true; },
  getMessage: async (id) => { if (messages[id]) return messages[id]; throw new Error(`no message ${id}`); },
  threadMessageIds: async (t) => threads[t] || [],
  getSheetGid: async () => 0,
  spreadsheetId: () => 'sheet',
});

const replies = require('./ingest/replies');
const replycheck = require('./rimmer/replycheck');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

// Everything printed, to check the log carries no email text.
const logged = [];
for (const k of ['log', 'warn']) {
  const real = console[k];
  console[k] = (...a) => { logged.push(a.join(' ')); real(...a); };
}

function reset() {
  tables = { Replies: [], 'Reply feedback': [], Pending: [], Subscribers: [], 'Do Not Send': [] };
  messages = {};
  threads = {};
  calls.length = 0;
}
const ctxFor = (existing = []) => ({ settings: { replies_mode: 'live', reply_sources: 'website' }, holiday: false, existing,
  replies: tables.Replies.map((r) => ({ ...r })) });
const inbound = (id, extra = {}) => {
  const m = { id, threadId: `t-${id}`, from: 'Sam Carter <hall@example.org>', fromAddress: 'hall@example.org', replyTo: '',
    subject: 'Quiz night', text: 'Hello\n\nIs the SECRETWORD quiz still on at the hall on Friday?\n\nMany thanks\nNadine\nBookings secretary', attachments: [], auto: {}, ...extra };
  messages[id] = m;
  return m;
};
const rimmerCalls = () => calls.filter((c) => c.who === 'rimmer');
const hollyCalls = () => calls.filter((c) => c.who === 'holly');
const question = { emailClass: 'question', classConfidence: 0.9, needsReply: true };
const answerOf = (first, second) => (req, input) => JSON.stringify({ draft: input.reviewer_findings ? second : first, answered_from_site: false });

async function main() {
  // 1. The module on its own.
  ok(replycheck.CODES.join() === 'asked_given,wrong_name,live_state,already_done,contradicts,not_answered', 'the fixed checklist');
  ok(replycheck.CODES.every((c) => replycheck.SYSTEM.includes(`- ${c}: `)), 'every code is in his prompt');
  ok(replycheck.parseAnswer('not json') === null && replycheck.parseAnswer('{"needs_human":true}') === null, 'an unusable answer is a failed check');
  const parsed = replycheck.parseAnswer(JSON.stringify({ problems: [{ code: 'style', problem: 'too long' }, { code: 'wrong_name', problem: 'She signs | as Nadine' }], signed_name: 'Nadine', nothing_to_ask: true }));
  ok(parsed.problems.length === 1 && parsed.problems[0].problem === 'She signs / as Nadine', 'unknown codes dropped; no pipe in a note');
  ok(parsed.signedName === 'Nadine' && parsed.nothingToAsk === false, 'nothing_to_ask only with asked_given');
  ok(replycheck.noteFor([{ problem: 'A.' }], 'Holly redrafted') === 'Rimmer: 1 problem, Holly redrafted: A.', 'note for one');
  ok(/^Rimmer: 2 problems, Holly redrafted: \(1\) A\.; \(2\) B\.$/.test(replycheck.noteFor([{ problem: 'A.' }, { problem: 'B.' }], 'Holly redrafted')), 'note for two');
  ok(await replycheck.checkReply({ draft: 'x' }, {}) === null, 'no client: no check');
  ok(replies.signedNameIn('Nadine', 'Thanks\nNadine') === 'Nadine' && replies.signedNameIn('Nadia', 'Thanks\nNadine') === ''
    && replies.signedNameIn('Team', 'The Team') === '' && replies.signedNameIn('nadine smith', 'nadine smith') === '', 'a greeting name must be a first name written in their email');

  // 2. An answer he faults: Holly redrafts once; the note says so; he is not asked again.
  reset();
  threads['t-a1'] = ['a0', 'a1'];
  messages.a0 = { id: 'a0', fromAddress: 'hall@example.org', text: 'We sent the quiz poster last week.', auto: {} };
  hollySays = answerOf('We would love to hear about your events. Do send them in.', 'We do not have the quiz on the website, so the hall is the best place to ask.');
  rimmerSays = { problems: [{ code: 'not_answered', problem: 'She asked whether the quiz is still on; the draft only invites her to send events.', quote: 'Do send them in' }] };
  const a1 = await replies.planReply({ msg: inbound('a1'), sourceName: 'website', result: question, rows: [], ctx: ctxFor() });
  ok(rimmerCalls().length === 1 && hollyCalls().length === 2, 'one reading, one redraft');
  ok(/the hall is the best place to ask/.test(a1.body) && !/Do send them in/.test(a1.body), 'the redraft is what waits for Jon');
  ok(/Rimmer: 1 problem, Holly redrafted: She asked whether the quiz is still on/.test(a1.notes), 'note for Jon');
  ok(a1.status === 'awaiting' && a1.type === 'answer', 'still waits for his tap');
  const read = rimmerCalls()[0];
  ok(read.model === 'claude-opus-5-5', 'Opus by default');
  ok(read.input.draft.startsWith('Hi ') && /Holly\nLenches website assistant/.test(read.input.draft), 'he reads the whole reply, greeting and sign-off');
  ok(/Many thanks\nNadine\nBookings secretary/.test(read.input.their_email.text), 'their email with its signature');
  ok(read.input.thread.length === 1 && read.input.thread[0].from === 'them' && /quiz poster/.test(read.input.thread[0].text), 'the earlier thread');
  const again = hollyCalls()[1];
  ok(again.input.reviewer_findings.length === 1 && /in the draft: "Do send them in"/.test(again.input.reviewer_findings[0]) && /love to hear/.test(again.input.previous_draft), 'Holly gets his findings and her first draft');
  ok(/reviewer_findings, when the input has it/.test(again.system) && /Every rule above still applies in full/.test(again.system), 'review rules in her prompt');
  ok(again.system.indexOf('Facts only from site_facts') < again.system.indexOf('reviewer_findings, when the input has it'), 'her rules come first');
  ok(!/reviewer_findings/.test(hollyCalls()[0].system), 'no review rules on a first draft');

  // 3. Nothing found, a failed check, and the check switched off: the draft as written.
  for (const [what, says, off] of [['no problems', { problems: [] }, false], ['an API error', 'throw', false], ['a garbled answer', 'sorry, I cannot', false], ['switched off', { problems: [] }, true]]) {
    reset();
    if (off) process.env.RIMMER_REPLIES = 'off';
    rimmerSays = says;
    const r = await replies.planReply({ msg: inbound('n1'), sourceName: 'website', result: question, rows: [], ctx: ctxFor() });
    delete process.env.RIMMER_REPLIES;
    ok(/Do send them in/.test(r.body) && !/Rimmer/.test(r.notes) && hollyCalls().length === 1, `${what}: first draft kept, no note, no redraft`);
    ok(rimmerCalls().length === (off ? 0 : 1), `${what}: ${off ? 'he is not asked' : 'he was asked once'}`);
  }

  // 4. The wrong name: the greeting is corrected from their sign-off, with no redraft.
  reset();
  rimmerSays = { problems: [{ code: 'wrong_name', problem: 'The greeting says Sam but she signs as Nadine.', quote: 'Hi Sam,' }], signed_name: 'Nadine' };
  const w1 = await replies.planReply({ msg: inbound('w1'), sourceName: 'website', result: question, rows: [], ctx: ctxFor() });
  ok(w1.body.startsWith('Hi Nadine,') && hollyCalls().length === 1, 'greeting swapped, text untouched');
  ok(/Rimmer: 1 problem, greeting corrected: /.test(w1.notes), 'note says the greeting was corrected');
  reset();
  rimmerSays = { problems: [{ code: 'wrong_name', problem: 'She signs as Zelda.', quote: 'Hi Sam,' }], signed_name: 'Zelda' };
  const w2 = await replies.planReply({ msg: inbound('w2'), sourceName: 'website', result: question, rows: [], ctx: ctxFor() });
  ok(w2.body.startsWith('Hi Sam,') && /Rimmer: 1 problem, left for you to check: /.test(w2.notes), 'a name not written in their email is never used');

  // 5. A question already answered: plain thanks instead; otherwise the paragraph is redrafted.
  const eventRow = (id, extra = {}) => ({ id: `p-${id}`, message_id: id, title: 'Quiz night — Village Hall', category: 'event', event_date: '', village: 'Church Lench', missing: 'date', status: 'pending', policy_flags: '', ...extra });
  const submission = { emailClass: 'submission', classConfidence: 0.95, items: [] };
  reset();
  hollySays = (req, input) => (input.reviewer_findings ? 'Could you let us know which Friday the quiz is on?' : 'Could you let us know the date of the quiz night?');
  rimmerSays = { problems: [{ code: 'asked_given', problem: 'She gave the date in her email.', quote: 'the date of the quiz night' }], nothing_to_ask: true };
  const c1 = await replies.planReply({ msg: inbound('c1'), sourceName: 'website', result: submission, rows: [eventRow('c1')], ctx: ctxFor() });
  ok(c1.type === 'ack' && c1.reply_id === 'c1-ack' && !/Could you let us know/.test(c1.body) && /Quiz night/.test(c1.body), 'nothing left to ask: a plain thank-you');
  ok(/Rimmer: 1 problem, question dropped, plain thanks instead: /.test(c1.notes) && hollyCalls().length === 1, 'note; no redraft needed');
  ok(rimmerCalls()[0].input.items[0].still_missing.join() === 'the date' || rimmerCalls()[0].input.items[0].still_missing.length === 1, 'he sees what the team holds');
  reset();
  rimmerSays = { problems: [{ code: 'asked_given', problem: 'She said it is on a Friday.', quote: 'the date' }], nothing_to_ask: false };
  const c2 = await replies.planReply({ msg: inbound('c2'), sourceName: 'website', result: submission, rows: [eventRow('c2')], ctx: ctxFor() });
  ok(c2.type === 'clarify' && /which Friday the quiz is on/.test(c2.body) && /Rimmer: 1 problem, Holly redrafted: /.test(c2.notes), 'the question is redrafted once');
  ok(hollyCalls().length === 2 && hollyCalls()[1].input.reviewer_findings.length === 1, 'with his findings');

  // 6. Fixed wording is never read: a plain acknowledgement, a holding reply.
  reset();
  rimmerSays = { problems: [{ code: 'contradicts', problem: 'x', quote: 'y' }] };
  const k1 = await replies.planReply({ msg: inbound('k1'), sourceName: 'website', result: submission, rows: [eventRow('k1', { event_date: '2026-12-04', missing: '' })], ctx: ctxFor() });
  ok(k1.type === 'ack' && calls.length === 0 && !/Rimmer/.test(k1.notes), 'a plain acknowledgement is not checked');

  // 7. A live entry: he is given its link and the row's cells.
  const dup = JSON.stringify({ key: 'h:events/none.json', title: 'Quiz night — Village Hall', url: 'https://thelenches.org.uk/events/#ev-quiz', source: 'hand-written', confidence: 0.95, sure: true, details: '' });
  const items = replies.rimmerItems([eventRow('x', { duplicate: dup, event_date: '2026-12-04', event_time: '7.30pm', cost: '£5' })], []);
  ok(items[0].live && items[0].live.url === 'https://thelenches.org.uk/events/#ev-quiz' && items[0].date === '2026-12-04' && items[0].cost === '£5', 'items carry the live entry');
  ok(replies.rimmerItems([eventRow('y')], [])[0].live === undefined, 'no live entry when not listed');

  // 8. A follow-up draft.
  reset();
  tables.Replies.push({ reply_id: 'f0-clarify', message_id: 'f0', thread_id: 't-f1', to: 'hall@example.org', type: 'clarify', status: 'sent', body: 'Hi Nadine,\n\nCould you let us know the date?', sent_gmail_id: 'sent-1' });
  hollySays = (req, input) => JSON.stringify({ needs_human: true, reason: 'asks about the poster', draft: input.reviewer_findings ? 'Thanks, the poster is with the listing already.' : 'Thanks, we will look into adding the poster.' });
  rimmerSays = { problems: [{ code: 'already_done', problem: 'The poster is already on the entry.', quote: 'look into adding the poster' }] };
  const fctx = ctxFor([eventRow('f0', { event_date: '2026-12-04', missing: '', status: 'approved' })]);
  const f1 = await replies.planFollowup({ msg: inbound('f1', { text: 'Did the SECRETWORD poster arrive?\n\nThanks\nNadine' }), reply: fctx.replies[0], ctx: fctx, added: [], result: { emailClass: 'question', classConfidence: 0.9 } });
  const frow = tables.Replies.find((r) => r.reply_id === 'f1-followup');
  ok(f1.flagged && /poster is with the listing already/.test(frow.body) && /Rimmer: 1 problem, Holly redrafted: The poster is already on the entry\./.test(frow.notes), 'follow-up redrafted with the note');
  ok(rimmerCalls()[0].input.reply_type === 'followup' && rimmerCalls()[0].input.items[0].status === 'approved', 'he sees the original items');

  // 9. Jon's Redraft: read too; Holly rewrites once more; the instruction stays in her prompt.
  reset();
  inbound('r1');
  tables.Replies.push({ reply_id: 'r1-answer', message_id: 'r1', thread_id: 't-r1', to: 'hall@example.org', type: 'answer', class: 'question', status: 'awaiting', subject: 'Re: Quiz night', body: 'Hi Hall,\n\nOld draft.\n\nBest wishes,\nHolly\nLenches website assistant', notes: '' });
  hollySays = (req, input) => JSON.stringify({ draft: input.reviewer_findings ? 'The quiz is on the Events page already.' : 'We will add the quiz to the website.' });
  rimmerSays = { problems: [{ code: 'live_state', problem: 'The quiz is already on the website.', quote: 'We will add the quiz' }, { code: 'wrong_name', problem: 'She signs as Nadine.', quote: 'Hi Sam,' }], signed_name: 'Nadine' };
  const fresh = await replies.redraftReply('r1-answer', 'Tell her about the quiz');
  ok(fresh.body.startsWith('Hi Nadine,') && /on the Events page already/.test(fresh.body), 'redraft corrected');
  ok(/Redraft of r1-answer/.test(fresh.notes) && /Rimmer: 2 problems, Holly redrafted: \(1\) /.test(fresh.notes), 'both notes');
  ok(hollyCalls()[1].input.instruction === 'Tell her about the quiz' && hollyCalls()[1].input.reviewer_findings.length === 1, 'instruction kept; only text findings sent');
  reset();
  inbound('r2');
  tables.Replies.push({ reply_id: 'r2-answer', message_id: 'r2', thread_id: 't-r2', to: 'hall@example.org', type: 'answer', class: 'question', status: 'awaiting', subject: 'Re: Quiz night', body: 'Hi Hall,\n\nOld draft.\n\nBest wishes,\nHolly\nLenches website assistant', notes: '' });
  rimmerSays = 'throw';
  const fresh2 = await replies.redraftReply('r2-answer', 'Tell her about the quiz');
  ok(/We will add the quiz/.test(fresh2.body) && !/Rimmer/.test(fresh2.notes), 'his failure never blocks a redraft');

  // 10. The log: counts and outcomes only, never his words or theirs.
  const all = logged.join('\n');
  ok(/Rimmer read the answer draft: 1 problem\(s\)\./.test(all) && /Rimmer: answer draft not checked/.test(all), 'counts are logged');
  ok(/\(.*Rimmer: 1 problem, Holly redrafted(\)| \|)/.test(all), 'the reply line keeps only count and outcome');
  ok(!/SECRETWORD|She asked whether|already on the entry|signs as Nadine|Do send them in/.test(all), 'no email text or findings in the log');

  console.log(`All reply-check tests passed (${checks} checks).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
