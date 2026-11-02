// scripts/test-itemfeedback.js
// Offline test of stage 1 of graduated autonomy (2 Nov 2026): nothing publishes without Jon's
// tap outside holiday mode (trusted.js PANEL_FIRST), Holly's write-ups are logged in the Item
// feedback tab and completed by Jon's decision (approved / edited / rejected / done, the fields
// he changed), her write-up prompt carries the lessons and his recent edits (never a contact),
// listing lessons stay out of her replies, and the Monday lessons read listing edits.
// Google and Claude are mocked; nothing leaves the machine.
// Run: node scripts/test-itemfeedback.js
'use strict';

const assert = require('assert');

process.env.ANTHROPIC_API_KEY = 'test';
process.env.LEARN_FROM_TEST = '2026-01-01 00:00'; // fixtures predate the 2 Nov clear-down
process.env.GMAIL_USER = 'owner@thelenches.org.uk';

const prompts = [];
let answer = '';
const sdkPath = require.resolve('@anthropic-ai/sdk');
class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (req) => {
        prompts.push(req);
        if (req.tools) {
          return {
            stop_reason: 'tool_use',
            usage: {},
            content: [{ type: 'tool_use', name: 'record_items', input: {
              items: [{ title: 'Quiz Night — Church Lench Village Hall', village: 'Church Lench', category: 'event', summary: 'A quiz from 7.30pm.',
                confidence: 0.9, urgent: false, political_commercial: false, classified: false, missing: [], image_index: -1,
                people_in_image: false, holly_note: 'Led with the cause, as the poster does.' }],
              anonymous: false, out_of_scope: false, email_class: 'submission', class_confidence: 0.9, hold_reason: 'none', needs_reply: true,
            } }],
          };
        }
        return { content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: {} };
      },
    };
  }
}
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic };

const g = require('./ingest/google');
let tables = {};
Object.assign(g, {
  readSettings: async () => ({ sources: [], settings: { from_name: 'Team' } }),
  readTable: async (tab) => {
    if (!tables[tab]) throw new Error(`Unable to parse range: ${tab}`);
    return tables[tab].map((r, i) => ({ ...r, _row: i + 2 }));
  },
  appendRows: async (tab, objs) => { (tables[tab] = tables[tab] || []).push(...objs.map((o) => ({ ...o }))); },
  ensureTab: async (tab) => { if (tables[tab]) return false; tables[tab] = []; return true; },
  updateRow: async (tab, row, fields) => { Object.assign(tables[tab][row - 2], fields); },
  sendMail: async () => ({ id: 'm1' }),
});

const trust = require('./ingest/trusted');
const fb = require('./ingest/itemfeedback');
const extract = require('./ingest/extract');
const replies = require('./ingest/replies');
const lessons = require('./lessons');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };

function testPanelFirst() {
  const trusted = new Set(['club@example.org']);
  const plain = { confidence: 0.9 };
  ok(trust.PANEL_FIRST === true, 'stage 1 switch is on');
  const r = trust.applyTrust('pending', plain, 'club@example.org', trusted, {});
  ok(r.status === 'pending' && !r.byTrust && r.trustedSource, 'trusted source waits for Jon, marked trusted source');
  const n = trust.applyTrust('pending', plain, 'someone@example.org', trusted, {});
  ok(n.status === 'pending' && !n.trustedSource, 'untrusted source waits, unmarked');
  const road = { confidence: 0.9, link_url: 'https://one.network/?tm=123' };
  ok(!trust.panelFirst(road) && trust.applyTrust('pending', road, 'club@example.org', trusted, {}).status === 'auto', 'roadworks (one.network) keep their old behaviour');
  ok(trust.applyTrust('auto', plain, 'club@example.org', trusted, {}).status === 'auto', 'holiday mode auto is left alone');
  ok(replies.TIMEOUT_SEND === false, 'clarify 24h fallback is off');
  ok(fb.LEARN_FROM === '2026-01-01 00:00', 'clear-down point (test override)');
}

async function testFeedback() {
  tables = { Pending: [] };
  const row = {
    id: 'm1-1', received: '2026-11-02 09:00', message_id: 'm1', status: 'pending', notes: 'trusted source',
    title: 'Quiz Night — Church Lench Village Hall', summary: 'A quiz from 7.30pm.', category: 'event', village: 'Church Lench',
    event_date: '2026-11-20', contact: 'Ann 01386 000000', confidence: 0.9, urgent: false, official: false, policy_flags: 'too_early',
  };
  const feed = { ...row, id: 'rss-x-1', message_id: 'rss:x', notes: '', category: 'notice', official: true, event_date: '' };
  await fb.record([row, feed]);
  const tab = tables[fb.TAB];
  ok(tab.length === 2, 'one feedback row per item');
  ok(tab[0].type === 'event' && tab[0].source_kind === 'email-trusted' && tab[0].flags === 'too_early', 'email item: type, trusted source, flags');
  ok(tab[1].type === 'notice-official' && tab[1].source_kind === 'feed' && tab[1].flags.includes('official'), 'feed item: official notice');
  ok(JSON.parse(tab[0].draft).title === row.title && !tab[0].outcome, 'draft logged, undecided');
  ok(fb.rowFor({ ...row, status: 'auto' }).outcome === 'auto', 'holiday auto-publish logged as auto');

  // The submitter's own reply fills in a detail: still Holly's draft, not Jon's edit.
  await fb.updateDraft({ ...row, cost: '£5' });
  ok(JSON.parse(tab[0].draft).cost === '£5', 'submitter detail updates the draft');

  // Jon edits the title (and spacing elsewhere) in the panel, then approves.
  const edited = { ...row, cost: '£5', title: 'Charity Quiz Night — Church Lench Village Hall', summary: 'A quiz  from 7.30pm. ' };
  const o = await fb.resolve(edited, 'approve', { decidedAt: '2026-11-02 10:00' });
  ok(o.outcome === 'edited' && o.changed === 'title', 'edited: only the real change counts');
  ok(JSON.parse(tab[0].final).title.startsWith('Charity') && tab[0].decided_at === '2026-11-02 10:00', 'final text and time recorded');
  ok(await fb.resolve(edited, 'reject') === null && tab[0].outcome === 'edited', 'only the first decision counts');

  ok(fb.outcomeFor({ draft: tab[1].draft }, feed, 'approve_own', 'own').outcome === 'approved'
    && fb.outcomeFor({ draft: tab[1].draft }, feed, 'approve_own', 'own').changed === 'wording:own', 'approved as written, with wording choice');
  ok(fb.outcomeFor({ draft: tab[1].draft }, feed, 'reject').outcome === 'rejected', 'rejected');
  ok(fb.outcomeFor({ draft: tab[1].draft }, { ...feed, title: 'x' }, 'done').outcome === 'done', 'done stays done, even if edited');
  ok(await fb.resolve({ id: 'old-1' }, 'approve') === null, 'items from before stage 1 are skipped quietly');

  // A contact change is recorded but never given to Claude.
  tables[fb.TAB].push({ item_id: 'm2-1', type: 'event', outcome: 'edited', decided_at: '2026-11-02 11:00',
    draft: JSON.stringify({ contact: 'a' }), final: JSON.stringify({ contact: 'b' }) });
  tables[fb.TAB].push({ item_id: 'old-9', type: 'event', outcome: 'edited', decided_at: '2025-12-31 23:00',
    draft: JSON.stringify({ title: 'a' }), final: JSON.stringify({ title: 'b' }) });
  const corr = fb.correctionsFrom(tables[fb.TAB]);
  ok(!corr.some((c) => c.item_id === 'old-9'), 'decisions before the clear-down are not learned from');
  ok(corr.length === 1 && corr[0].item_id === 'm1-1' && corr[0].team_changed_to.title && !('contact' in corr[0].team_changed_to), 'corrections: changed fields only, never a contact');
}

async function testWriteupPrompt() {
  tables['Holly lessons'] = [
    { id: 'L1', created_at: '2026-11-01', lesson: 'When writing up a listing, name the charity a fundraiser supports.', status: 'approved' },
    { id: 'L2', created_at: '2026-10-30', lesson: 'Keep replies to a short paragraph where possible.', status: 'approved' },
  ];
  const learnt = await replies.primeLearning();
  ok(learnt.writeup.length === 2 && learnt.lessons.length === 1 && !learnt.lessons[0].startsWith('When writing up'), 'listing lessons stay out of replies');
  await extract.primeWriteups(learnt.writeup);
  const res = await extract.extract({ msg: { from: 'a@b.c', subject: 's', text: 'Quiz' }, sourceName: 'website', receivedIso: '2026-11-02', today: '2026-11-02', images: [], pdfs: [] });
  const sys = prompts[prompts.length - 1].system[0].text;
  ok(sys.startsWith('You are Holly') && sys.includes('FIXED RULES') && sys.includes('guidance, not a cage'), 'Holly writes up, fixed rules then guidance');
  ok(sys.includes('name the charity') && sys.includes('<recent_corrections>') && sys.includes('Charity Quiz Night'), 'lessons and recent edits in the write-up prompt');
  ok(!sys.includes('01386'), 'no contact details in the prompt');
  const req = prompts[prompts.length - 1];
  ok(req.tool_choice.type === 'auto' && JSON.stringify(req.messages).includes('Call the record_items tool now'), 'no forced tool_choice (Opus 5.5), told to call the tool');
  ok(res.items[0].holly_note === 'Led with the cause, as the poster does.', 'holly_note returned');
}

async function testLessons() {
  answer = JSON.stringify({ lessons: [{ lesson: 'When writing up a listing, say who a fundraiser is for in the title.', evidence: ['m1-1', 'zzz'], conflicts: '' }], review: [] });
  const now = Date.parse('2026-11-02T12:00:00Z');
  const { rows } = await lessons.run({ now });
  const req = prompts[prompts.length - 1];
  const input = JSON.parse(req.messages[0].content);
  ok(input.listing_corrections.length === 1 && input.listing_corrections[0].item_id === 'm1-1', 'lessons read the week\'s listing edits');
  ok(rows.length === 1 && rows[0].evidence === 'm1-1' && rows[0].status === 'proposed', 'listing lesson proposed with its item as evidence');
}

(async () => {
  testPanelFirst();
  await testFeedback();
  await testWriteupPrompt();
  await testLessons();
  console.log(`All item feedback tests passed (${checks} checks).`);
})().catch((err) => { console.error(err); process.exit(1); });
