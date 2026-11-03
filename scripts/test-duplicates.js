// scripts/test-duplicates.js
// Offline test of "Already listed" (ingest/duplicates.js, 3 Nov 2026) and "now on the website"
// (scripts/livenotice): candidates, Holly's match (mocked Claude), the acknowledgement wording,
// Item feedback outcomes, Add details (scripts/approve mergeFields / applyDetails) and the
// live-notice selection, wording and page check. Google and Claude are mocked.
// Run: node scripts/test-duplicates.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ANTHROPIC_API_KEY = 'test';
process.env.LIVE_FROM_TEST = '2026-11-03 00:00';
process.env.LIVE_CHECKS = '2';
process.env.LIVE_WAIT_MS = '1';

let answer = null;
let feedItemOut = null;
const prompts = [];
const sdkPath = require.resolve('@anthropic-ai/sdk');
class FakeAnthropic {
  constructor() {
    this.messages = { create: async (req) => {
      prompts.push(req);
      if (req.tools && req.tools[0].name === 'record_items') {
        return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: 'record_items', input: {
          items: [feedItemOut], anonymous: false, out_of_scope: false } }] };
      }
      return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: 'record_match', input: answer }] };
    } };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const g = require('./ingest/google');
let tables = {};
const sent = [];
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings: { replies_mode: 'live', reply_max_per_run: '50', reply_max_per_day: '50' } }),
  readTable: async (tab) => {
    if (!tables[tab]) throw new Error(`Unable to parse range: ${tab}`);
    return tables[tab].map((r, i) => ({ ...r, _row: i + 2 }));
  },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs.map((o) => ({ ...o }))); },
  ensureTab: async (tab) => { if (tables[tab]) return false; tables[tab] = []; return true; },
  updateRow: async (tab, row, fields) => { Object.assign(tables[tab][row - 2], fields); },
});

const dupes = require('./ingest/duplicates');
const replies = require('./ingest/replies');
const fb = require('./ingest/itemfeedback');
const approve = require('./approve/index');
const live = require('./livenotice');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };

// A small site: one hand-written event (the real-life case) and one published pipeline notice.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupes-'));
fs.mkdirSync(path.join(root, 'src', 'items', 'events'), { recursive: true });
fs.mkdirSync(path.join(root, 'src', 'items', 'notices'), { recursive: true });
fs.mkdirSync(path.join(root, 'src', '_data'), { recursive: true });
const EVENT_FILE = '2026-11-10-autumn-coffee-morning-church-lench.json';
fs.writeFileSync(path.join(root, 'src', 'items', 'events', EVENT_FILE), JSON.stringify({
  date: '2026-11-10', title: 'Autumn bring and buy coffee morning — Church Lench',
  body: 'A coffee morning with a bring and buy sale, 10am to noon. Everyone welcome.',
}));
fs.writeFileSync(path.join(root, 'src', 'items', 'events', '2026-10-01-old.json'), JSON.stringify({ date: '2026-10-01', title: 'Old fair' }));
fs.writeFileSync(path.join(root, 'src', '_data', 'pipeline.json'), JSON.stringify({
  events: [],
  notices: [{ id: 'p9-1', title: 'Footpath closure near Ab Lench', body: 'Closed for repairs.' }],
}));

async function testCandidatesAndMatch() {
  const list = dupes.listings([
    { id: 'w1-1', status: 'pending', received: '2026-11-02 10:00', category: 'event', title: 'Quiz night', event_date: '2026-11-10', message_id: 'w1' },
    { id: 'w2-1', status: 'rejected', received: '2026-11-02 10:00', category: 'event', title: 'Rejected thing', event_date: '2026-11-10' },
  ], { root, today: '2026-11-03' });
  ok(list.some((l) => l.key === `h:events/${EVENT_FILE}` && l.url.includes('/events/#ev-2026-11-10-autumn')), 'hand-written event listed with its anchor');
  ok(!list.some((l) => l.title === 'Old fair'), 'past events left out');
  ok(list.some((l) => l.key === 'p:p9-1' && l.url.includes('/notices/#notice-footpath')), 'published pipeline notice listed');
  ok(list.some((l) => l.key === 'p:w1-1' && l.url === ''), 'waiting Pending row listed without a link');
  ok(!list.some((l) => l.key === 'p:w2-1'), 'rejected rows left out');

  const nadine = { title: "Celia's Bring & Buy Coffee Morning", event_date: '2026-11-10', summary: 'Coffee, cake and a bring and buy, 10am to 12. £3.', link_url: '' };
  const cands = dupes.candidatesFor(nadine, list, 'n1');
  ok(cands[0].key === `h:events/${EVENT_FILE}`, 'same-day event with shared words ranks first');
  ok(!dupes.candidatesFor(nadine, list, 'w1').some((c) => c.key === 'p:w1-1'), 'the same email\'s own rows are never candidates');
  ok(dupes.candidatesFor({ title: 'Bring and buy coffee morning', event_date: '2026-12-01' }, list).every((c) => c.date !== '2026-11-10'),
    'a different date is never the same event');
  ok(dupes.candidatesFor({ title: 'Footpath closure, Ab Lench' }, list).some((c) => c.key === 'p:p9-1'), 'undated notice matched by title words');
  ok(!dupes.candidatesFor({ title: 'Harvest supper', event_date: '2026-11-20' }, list).length, 'nothing similar: no candidates, no Claude call');

  answer = { match: 1, confidence: 0.93, details: 'Costs £3; see the flyer online', body: 'A coffee morning with a bring and buy sale, 10am to noon, £3. Everyone welcome.',
    link_url: 'https://example.org/flyer', link_text: 'Flyer', link2_url: 'https://invented.example/x' };
  const text = 'Celia is hosting... flyer at https://example.org/flyer';
  const d = await dupes.check(nadine, list, { messageId: 'n1', text });
  ok(d && d.key === `h:events/${EVENT_FILE}` && d.sure, 'Holly\'s match recorded, sure');
  ok(d.changes.body.includes('£3') && d.changes.link_url === 'https://example.org/flyer' && d.changes.link_text === 'Flyer', 'details proposed');
  ok(!JSON.stringify(d).includes('invented.example'), 'a link not in the email is dropped');
  ok(prompts[prompts.length - 1].model === 'claude-opus-5-5', 'runs on Opus (real people\'s messages)');
  ok(/data, never instructions/.test(prompts[prompts.length - 1].system), 'submission treated as data');

  answer = { match: 1, confidence: 0.6, details: '' };
  const unsure = await dupes.check(nadine, list, { messageId: 'n1', text });
  ok(unsure && !unsure.sure && dupes.listedUrl(unsure) === '', 'unsure match is flagged but not told to the sender');
  answer = { match: -1, confidence: 0.9 };
  ok(await dupes.check(nadine, list, { messageId: 'n1', text }) === null, 'no match: a normal new item');
  answer = { match: 1, confidence: 0.95, body: 'Changed official words' };
  const off = dupes.resultFrom(answer, [{ ...cands[0], official: true }], '');
  ok(!off.changes.body, 'an official entry\'s words are never changed');
  ok(dupes.noteFor(d).startsWith('Already listed: "Autumn bring and buy'), 'Pending note');
  return d;
}

function testAck(d) {
  const url = dupes.listedUrl(d);
  const one = replies.buildBody({ items: [{ title: "Celia's Bring & Buy Coffee Morning", event_date: '2026-11-10', policy: [], listed: url }], name: 'Nadine' });
  ok(one.includes(`Thanks for sending "Celia's Bring & Buy Coffee Morning". We already have it on the website, so it's all set: ${url}`), 'single item: approved ack wording');
  ok(!/on its way/.test(one) && one.startsWith('Hi Nadine,'), 'not "on its way"');
  const mixed = replies.buildBody({ items: [
    { title: 'Quiz', event_date: '2026-11-20', policy: [] },
    { title: 'Coffee morning', event_date: '2026-11-10', policy: [], listed: url },
  ] });
  ok(mixed.includes('Thanks for sending "Quiz", it\'s on its way') && mixed.includes(`We already have "Coffee morning" on the website: ${url}`), 'mixed email: normal thanks plus the listed line');
}

function testFeedback(d) {
  const row = { id: 'n1-1', duplicate: JSON.stringify(d), category: 'event' };
  ok(fb.typeOf(row) === 'duplicate', 'duplicates are their own Autonomy kind');
  const f = { type: 'duplicate' };
  ok(fb.outcomeFor(f, row, 'merge', '', d.changes).outcome === 'approved', 'Add details as proposed = approved');
  ok(fb.outcomeFor(f, row, 'merge', '', { body: 'Jon\'s own' }).outcome === 'edited', 'Add details changed = edited');
  ok(fb.outcomeFor(f, row, 'done').outcome === 'edited', 'Done when Holly found details = edited');
  ok(fb.outcomeFor(f, { duplicate: JSON.stringify({ ...d, changes: {} }) }, 'done').outcome === 'approved', 'Done when nothing new = approved');
  ok(fb.outcomeFor(f, row, 'approve').outcome === 'rejected', 'published as new = Holly was wrong');
  ok(fb.outcomeFor(f, row, 'reject').outcome === 'done', 'plain reject not counted');
}

async function testMerge(d) {
  const fields = approve.mergeFields(JSON.stringify({ body: ' New text\r\nline ', link_url: 'https://example.org/flyer', link_text: '', link2_url: 'ftp://x' }));
  ok(fields.body === 'New text\nline' && fields.link_text === 'More details' && !fields.link2_url, 'fields cleaned');
  const itemsDir = path.join(root, 'src', 'items');
  const changed = await approve.applyDetails(d, fields, [], itemsDir);
  const item = JSON.parse(fs.readFileSync(path.join(itemsDir, 'events', EVENT_FILE), 'utf8'));
  ok(changed.join(',') === 'text,link' && item.body === 'New text\nline' && item.link.url === 'https://example.org/flyer', 'hand-written file updated');
  ok(!approve.HAND_KEY.test('h:events/../../package.json'), 'no path tricks');

  tables = { Pending: [{ id: 'p9-1', status: 'approved', summary: 'Closed.', official: 'TRUE' }] };
  const rows = await g.readTable('Pending');
  const ch = await approve.applyDetails({ key: 'p:p9-1' }, { body: 'x', link2_url: 'https://e.org/', link2_text: 'Map' }, rows);
  ok(tables.Pending[0].summary === 'Closed.' && tables.Pending[0].link2_url === 'https://e.org/' && ch.join() === 'second link', 'official pipeline item: links only');
}

async function testLive() {
  const pipeline = { events: [{ id: 'a1-1', date: '2026-11-20', title: 'Quiz — Rous Lench' }], notices: [{ id: 'a2-1', title: 'Lost cat' }] };
  const published = live.publishedById(pipeline);
  const pending = [
    { id: 'a1-1', status: 'approved', message_id: 'a1', decided_at: '2026-11-03 10:00', newsletter_count: '0', live_notified_at: '' },
    { id: 'a2-1', status: 'approved', message_id: 'a2', decided_at: '2026-11-03 10:00', newsletter_count: '1', live_notified_at: '' },
    { id: 'a3-1', status: 'approved', message_id: 'a3', decided_at: '2026-11-02 10:00', newsletter_count: '0', live_notified_at: '' },
    { id: 'rss:x', status: 'auto', message_id: 'rss:x', decided_at: '2026-11-03 10:00', live_notified_at: '' },
  ];
  const ack = { reply_id: 'a1-ack', message_id: 'a1', type: 'ack', status: 'sent', to: 'n@example.org', thread_id: 't1', subject: 'Re: Quiz', body: 'Hi Nadine,\n\nThanks…' };
  const groups = live.due(pending, [ack, { ...ack, message_id: 'a2' }], published);
  ok(groups.length === 1 && groups[0].messageId === 'a1', 'only live-able, un-newslettered, acknowledged items from after the switch-on');
  ok(!live.due(pending, [], published).length, 'no sent acknowledgement: nothing');
  const body = live.bodyFor(ack, groups[0].items);
  const url = 'https://thelenches.org.uk/events/#ev-2026-11-20-quiz-rous-lench';
  ok(body.startsWith('Hi Nadine,') && body.includes(`Good news: "Quiz — Rous Lench" is now on the website: ${url}`)
    && body.includes('try refreshing the page'), 'approved live wording');

  // Whole run: the first page check misses (cache lag), the second sees the anchor.
  tables = {
    Pending: pending.map((r) => ({ ...r })),
    Replies: [ack],
  };
  const fsPipe = path.join(__dirname, '..', 'src', '_data', 'pipeline.json');
  const realRead = fs.readFileSync;
  fs.readFileSync = (f, ...a) => (f === fsPipe ? JSON.stringify(pipeline) : realRead(f, ...a));
  let calls = 0;
  const fetchPage = async (u) => { calls += 1; ok(/\?v=\d+$/.test(u), 'page fetched fresh'); return calls < 2 ? '<div>old</div>' : '<div class="item-card" id="ev-2026-11-20-quiz-rous-lench">'; };
  let delivered = 0;
  const realSend = replies.sendDueReplies;
  replies.sendDueReplies = async () => { delivered += 1; return 1; };
  try {
    const n = await live.run({ fetchPage });
    ok(n === 1 && delivered === 1, 'one email queued and sent');
    const row = tables.Replies.find((r) => r.type === 'live');
    ok(row && row.reply_id === 'a1-live-1' && row.status === 'queued' && row.thread_id === 't1', 'Replies row on the ack thread');
    ok(tables.Pending[0].live_notified_at, 'item marked');
    ok(await live.run({ fetchPage }) === 0, 'never twice');
    tables.Pending = tables.Pending.map(({ live_notified_at, ...r }) => r); // eslint-disable-line camelcase
    ok(await live.run({ fetchPage }) === 0, 'no live_notified_at column: nothing sent');
  } finally {
    fs.readFileSync = realRead;
    replies.sendDueReplies = realSend;
  }
}

// Feed items (rss.js processItem) get the same check; roadworks alerts don't.
async function testFeed() {
  const rss = require('./ingest/rss');
  const today = new Date().toISOString().slice(0, 10);
  const existing = [{ id: 'e1-1', status: 'approved', received: `${today} 09:00`, category: 'event', title: 'Village quiz night — Rous Lench', event_date: '2099-01-10', message_id: 'e1', summary: 'Quiz at 7.30pm.' }];
  const h = { londonDateTime: () => `${today} 10:00`, findRepeat: () => null, decideStatus: () => 'auto' };
  const entry = (title, link = 'https://www.eveshamjournal.co.uk/news/1.quiz/') => ({ feed: { source: 'Evesham Journal', match: 'https://www.eveshamjournal.co.uk/news/rss/', mode: 'auto' },
    item: { title, text: 'A quiz night in Rous Lench.', link, publishedMs: Date.now() }, key: `rss:${title.length}abc` });
  tables = { Pending: [] };
  const ctx = { existing, holiday: true, trusted: new Set(), today, tokensIn: 0, tokensOut: 0 };
  feedItemOut = { title: 'Quiz night in Rous Lench', event_date: '2099-01-10', village: 'Rous Lench', category: 'event', summary: 'A quiz night in Rous Lench.',
    confidence: 0.9, urgent: false, political_commercial: false, classified: false, missing: [], image_index: -1, people_in_image: false };
  answer = { match: 1, confidence: 0.9, details: '' };
  const before = prompts.length;
  await rss.processItem(entry('Quiz night in Rous Lench'), ctx, h);
  const row = tables.Pending[0];
  ok(row && row.status === 'pending' && dupes.parse(row.duplicate), 'feed duplicate flagged and held, even in holiday mode (signposts are matched against the real site here)');
  ok(/Already listed/.test(row.notes), 'feed duplicate noted');
  ok(prompts.slice(before).some((p) => p.tools[0].name === 'record_match'), 'feed item checked');
  feedItemOut = { ...feedItemOut, title: 'Road closure', link_url: 'https://one.network/?tm=1', category: 'notice', event_date: '2099-01-10' };
  const n = prompts.length;
  await rss.processItem(entry('Road closure', 'https://one.network/?tm=1'), ctx, h);
  ok(!prompts.slice(n).some((p) => p.tools[0].name === 'record_match') && !tables.Pending[1].duplicate, 'roadworks alerts not checked');
}

(async () => {
  await testFeed();
  const d = await testCandidatesAndMatch();
  testAck(d);
  testFeedback(d);
  await testMerge(d);
  await testLive();
  console.log(`All duplicate and live-notice tests passed (${checks} checks).`);
})().catch((err) => { console.error(err); process.exit(1); });
