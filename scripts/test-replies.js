// Offline test for classified replies (scripts/ingest/replies.js and friends, 23 Oct).
// Runs every case in scripts/replies/fixtures.json in normal and holiday mode, then the
// send, Approve, Reject (with reason), Edit, sorry-note and Reply feedback paths, and
// renders the action email. Part 2: first-name greetings, automatic subscribe and
// unsubscribe, the Worker edit-form link, and the holiday log / welcome-back digest.
// 23 Oct fixes: Redraft, "Still owed a reply" and Close, subscribe/unsubscribe on an
// answered thread, site facts (meetings, term dates, health, transport), links in
// brackets, and signatures trimmed. No secrets and no network: Google and Claude are mocked.
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
let redraftFor = null;  // mocked Redraft answer
let extractInput = null; // current extract() tool input
let requests = [];      // { system, input } of each text call to Claude
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
        let input = null;
        try { input = JSON.parse(req.messages[0].content); } catch { /* plain text */ }
        requests.push({ system, input });
        if (system.startsWith('You rewrite a draft')) text = JSON.stringify(redraftFor || { draft: '' });
        else if (system.startsWith('You draft replies')) text = JSON.stringify(draftFor || { draft: '', answered_from_site: false });
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
const inbox = {}; // message id -> text, for getMessage
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
    : { rfcMessageId: `<${id}@mail>`, references: '', text: inbox[id] || '' }),
  getSheetGid: async () => 0,
  spreadsheetId: () => 'sheet',
});

const replies = require('./ingest/replies');
const edits = require('./ingest/edits');
const { extract } = require('./ingest/extract');
const { normaliseClass, holdReasonFor } = require('./ingest/classify');
const { sendUrgentAlerts, sendReplyCard } = require('./ingest/urgent');
const { siteFacts } = require('./ingest/sitefacts');
const feedbackTab = require('./ingest/feedback').TAB;
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
  inbox[msg.id] = msg.text;
  const rows = (c.rows || []).map((r, i) => ({ ...r, id: `${msg.id}-${i + 1}`, message_id: msg.id, from: msg.from }));
  rows.forEach((r) => tables.Pending.push(pick('Pending', { ...r, status: 'pending' })));
  ctx.existing.push(...rows);
  const before = ctx.replies.length;
  await replies.planReply({ msg, sourceName: 'website', result: { ...c.result, anonymous: false, outOfScope: false }, rows, ctx });
  return ctx.replies.slice(before);
}

let checks = 0;
let welcomeMail = null; // saved with the previews
let owedMail = null;
let cardMail = null;
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
  ok(byType('whattodo').every((r) => r.status === 'sent') && byType('answer').filter((r) => r.status === 'sent').length === 4
    && byType('list').every((r) => r.status === 'sent'), 'holiday mode: confident answers, list confirmations and what-to-do replies sent');
  ok(byType('held').every((r) => r.status === 'awaiting'), 'holiday mode: held drafts still wait');
  ok(byType('answer').filter((r) => r.status === 'awaiting').length === 3, 'holiday mode: drafts that failed a check, and refused list requests, wait');
  ok(fb().filter((r) => r.outcome === 'auto_sent').length === 7, 'feedback: auto_sent (clarify, 4 answers, 2 what-to-do)');

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
    fs.writeFileSync(path.join(previewDir, 'still-owed.html'), owedMail.html);
    fs.writeFileSync(path.join(previewDir, 'redraft-card.html'), cardMail.html);
    console.log(`Preview written to ${previewDir}`);
  }
}

/* --------------------------------------------------------- 23 Oct fixes -- */

const find = (id) => tables.Replies.find((r) => r.reply_id === id);
const fbRow = (id) => (tables[feedbackTab] || []).find((r) => r.reply_id === id);
const caseNamed = (name) => fixtures.find((c) => c.name === name);

async function testSignaturesAndLinks() {
  // 6: signatures and quoted history trimmed before quoting and drafting.
  const sig = caseNamed('question with a signature and quoted history');
  ok(replies.stripQuoted(sig.msg.text) === "When's the next South Lenches PC meeting?", 'signature and quoted history trimmed');
  ok(replies.stripQuoted('Is the hall free on Friday?\n\nJo\nMob: 07700 900123\nhttps://facebook.com/jo\n\nSent from my iPhone') === 'Is the hall free on Friday?\n\nJo',
    'contact lines and "Sent from my iPhone" trimmed');
  ok(replies.stripQuoted('Thanks') === 'Thanks' && replies.stripQuoted('Hi,\nThanks, is the quiz on?\nSam') === 'Hi,\nThanks, is the quiz on?\nSam',
    'a "thanks" that is the message itself is kept');
  // Stacked sign-offs (23 Oct: an email ended "Kind regards, Jon Fletcher All the best,
  // Jon. Jon Fletcher, Managing Director"), with or without line breaks.
  const stacked = 'Kind regards, Jon Fletcher All the best, Jon. Jon Fletcher, Managing Director';
  const q = 'Could you add our quiz night on Friday 6 November?';
  ok(replies.stripQuoted(`${q}\n\n${stacked}`) === q, 'stacked sign-offs on one line trimmed');
  ok(replies.stripQuoted(`${q} ${stacked}`) === q, 'stacked sign-offs on the message line trimmed');
  ok(replies.stripQuoted(`${q}\n\nKind regards,\nJon Fletcher\n\nAll the best,\nJon.\nJon Fletcher, Managing Director\nTel: 01386 000111`) === q,
    'stacked sign-offs on separate lines trimmed');
  ok(replies.stripQuoted('Thanks for the write-up.\nThanks, Sam\nBest wishes\nSam Jones (Chair)') === 'Thanks for the write-up.',
    'sign-off with a name, then another with a job title, trimmed');
  ok(replies.stripQuoted('Is the quiz on? Cheers, Sam') === 'Is the quiz on?', 'one-line email: sign-off after the question trimmed');
  const keep = [
    'We send our best regards to everyone who helped at the fete.\nBest wishes to the Committee and all at the Hall for the season ahead.',
    'The quiz was the best. Thanks to Sam and the Committee for organising it.',
    'Please add this.\nAll the best players will be there.',
    'Can you add our fete?\nMany thanks for your help last year, it went really well.',
    'We had a great time. Love Lench Fest is back next year with more stalls.',
  ];
  keep.forEach((t, i) => ok(replies.stripQuoted(t) === t, `real content with "best"/"regards"/"thanks" kept (${i + 1})`));

  reset();
  settings = LIVE;
  requests = [];
  const [row] = await plan(sig, 'g1', false, { settings, holiday: false, replies: [], existing: [] });
  ok(!/01386|pottery|Instagram|Kind regards|website@/.test(row.notes) && row.notes.includes("They wrote: \"When's the next South Lenches PC meeting?\""), 'They wrote quote has no signature');
  const asked = requests.find((r) => r.system.startsWith('You draft replies')).input;
  ok(asked.their_message === "When's the next South Lenches PC meeting?", 'Claude never sees the signature');

  // 4: computed site data is in the facts.
  const parish = asked.site_facts.council.parishes.find((x) => /South Lenches/.test(x.name));
  ok(parish && /^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+ \d{4}$/.test(parish.next_meeting), `next South Lenches meeting in site facts (${parish && parish.next_meeting})`);
  ok(asked.site_facts.council.parishes.every((x) => x.next_meeting), 'every parish has a next meeting (or where to look)');
  const f = siteFacts().facts;
  ok(f.schools.holidays.length && f.schools.holidays.every((b) => b.name && b.closes), 'school holidays (termdates.js) in site facts');
  ok(f.health.numbers.some((n) => n.includes('999')) && f.health.gps.length && f.health.pharmacies.length && f.health.defibrillators.length, 'health in site facts');
  ok(f.transport.buses.length && f.transport.on_demand && f.transport.stations.length, 'transport in site facts');
  ok(f.walks.walks.length && /\/living-here\/walks\/$/.test(f.walks.url), 'walks in site facts');
  ok(!/@/.test(JSON.stringify({ c: f.council, s: f.schools, h: f.health, t: f.transport })), 'no email addresses in the living-here facts');

  // 5: links in brackets or touching punctuation go on their own line.
  const fix = replies.fixLinks;
  ok(fix('Dates are on our Bins page (https://thelenches.org.uk/bins/).') === 'Dates are on our Bins page\nhttps://thelenches.org.uk/bins/', 'bracketed link fixed');
  ok(fix('See https://thelenches.org.uk/bins/, it has the dates.') === 'See\nhttps://thelenches.org.uk/bins/\nit has the dates.', 'link followed by a comma fixed');
  ok(fix('[https://thelenches.org.uk/events/]; or ring the hall.') === 'https://thelenches.org.uk/events/\nor ring the hall.', 'square brackets and semicolon fixed');
  ok(fix('Our guidelines are here:\nhttps://thelenches.org.uk/contact/#submit\n\nBest wishes,') === 'Our guidelines are here:\nhttps://thelenches.org.uk/contact/#submit\n\nBest wishes,', 'a link already on its own line is untouched');
  ok(fix('Our guidelines: https://thelenches.org.uk/contact/#submit') === 'Our guidelines:\nhttps://thelenches.org.uk/contact/#submit', 'text before a link: link moved to its own line');
  const brk = caseNamed('draft with a bracketed link');
  const [b] = await plan(brk, 'g2', false, { settings, holiday: false, replies: [], existing: [] });
  ok(b.body.includes('Bins page\nhttps://thelenches.org.uk/bins/\n\n') && !b.body.includes('/bins/)'), 'bracketed link in a draft moved to its own line');
  // An edit Jon types with a bracketed link is fixed as it goes.
  await replies.applyEdit(b.reply_id, 'Hi Max,\n\nIt is on the Bins page (https://thelenches.org.uk/bins/).\n\nBest wishes,\nHolly');
  const out = sent[sent.length - 1];
  ok(out.text.includes('page\nhttps://thelenches.org.uk/bins/\n') && !out.text.includes('/bins/)') && !out.html.includes('/bins/)"'), 'sent text has the link on its own line');
  ok(/Links moved onto their own line/.test(find(b.reply_id).notes), 'link fix noted in the Replies row');
}

async function testDates() {
  // Dates in drafts and edits in voice.md's style ("Saturday 12 October").
  const n = (t) => replies.normaliseDates(t, '2026-10-23');
  const cases = [
    ['The meeting is on Monday, 9 November 2026 at 7.30pm.', 'The meeting is on Monday 9 November at 7.30pm.'],
    ['Mon 9th Nov', 'Monday 9 November'],
    ['on November 9, 2026, at the hall', 'on 9 November, at the hall'],
    ['Friday the 13th of November', 'Friday 13 November'],
    ['on the 3rd of December', 'on 3 December'],
    ['Thursday, May 7 2027', 'Thursday 7 May'],
    ['Tues 1 Dec, 2026', 'Tuesday 1 December'],
    ['the fete on Saturday 11 September 2027', 'the fete on Saturday 11 September 2027'], // > 300 days ahead: year kept
    ['back on 1 March 2026', 'back on 1 March 2026'], // in the past: year kept
    ['Saturday 12 October', 'Saturday 12 October'],
    ['May 5 people come?', 'May 5 people come?'],
    ['from 9 to 11 November', 'from 9 to 11 November'],
    ['£5 November raffle', '£5 November raffle'],
    ['https://thelenches.org.uk/2026/11/9 November', 'https://thelenches.org.uk/2026/11/9 November'],
  ];
  cases.forEach(([from, to]) => ok(n(from) === to, `date style: "${from}" -> "${n(from)}"`));

  reset();
  settings = LIVE;
  requests = [];
  const ctx = { settings, holiday: false, replies: [], existing: [] };
  const c = { ...caseNamed('question with a signature and quoted history'),
    claude: { draft: 'The next meeting is on Monday, 9 November 2026 at 7.30pm.', answered_from_site: false } };
  const [row] = await plan(c, 'd1', false, ctx);
  ok(row.body.includes('Monday 9 November at 7.30pm') && !row.body.includes('2026'), 'draft date put in house style');
  ok(requests.some((r) => /no comma, no "th" and no year/.test(r.system)), 'Claude is told the date style');
  // Jon's edit: dates fixed as it goes, and noted.
  await replies.applyEdit(row.reply_id, 'Hi Ruth,\n\nIt is on Mon, 9th November 2026.\n\nBest wishes,\nHolly');
  ok(sent[sent.length - 1].text.includes('It is on Monday 9 November.'), 'edited text sent with the date in house style');
  ok(/Dates put in house style/.test(find(row.reply_id).notes), 'date fix noted in the Replies row');
}

async function testFollowupLists() {
  // 3: a follow-up on an answered thread classed unsubscribe, from a real subscriber.
  reset();
  settings = LIVE;
  tables.Subscribers.push({ email: 'sub@example.com', status: 'active' });
  const ctx = { settings, holiday: false, replies: [], existing: [] };
  const answered = { reply_id: 'f0-answer', message_id: 'f0', thread_id: 'tf', to: 'sub@example.com', type: 'answer', status: 'sent', body: 'Hi Ann,\n\nThe quiz is on Friday.' };
  ctx.replies.push(answered);
  const follow = (id, text, result, extra = {}) => ({
    msg: { id, threadId: 'tf', subject: 'Re: Quiz', text, from: 'Ann Subscriber <sub@example.com>', fromAddress: 'sub@example.com', replyTo: '', attachments: [], auto: {}, ...extra },
    reply: answered, ctx, added: [], result: { holdReason: 'none', needsReply: true, ...result },
  });
  requests = [];
  const f1 = await replies.planFollowup(follow('f1', 'Please take me off your mailing list.\n\nThanks,\nAnn\n07700 900999', { emailClass: 'unsubscribe', classConfidence: 0.97 }));
  ok(!f1.flagged && /unsubscribe done automatically/.test(f1.reason), `follow-up unsubscribe done automatically (${f1.reason})`);
  ok(tables['Do Not Send'].some((r) => r.email === 'sub@example.com'), 'follow-up unsubscribe: sender on Do Not Send');
  const list = find('f1-list');
  ok(list && list.type === 'list' && list.status === 'queued' && list.body.includes("we've taken you off the newsletter list"), 'follow-up unsubscribe confirmed');
  ok(!find('f1-followup') && !requests.some((r) => r.system.includes('triage')), 'no "use the newsletter link" follow-up draft');

  const f2 = await replies.planFollowup(follow('f2', 'Maybe stop the emails?', { emailClass: 'unsubscribe', classConfidence: 0.5 }));
  ok(f2.flagged && find('f2-followup') && tables['Do Not Send'].length === 2, 'unsure unsubscribe follow-up: draft for Jon, nothing changed');
  const f3 = await replies.planFollowup(follow('f3', 'Unsubscribe my friend please', { emailClass: 'unsubscribe', classConfidence: 0.95 }, { replyTo: 'friend@example.com' }));
  ok(f3.flagged && !tables['Do Not Send'].some((r) => r.email === 'friend@example.com'), 'another address: never done automatically');
  const f4 = await replies.planFollowup(follow('f4', 'Add me back please', { emailClass: 'subscribe', classConfidence: 0.95 },
    { from: 'Bo <blocked@example.com>', fromAddress: 'blocked@example.com' }));
  ok(f4.flagged && /Not done automatically: they are on Do Not Send/.test(find('f4-followup').notes), 'refused follow-up subscribe goes to Jon with the reason');

  await replies.sendDueReplies(settings, false);
  ok(list.status === 'sent' && find('f2-followup').status === 'awaiting', 'confirmation sent; follow-up drafts wait');
}

async function testRedraft() {
  reset();
  settings = LIVE;
  const ctx = { settings, holiday: false, replies: [], existing: [] };
  const [a] = await plan(caseNamed('question with a signature and quoted history'), 'r1', false, ctx);
  redraftFor = { draft: 'Shorter: it is Monday 9 November (https://thelenches.org.uk/living-here/council/).' };
  requests = [];
  await assert.rejects(replies.redraftReply(a.reply_id, ''), /no instruction/);
  const fresh = await replies.redraftReply(a.reply_id, 'Make it shorter');
  const asked = requests.find((r) => r.system.startsWith('You rewrite a draft')).input;
  ok(asked.instruction === 'Make it shorter' && asked.their_message === "When's the next South Lenches PC meeting?"
    && !asked.previous_draft.startsWith('Hi ') && !asked.previous_draft.includes('Lenches website assistant') && asked.site_facts.council,
  'redraft uses the instruction, their email (no signature), the old draft and site facts');
  ok(fresh.reply_id === `${a.reply_id}-r1` && fresh.status === 'awaiting' && fresh.type === 'answer' && fresh.thread_id === a.thread_id, 'redraft is a new awaiting draft on the same thread');
  ok(fresh.body.startsWith('Hi Ruth,\n\nShorter: it is Monday 9 November\nhttps://thelenches.org.uk/living-here/council/\n\nBest wishes,'), 'redraft keeps the greeting and fixes the bracketed link');
  ok(find(a.reply_id).status === 'redrafted', 'old draft closed');
  ok(fbRow(a.reply_id).outcome === 'redrafted' && fbRow(a.reply_id).reason === 'Make it shorter' && fbRow(fresh.reply_id), 'Reply feedback: redrafted with the instruction; new draft logged');
  ok(await replies.redraftReply(a.reply_id, 'again') === null, 'a redrafted draft cannot be redrafted twice');
  const before = sent.length;
  await replies.decideReply(a.reply_id, 'send');
  ok(sent.length === before && find(a.reply_id).status === 'redrafted', 'Approve on a redrafted draft does nothing');

  sent = [];
  await sendReplyCard(fresh.reply_id, settings);
  ok(sent.length === 1 && /^Redraft ready: reply to ruth@example.com/.test(sent[0].subject) && sent[0].html.includes('>Redraft<')
    && sent[0].html.includes('>Approve<') && find(fresh.reply_id).alerted_at, 'fresh card emailed with Approve / Edit / Redraft / Reject');
  [cardMail] = sent;
  const second = await replies.redraftReply(fresh.reply_id, 'Friendlier');
  ok(second.reply_id === `${a.reply_id}-r2` && find(fresh.reply_id).status === 'redrafted', 'a redraft of a redraft keeps one chain');

  redraftFor = { draft: 'See https://example-buses.com/ for times.' };
  await assert.rejects(replies.redraftReply(second.reply_id, 'Add the bus link'), /failed the checks/);
  ok(find(second.reply_id).status === 'awaiting', 'a redraft that fails the checks leaves the old draft waiting');

  // Every card in the action email has Redraft.
  sent = [];
  await sendUrgentAlerts(settings, false);
  ok(sent[0] && (sent[0].html.match(/>Redraft</g) || []).length === 1 && sent[0].text.includes('Redraft: https://worker.example/a?t='), 'action email cards have Redraft');
}

async function testOwed() {
  reset();
  settings = LIVE;
  const ctx = { settings, holiday: false, replies: [], existing: [] };
  await plan(caseNamed('complaint'), 'w1', false, ctx);
  await plan(caseNamed('who runs the site'), 'w2', false, ctx);
  await replies.sendDueReplies(settings, false);
  const holding1 = find('mw1-holding');
  const holding2 = find('mw2-holding');
  ok(holding1.status === 'sent' && holding2.status === 'sent', 'holding replies sent');
  ok(replies.owedReplies(tables.Replies.map((r, i) => ({ ...r, _row: i + 2 }))).length === 0, 'not owed before 2 days');
  holding1.sent_at = hoursAgo(50);
  holding2.sent_at = hoursAgo(50);
  await replies.decideReply('mw1-held', 'skip', 'will reply myself');
  const rowsNow = () => tables.Replies.map((r, i) => ({ ...r, _row: i + 2 }));
  const owed = replies.owedReplies(rowsNow());
  ok(owed.length === 2 && owed.find((o) => o.holding.reply_id === 'mw1-holding').draft.reply_id === 'mw1-held', 'rejected and still-awaiting drafts both owed after 2 days');

  tables.Replies.forEach((r) => { r.alerted_at = r.alerted_at || 'earlier'; }); // other drafts already shown
  sent = [];
  ok(await sendUrgentAlerts(settings, false) === 2, 'owed emails trigger an action email on their own');
  const mail = sent[0];
  owedMail = mail;
  ok(/still owed a reply/.test(mail.subject) && mail.html.indexOf('Still owed a reply') < mail.html.indexOf('Buttons open a confirm page'), `owed subject (${mail.subject})`);
  ok(mail.html.includes('Close, no reply needed') && mail.html.includes('>Redraft<') && mail.html.includes('Reply myself: answer them from website@'), 'owed cards: Redraft, Close and the reply-myself note');
  ok(mail.html.includes('You rejected the draft below') && mail.text.includes('STILL OWED A REPLY'), 'owed card says the draft was rejected');
  ok((mail.html.match(/>Approve</g) || []).length === 1, 'Approve only on the owed draft still awaiting');
  sent = [];
  ok(await sendUrgentAlerts(settings, false) === 0 && !sent.length, 'not reminded again within a day');

  // Redraft of a rejected draft for an owed email.
  redraftFor = { draft: 'Thanks for raising this. We are sorry for the trouble and the team is looking at it.' };
  const r = await replies.redraftReply('mw1-held', 'Say sorry');
  ok(r && r.status === 'awaiting' && find('mw1-held').status === 'skipped', 'a rejected owed draft can be redrafted');
  ok(fbRow('mw1-held').outcome === 'redrafted' && /^Rejected \(will reply myself\), then redraft: Say sorry$/.test(fbRow('mw1-held').reason), 'feedback keeps the reject reason before the redraft');
  ok(replies.owedReplies(rowsNow()).find((o) => o.holding.reply_id === 'mw1-holding').draft.reply_id === r.reply_id, 'owed card now shows the redraft');

  // Close, no reply needed: stops it and closes the waiting draft.
  await replies.closeOwed('mw1-holding');
  ok(!replies.owedReplies(rowsNow()).some((o) => o.holding.reply_id === 'mw1-holding'), 'closed: no longer owed');
  ok(find(r.reply_id).status === 'skipped' && fbRow(r.reply_id).outcome === 'closed', 'closed: waiting draft closed, feedback "closed"');
  ok(await replies.closeOwed('mw1-holding') === 0, 'close is single use');

  // A real reply sent stops it.
  await replies.decideReply('mw2-held', 'send');
  ok(replies.owedReplies(rowsNow()).length === 0, 'real reply sent: no longer owed');
}

(async () => {
  await testClassify();
  await testSignaturesAndLinks();
  await testDates();
  await testFollowupLists();
  await testRedraft();
  await testOwed();
  await testRouting();
  await testSending();
  await testActionEmail(process.argv[2]);
  console.log(`All reply tests passed (${checks} checks, ${fixtures.length} fixtures x 2 modes).`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
