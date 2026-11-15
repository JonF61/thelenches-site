// scripts/test-sitechanges.js
// Offline test of autonomy plan step 3 (15 Nov 2026): what has lately been done, for Holly's
// prompts and Rimmer's reading (scripts/ingest/sitechanges.js, replies.js siteContext), and
// the Already listed check no longer treating different things at one venue as the same
// (duplicates.js sameSubject, the cap in resultFrom). Git, Google and Claude are mocked.
// Run: node scripts/test-sitechanges.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GMAIL_USER = 'owner@thelenches.org.uk';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.RIMMER_REPLIES = 'off';

const calls = [];
const sdkPath = require.resolve('@anthropic-ai/sdk');
class FakeAnthropic {
  constructor() {
    this.messages = { create: async (req) => {
      const system = Array.isArray(req.system) ? req.system.map((b) => b.text).join('') : String(req.system);
      calls.push({ system, input: JSON.parse(req.messages[0].content) });
      return { content: [{ type: 'text', text: JSON.stringify({ draft: 'Thanks, that change is on the page now.', answered_from_site: false }) }], stop_reason: 'end_turn', usage: {} };
    } };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const g = require('./ingest/google');
let tables = { Replies: [], 'Reply feedback': [] };
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings: { replies_mode: 'live', reply_sources: 'website' } }),
  readTable: async (tab) => { if (!tables[tab]) throw new Error('no tab'); return tables[tab].map((r, i) => ({ ...r, _row: i + 2 })); },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs); },
  updateRow: async () => {},
  ensureTab: async (tab) => { if (tables[tab]) return false; tables[tab] = []; return true; },
  getMessage: async () => { throw new Error('none'); },
  threadMessageIds: async () => [],
});

const sc = require('./ingest/sitechanges');
const dupes = require('./ingest/duplicates');
const replies = require('./ingest/replies');
const replycheck = require('./rimmer/replycheck');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

async function main() {
  // 1. The git log -> changes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitechanges-'));
  fs.mkdirSync(path.join(root, 'src', 'items', 'events'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/items/events/2026-12-11-xmas-fayre.json'), JSON.stringify({ title: 'Xmas Fayre — Village Hall' }));
  const log = [
    '\x012026-11-15\x02Xmas Fayre: venue is the Village Hall (#352)\n\nM\tsrc/items/events/2026-12-11-xmas-fayre.json\n',
    '\x012026-11-14\x02Publish pipeline items\n\nM\tsrc/_data/pipeline.json\nM\tsrc/_data/roadgeo.json\n',
    '\x012026-11-13\x02Pre-school entry updated (#285)\n\nM\tsrc/_data/schools.json\nA\tsrc/images/items/x.jpg\n',
    '\x012026-11-12\x02Old quiz removed\n\nD\tsrc/items/events/2026-11-01-quiz-night.json\n',
    '\x012026-11-11\x02Sponsor page and contact wording\n\nM\tsrc/sponsor/index.njk\nM\tsrc/contact.njk\nM\tsrc/_includes/base.njk\nR100\tsrc/old.njk\tsrc/living-here/eat.njk\n',
  ].join('');
  const changes = sc.parseLog(log, { root });
  ok(changes.length === 4, 'automatic commits (pipeline, road lines) are left out');
  ok(changes[0].date === '2026-11-15' && changes[0].change === 'Xmas Fayre: venue is the Village Hall' && changes[0].entries[0] === 'event "Xmas Fayre — Village Hall" changed', 'an event change, PR number dropped, title from the file');
  ok(changes[1].entries.join() === 'Schools page changed', 'a data file by its page; images left out');
  ok(changes[2].entries[0] === 'event "quiz night" removed', 'a removed file by its slug');
  ok(changes[3].entries.join(' | ') === 'page /contact/ wording changed | page /living-here/eat/ wording changed', 'page wording; sponsor pages and includes left out');
  ok(sc.recentChanges({ fresh: true, run: () => { throw new Error('no git'); } }).length === 0, 'no git: nothing, no error');
  ok(sc.recentChanges({ fresh: true, run: (cmd, args) => { ok(cmd === 'git' && args.includes('--since=14 days ago') && args[args.length - 1] === 'src', 'last 14 days of src'); return log; }, root }).length === 4, 'read through git');

  // 2. What a sender sent and what became of it.
  const existing = [
    { id: 'a', message_id: 'm1', from: 'Ann <ann@example.org>', title: 'Quiz night', event_date: '2026-11-20', received: '2026-11-05 10:00', status: 'approved', decided_at: '2026-11-05 12:00', notes: "x | Details added from submitter's reply 6 Nov (event_time)" },
    { id: 'b', message_id: 'm2', from: 'ann@example.org', title: 'Coffee morning', received: '2026-11-10 10:00', status: 'done', notes: 'Already listed: "Autumn Coffee Morning" (hand-written, Holly 95%)' },
    { id: 'c', message_id: 'm3', from: 'bob@example.org', title: 'Not hers', received: '2026-11-10 10:00', status: 'pending' },
    { id: 'd', message_id: 'm4', from: 'ann@example.org', title: 'Long ago', received: '2026-08-01 10:00', status: 'approved' },
    { id: 'e', message_id: 'now', from: 'ann@example.org', title: 'This very email', received: '2026-11-15 10:00', status: 'pending' },
  ];
  const isAnn = (from) => /ann@example\.org/.test(from);
  const items = sc.senderItems(existing, isAnn, { live: new Map([['a', 'https://thelenches.org.uk/events/#ev-quiz']]), today: '2026-11-15', skipMessageId: 'now' });
  ok(items.length === 2 && items[0].title === 'Coffee morning' && items[1].title === 'Quiz night', 'hers only, last 60 days, newest first, not this email');
  ok(items[1].state === 'on the website now' && items[1].page.endsWith('#ev-quiz') && items[1].details_they_added_later === true, 'live with its page; later details noted');
  ok(/already dealt with/.test(items[0].state) && items[0].already_listed_as === 'Autumn Coffee Morning', 'done, and what it was already listed as');

  // 3. Holly's answer prompt and Rimmer's input carry them.
  const msg = { id: 'now', threadId: 't', from: 'Ann <ann@example.org>', fromAddress: 'ann@example.org', replyTo: '', subject: 'Quiz', text: 'Did you change the venue?\n\nAnn', attachments: [], auto: {} };
  const site = replies.siteContext(msg, existing);
  ok(site.sender_items && site.sender_items.length === 2 && site.sender_items.every((i) => i.title !== 'This very email'), 'siteContext finds the sender by address');
  ok(!('sender_items' in replies.siteContext({ ...msg, fromAddress: 'new@example.org', from: 'new@example.org' }, existing)), 'a new sender has none');
  const ctx = { settings: { replies_mode: 'live', reply_sources: 'website' }, holiday: false, existing, replies: [] };
  await replies.planReply({ msg, sourceName: 'website', result: { emailClass: 'question', classConfidence: 0.9, needsReply: true }, rows: [], ctx });
  const holly = calls[calls.length - 1];
  ok(holly.input.sender_items.length === 2 && /sender_items, when the input has it/.test(holly.system), 'the answer prompt has them and the rule');
  ok(holly.system.indexOf('Facts only from site_facts') < holly.system.indexOf('sender_items, when the input has it') && /rules above about never claiming a change still hold/.test(holly.system), 'her own rules first; no wider licence');
  const rin = replycheck.buildInput({ draft: 'd', type: 'answer', site });
  ok(rin.sender_items.length === 2 && rin.draft === 'd' && /sender_items, when given/.test(replycheck.SYSTEM) && /recent_site_changes, when given/.test(replycheck.SYSTEM), 'Rimmer is given them too');

  // 4. Already listed: different things at one venue.
  ok(dupes.sameSubject('Fireworks Night — The Lenches Club', 'The Lenches Fireworks Night — The Lenches Club'), 'same thing, different wording');
  ok(dupes.sameSubject('Club closed 23 to 25 November — The Lenches Club', 'The Lenches Club closed 23–25 November'), 'same closure');
  ok(!dupes.sameSubject('Quiz Night — The Lenches Club', 'Cash Bingo — The Lenches Club'), 'quiz is not bingo, whatever the venue');
  ok(!dupes.sameSubject('Christmas Wreath Workshop — Village Hall', 'Pilates — Village Hall'), 'two things at the hall');
  ok(dupes.sameSubject('The Lenches Club', 'Anything — The Lenches Club'), 'nothing to compare: left to Holly');
  const cand = [{ key: 'h:events/x.json', title: 'Cash Bingo — The Lenches Club', url: 'https://thelenches.org.uk/events/#x', source: 'hand-written', body: 'Bingo.', official: false }];
  const same = dupes.resultFrom({ match: 1, confidence: 0.95 }, cand, '', 'Cash Bingo — The Lenches Club');
  const other = dupes.resultFrom({ match: 1, confidence: 0.95 }, cand, '', 'Quiz Night — The Lenches Club');
  ok(same.sure === true && same.confidence === 0.95, 'the same title stays sure');
  ok(other.sure === false && other.confidence === 0.75 && dupes.listedUrl(other) === '', 'different titles: never sure, so the sender is not told we have it');

  console.log(`All site-changes tests passed (${checks} checks).`);
}
main().catch((err) => { console.error(err); process.exit(1); });
