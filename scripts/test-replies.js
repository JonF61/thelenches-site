// Offline test for classified replies (scripts/ingest/replies.js and friends, 23 Oct).
// Runs every case in scripts/replies/fixtures.json in normal and holiday mode, then the
// send, Approve, Reject (with reason), Edit, sorry-note and Reply feedback paths, and
// renders the action email. Part 2: first-name greetings, automatic subscribe and
// unsubscribe, the Worker edit-form link, and the holiday log / welcome-back digest. No secrets and no network: Google and Claude are mocked.
// Usage: node scripts/test-replies.js [preview-dir]   (writes action-email.html there)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.ANTHROPIC_API_KEY = 'test';
process.env.GMAIL_USER = 'owner@thelenches.org.uk';
process.env.WORKER_URL = 'https://worker.example';
process.env.APPROVAL_SIGNING_KEY = 'test-key';

/* ------------------------------------------------------------ Claude mock -- */

let draftFor = null;    // current case's mocked answer draft
let extractInput = null; // current extract() tool input
const sdkPath = require.resolve('@anthropic-ai/sdk');
class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (req) => {
        const system = Array.isArray(req.system) ? req.system.map((b) => b.text).join('') : String(req.system);
        let text;
        if (req.tools) {
          return { content: [{ type: 'tool_use', name: 'record_items', input: extractInput }], stop_reason: 'tool_use', usage: {} };
        }
        if (system.startsWith('You draft replies')) text = JSON.stringify(draftFor || { draft: '', answered_from_site: false });
        else if (system.includes('asking someone who sent in an item')) text = 'Could you let us know the date and time of the coffee morning?';
        else text = JSON.stringify({ needs_human: true, reason: 'asks a question', draft: 'Thanks for the update, we will look into it.' });
        return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} };
      },
    };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

/* ------------------------------------------------------------ Google mock -- */

const g = require('./ingest/google');
const HEADERS = {
  Replies: ['reply_id', 'message_id', 'thread_id', 'to', 'type', 'status', 'policy_codes', 'subject', 'body',
    'notes', 'created_at', 'sent_at', 'sent_gmail_id', 'decided_at', 'alerted_at', 'class', 'class_confidence', 'hold_reason'],
  Pending: ['id', 'message_id', 'from', 'title', 'event_date', 'status', 'policy_flags', 'missing', 'received', 'urgent',
    'alerted_at', 'gmail_link'],
  Subscribers: ['email', 'status', 'source', 'date', 'notes'],
  'Do Not Send': ['email', 'reason', 'source', 'date', 'added_at', 'notes'],
};
let tables;
let sent;
let settings;
const reset = () => {
  tables = { Replies: [], Pending: [], Subscribers: [], 'Do Not Send': [{ email: 'blocked@example.com', reason: 'unsubscribe link' }] };
  sent = [];
};
const headersOf = (tab) => HEADERS[tab] || { 'Reply feedback': require('./ingest/feedback').HEADERS,
  'Holiday log': require('./ingest/welcome').HEADERS }[tab] || [];
const pick = (tab, o) => Object.fromEntries(headersOf(tab).map((h) => [h, o[h] === undefined || o[h] === null ? '' : String(o[h])]));
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings }),
  readTable: async (tab) => {
    if (!tables[tab]) throw new Error(`no tab ${tab}`);
    return tables[tab].map((r, i) => ({ ...r, _row: i + 2 }));
  },
  appendRows: async (tab, objs) => { tables[tab].push(...objs.map((o) => pick(tab, o))); },
  updateRow: async (tab, rowNumber, fields) => {
    const row = tables[tab][rowNumber - 2];
    for (const [k, v] of Object.entries(fields)) if (headersOf(tab).includes(k)) row[k] = String(v ?? '');
  },
  ensureTab: async (tab) => { if (tables[tab]) return false; tables[tab] = []; return true; },
  sendAsAddresses: async () => ['owner@thelenches.org.uk', 'website@thelenches.org.uk'],
  sendMail: async (m) => { sent.push(m); return `sent-${sent.length}`; },
  getMessage: async (id) => (id.startsWith('sent-')
    ? { fromAddress: sent[Number(id.slice(5)) - 1].from || 'owner@thelenches.org.uk' }
    : { rfcMessageId: `<${id}@mail>`, references: '' }),
  getSheetGid: async () => 0,
  spreadsheetId: () => 'sheet',
});

const replies = require('./ingest/replies');
const edits = require('./ingest/edits');
const { extract } = require('./ingest/extract');
const { normaliseClass, holdReasonFor } = require('./ingest/classify');
const { sendUrgentAlerts } = require('./ingest/urgent');
const { editFormLink } = require('./ingest/links');
const welcome = require('./ingest/welcome');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'replies', 'fixtures.json'), 'utf8')).cases;
const LIVE = { replies_mode: 'live', reply_sources: 'website', reply_max_per_sender: '3', reply_max_per_run: '50' };
const hoursAgo = (h) => {
  const d = new Date(Date.now() - h * 3600000);
  const f = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...o }).format(d);
  return `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d)} ${f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
};

function message(c, n) {
  return {
    id: `m${n}`, threadId: `t${n}`, subject: c.msg.subject, text: c.msg.text, from: c.msg.from,
    fromAddress: g.addressOf(c.msg.from), replyTo: '', attachments: [], auto: c.msg.auto || {},
  };
}

async function plan(c, n, holiday, ctx) {
  draftFor = c.claude || null;
  const msg = message(c, n);
  const rows = (c.rows || []).map((r, i) => ({ ...r, id: `${msg.id}-${i + 1}`, message_id: msg.id, from: msg.from }));
  rows.forEach((r) => tables.Pending.push(pick('Pending', { ...r, status: 'pending' })));
  ctx.existing.push(...rows);
  const before = ctx.replies.length;
  await replies.planReply({ msg, sourceName: 'website', result: { ...c.result, anonymous: false, outOfScope: false }, rows, ctx });
  return ctx.replies.slice(before);
}

let checks = 0;
let welcomeMail = null; // saved with the previews
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

async function testClassify() {
  const n = normaliseClass({ email_class: 'Question', class_confidence: 2, hold_reason: 'bogus', needs_reply: false });
  ok(n.emailClass === 'question' && n.classConfidence === 1 && n.holdReason === 'none' && n.needsReply === false, 'normaliseClass');
  ok(normaliseClass({ email_class: 'banana', class_confidence: 0.9 }).classConfidence === 0, 'unknown class has confidence 0');
  ok(holdReasonFor('submission', 'none', 'Under GDPR, children welcome, sponsored walk') === '', 'no keyword holds on submissions');
  ok(holdReasonFor('question', 'none', 'Can I speak to a journalist?') === 'legal_press', 'press keyword');
  ok(holdReasonFor('complaint', 'none', '') === 'complaint', 'complaints always held');

  const names = {
    'Sam Smith <sam@example.com>': 'Sam', '"SMITH, ANNE" <a@example.com>': 'Anne', 'jo <jo@example.com>': '',
    'Church Lench Parish Council <clerk@example.com>': '', 'Mrs Jones <j@example.com>': '', 'info <info@example.com>': '',
    'sam@example.com': '', 'Friends of the Hall <f@example.com>': '', 'mary-jane <mj@example.com>': '', 'Lee <lee@example.com>': 'Lee', 'Mary-Jane Hill <mj@example.com>': 'Mary-Jane',
  };
  for (const [from, want] of Object.entries(names)) ok(replies.firstName(from) === want, `firstName(${from}) = "${want}"`);

  extractInput = { items: [], anonymous: false, out_of_scope: false, email_class: 'unsubscribe', class_confidence: 0.9, hold_reason: 'none', needs_reply: true, request: 'leave the list' };
  const r = await extract({ msg: { text: 'Please unsubscribe me', from: 'a@b.c', subject: 'Unsubscribe' }, sourceName: 'website', receivedIso: '2026-10-23 10:00', today: '2026-10-23', images: [], pdfs: [] });
  ok(r.emailClass === 'unsubscribe' && r.classConfidence === 0.9 && r.request === 'leave the list', 'extract passes the class through');
}

async function testRouting() {
  for (const holiday of [false, true]) {
    reset();
    settings = LIVE;
    const ctx = { settings, holiday, replies: [], existing: [] };
    let n = 0;
    for (const c of fixtures) {
      n += 1;
      const got = (await plan(c, `${holiday ? 'h' : 'n'}${n}`, holiday, ctx)).map((r) => [r.type, r.status]);
      assert.deepStrictEqual(got, c.expect[holiday ? 'holiday' : 'normal'], `${c.name} (${holiday ? 'holiday' : 'normal'})`);
      checks += 1;
    }
    for (const r of tables.Replies) {
      ok(r.class !== '', `class logged on ${r.reply_id}`);
      if (r.status === 'skipped') continue;
      ok(/^Hi [A-Za-z-]+,\n/.test(r.body) && r.body.endsWith('Lenches website assistant'), `greeting and sign-off on ${r.reply_id}`);
      ok(!/owner/i.test(r.body), `no team name in ${r.reply_id}`);
    }
    const answer = tables.Replies.find((r) => r.reply_id.endsWith('-answer') && r.body.includes('/bins/'));
    ok(answer && answer.body.startsWith('Hi Lee,'), 'factual answer keeps its page link, first-name greeting');
    ok(tables.Subscribers.map((r) => r.email).join() === 'ali@example.com', 'subscribe: sender added to Subscribers');
    ok(tables['Do Not Send'].map((r) => r.email).join() === 'blocked@example.com,kim@example.com', 'unsubscribe: sender added to Do Not Send');
    ok(tables.Replies.find((r) => r.type === 'list' && r.to === 'ali@example.com').body.includes("you're now on the list"), 'subscribe confirmed');
    const outside = tables.Replies.find((r) => r.notes.includes('Is there a bus'));
    ok(outside && !outside.body.includes('example-buses'), 'outside link never kept');
    ok(tables['Reply feedback'].length === tables.Replies.filter((r) => ['clarify', 'answer', 'whattodo', 'held'].includes(r.type)).length,
      'every draft logged in Reply feedback');
  }

  // One automatic reply per thread, and the per-sender limit.
  reset();
  const ctx = { settings: LIVE, holiday: true, replies: [], existing: [] };
  const q = fixtures.find((c) => c.name === 'question answered from the site');
  await plan(q, 'x1', true, ctx);
  const again = await replies.planReply({ msg: { ...message(q, 'x2'), threadId: 'tx1' }, sourceName: 'website', result: q.result, rows: [], ctx });
  ok(again.status === 'skipped' && /Already replied/.test(again.notes), 'one reply per thread');
  await plan(q, 'x3', true, ctx);
  await plan(q, 'x4', true, ctx);
  const [over] = await plan(q, 'x5', true, ctx);
  ok(over.status === 'awaiting' && over.policy_codes.includes('sender_limit'), 'over the sender limit: held for Jon, even in holiday mode');
  const ack = fixtures.find((c) => c.name === 'clean submission');
  const [dropped] = await plan({ ...ack, msg: { ...ack.msg, from: q.msg.from } }, 'x6', true, ctx);
  ok(dropped.status === 'skipped', 'over the sender limit: acknowledgement dropped');

  // Shadow mode never queues anything.
  reset();
  const sctx = { settings: { ...LIVE, replies_mode: 'shadow' }, holiday: true, replies: [], existing: [] };
  for (const [i, c] of fixtures.entries()) await plan(c, `s${i}`, true, sctx);
  ok(sctx.replies.every((r) => ['shadow', 'skipped'].includes(r.status)), 'shadow mode only drafts');
  ok(!tables.Subscribers.length && tables['Do Not Send'].length === 1, 'shadow mode never changes the lists');

  // Already subscribed: nothing added, "already" reply.
  reset();
  tables.Subscribers.push({ email: 'ali@example.com', status: 'active' });
  const sub = fixtures.find((c) => c.name === 'subscribe');
  const [already] = await plan(sub, 'y1', false, { settings: LIVE, holiday: false, replies: [], existing: [] });
  ok(already.type === 'list' && already.policy_codes === 'list:already' && tables.Subscribers.length === 1, 'already subscribed');
}

async function testSending() {
  reset();
  settings = LIVE;
  const ctx = { settings, holiday: false, replies: [], existing: [] };
  for (const [i, c] of fixtures.entries()) await plan(c, `p${i}`, false, ctx);
  const clarify = tables.Replies.find((r) => r.type === 'clarify');
  clarify.created_at = hoursAgo(25);

  await replies.sendDueReplies(settings, false);
  const byType = (t) => tables.Replies.filter((r) => r.type === t);
  ok(byType('ack').every((r) => r.status === 'sent'), 'acks sent');
  ok(byType('holding').every((r) => r.status === 'sent'), 'holding replies sent');
  ok(clarify.status === 'sent' && !sent.find((m) => m.to === clarify.to).text.includes('Could you let us know'), 'clarification sent without the question after 24h');
  ok(byType('answer').every((r) => r.status === 'awaiting') && byType('held').every((r) => r.status === 'awaiting'),
    'normal mode: answers and held drafts wait for Jon');
  ok(sent.every((m) => m.from === 'website@thelenches.org.uk'), 'all replies from website@');
  const fb = () => tables['Reply feedback'];
  ok(fb().find((r) => r.reply_id === clarify.reply_id).outcome === 'timed_out', 'feedback: timed_out');

  const [a1, a2, a3, a4] = byType('answer');
  await replies.decideReply(a1.reply_id, 'send');
  ok(a1.status === 'sent' && fb().find((r) => r.reply_id === a1.reply_id).outcome === 'approved', 'Approve sends; feedback approved');
  a2.body = a2.body.replace('Thanks', 'Many thanks');
  await replies.decideReply(a2.reply_id, 'send');
  ok(fb().find((r) => r.reply_id === a2.reply_id).outcome === 'edited', 'body edited in the Sheet: feedback edited');
  await replies.decideReply(a3.reply_id, 'skip', 'too formal');
  const f3 = fb().find((r) => r.reply_id === a3.reply_id);
  ok(a3.status === 'skipped' && f3.outcome === 'rejected' && f3.reason === 'too formal', 'Reject with reason');

  const { body, reason } = edits.parseEdit(`Reason: friendlier\n\nHi there,\n\nShort and sweet.\n\nThanks again,\nHolly\n\n${edits.MARKER}\nignored\n`);
  ok(reason === 'friendlier' && body.startsWith('Hi there,') && !body.includes('ignored'), 'parseEdit');
  await replies.applyEdit(a4.reply_id, body, reason);
  const f4 = fb().find((r) => r.reply_id === a4.reply_id);
  ok(a4.status === 'sent' && f4.outcome === 'edited' && f4.final_text === body && f4.reason === 'friendlier', 'Edit email sends the edited text');
  ok(!(await replies.applyEdit(a4.reply_id, 'again')), 'Edit is single use');

  const held = byType('held')[0];
  await assert.rejects(replies.applyEdit(held.reply_id, 'Hi there,\n\nBest wishes, Owner\n'), /failed to send/);
  ok(held.status === 'failed' && /anonymity/.test(held.notes), 'never sends a reply naming the team');
  checks += 1;

  // Sorry note when Jon rejects an acknowledged item.
  const ackRow = byType('ack')[0];
  const item = (await g.readTable('Pending')).find((r) => r.message_id === ackRow.message_id);
  const sorry = await replies.planSorry(item);
  ok(sorry && sorry.status === 'awaiting' && sorry.body.includes(`"${item.title}"`) && /couldn't use it after all/.test(sorry.body), 'sorry note drafted for Jon');
  ok(!(await replies.planSorry(item)), 'sorry note only once');

  // Holiday mode: Holly sends answers and what-to-do replies herself; held drafts still wait.
  reset();
  const hctx = { settings, holiday: true, replies: [], existing: [] };
  for (const [i, c] of fixtures.entries()) await plan(c, `q${i}`, true, hctx);
  await replies.sendDueReplies(settings, true);
  ok(byType('whattodo').every((r) => r.status === 'sent') && byType('answer').filter((r) => r.status === 'sent').length === 2
    && byType('list').every((r) => r.status === 'sent'), 'holiday mode: confident answers, list confirmations and what-to-do replies sent');
  ok(byType('held').every((r) => r.status === 'awaiting'), 'holiday mode: held drafts still wait');
  ok(byType('answer').filter((r) => r.status === 'awaiting').length === 3, 'holiday mode: drafts that failed a check, and refused list requests, wait');
  ok(fb().filter((r) => r.outcome === 'auto_sent').length === 5, 'feedback: auto_sent (clarify, 2 answers, 2 what-to-do)');

  // Welcome back: everything Holly sent in holiday mode, once, after holiday mode goes off.
  const holidaySent = tables.Replies.filter((r) => r.status === 'sent').length;
  ok(tables['Holiday log'].length === holidaySent, `holiday log has every holiday send (${holidaySent})`);
  sent = [];
  ok(await welcome.sendWelcomeBack(settings) === holidaySent, 'welcome-back digest covers them all');
  ok(/^Welcome back: \d+ replies sent while you were away/.test(sent[0].subject) && sent[0].html.includes('waiting for your decision'), 'welcome-back email');
  [welcomeMail] = sent;
  ok(await welcome.sendWelcomeBack(settings) === 0, 'welcome-back digest only once');

  // A sender who shares the team's first name still gets "Hi <name>,".
  reset();
  const owner = { ...fixtures[0], msg: { ...fixtures[0].msg, from: 'Owner Smith <os@example.com>' } };
  await plan(owner, 'o1', false, { settings, holiday: false, replies: [], existing: [] });
  await replies.sendDueReplies(settings, false);
  ok(tables.Replies[0].status === 'sent' && tables.Replies[0].body.startsWith('Hi Owner,'), 'greeting with the team name is allowed');
}

async function testActionEmail(previewDir) {
  reset();
  settings = LIVE;
  const ctx = { settings, holiday: false, replies: [], existing: [] };
  for (const [i, c] of fixtures.entries()) await plan(c, `e${i}`, false, ctx);
  await sendUrgentAlerts(settings, false);
  const mail = sent[0];
  ok(mail && /held for you/i.test(mail.subject), `action email subject (${mail && mail.subject})`);
  ok(mail.html.includes('>Approve<') && mail.html.includes('>Edit<') && mail.html.includes('>Reject<'), 'Approve / Edit / Reject buttons');
  ok(mail.html.includes('Held for you') && mail.text.includes('Class: complaint (0.9)'), 'held section and class shown');
  ok(mail.text.includes('mailto:owner%40thelenches.org.uk?subject=%5BEdit%20reply%20'), 'Edit by email link');
  ok(mail.html.includes('https://worker.example/a?t='), 'Edit form link');
  const awaiting = tables.Replies.find((r) => r.status === 'awaiting');
  const link = editFormLink(awaiting);
  const payload = JSON.parse(Buffer.from(link.split('t=')[1].split('.')[0], 'base64url').toString());
  ok(link.length <= 2000 && payload.a === 'edit' && payload.b === awaiting.body, 'edit form link carries the draft');
  ok(editFormLink({ ...awaiting, body: 'x'.repeat(1600) }) === '', 'too long for a link: Edit by email only');
  if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'action-email.html'), mail.html);
    fs.writeFileSync(path.join(previewDir, 'action-email.txt'), `${mail.subject}\n\n${mail.text}`);
    fs.writeFileSync(path.join(previewDir, 'welcome-back.html'), welcomeMail.html);
    console.log(`Preview written to ${previewDir}`);
  }
}

(async () => {
  await testClassify();
  await testRouting();
  await testSending();
  await testActionEmail(process.argv[2]);
  console.log(`All reply tests passed (${checks} checks, ${fixtures.length} fixtures x 2 modes).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
