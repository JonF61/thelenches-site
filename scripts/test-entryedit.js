// scripts/test-entryedit.js: offline test of "edit everything" (4 Nov): scripts/entryedit writing a
// listing edit (a hand-written event's text and link, a regular activity's field, a place to eat,
// a published submission's Pending cells), refusing stale, official and non-editable changes, and
// asking for the newsletter Rebuild when the next issue is built; plus the newsletter draft's edit
// tags (render.js / draft.js editTags), which only the panel's draft carries.
// Sheet mocked; files in a temporary folder. Run: node scripts/test-entryedit.js
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ee = require('./entryedit');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-edit-'));
const put = (rel, obj, raw) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), raw || `${JSON.stringify(obj, null, 2)}\n`); };
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const EV = 'src/items/events/2026-11-13-quiz-night.json';
put(EV, { date: '2026-11-13', title: 'Quiz night — The Lenches Club', body: 'Teams of up to six, 7.30pm.', link: { text: 'Book', url: 'https://example.org/book' } });
put('src/items/notices/council-statement.json', { title: 'Parish council statement', body: 'The council met.', official: true });
put('src/items/regulars.json', null, '{"_help": "x",\n  "regulars": [ {"day": "Tuesday", "time": "7.15pm", "what": "Lenches Ladies", "where": "The hall"} ]\n}\n');
put('src/_data/eat.json', { areas: ['Nearby'], places: [{ id: 'boot-inn', name: 'Boot Inn', area: 'Nearby', where: 'Flyford Flavell', type: 'Pub' }] });
put('src/_data/trades.json', { trades: [] });

const out = {};
process.env.GITHUB_OUTPUT = path.join(root, 'out.txt');
const outputs = () => Object.fromEntries(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('=')));
const reset = () => fs.writeFileSync(process.env.GITHUB_OUTPUT, '');

function sheet(pending = [], issues = []) {
  const writes = [];
  return {
    writes,
    readTable: async (tab) => (tab === 'Pending' ? pending : tab === 'Issues' ? issues : []),
    updateRow: async (tab, row, fields) => { writes.push({ tab, row, fields }); },
  };
}
const ID = `ee${'a1'.repeat(8)}`;
const payload = (key, changes) => ({ id: ID, body: JSON.stringify({ key, changes }) });

(async () => {
  // Event text and link, in one save.
  reset();
  let g = sheet();
  await ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [
    { field: 'body', old: 'Teams of up to six, 7.30pm.', new: 'Teams of up to six, from 7.30pm.\r\n\r\n\r\nBring a pen.' },
    { field: 'link', old: JSON.stringify({ text: 'Book', url: 'https://example.org/book' }), new: JSON.stringify({ text: 'Book a table', url: 'https://example.org/book' }) },
  ]), { g, root, today: '2026-11-04' });
  let ev = read(EV);
  assert.equal(ev.body, 'Teams of up to six, from 7.30pm.\n\nBring a pen.');
  assert.deepEqual(ev.link, { text: 'Book a table', url: 'https://example.org/book' });
  assert.equal(ev.title, 'Quiz night — The Lenches Club');
  assert.deepEqual(outputs(), { commit: 'true' });
  assert.equal(g.writes.length, 0);

  // Stale: the body no longer holds what Jon saw; nothing written.
  await assert.rejects(ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [{ field: 'body', old: 'Teams of up to six, 7.30pm.', new: 'X' }]), { g, root }), /changed since/);
  assert.equal(read(EV).body, 'Teams of up to six, from 7.30pm.\n\nBring a pen.');
  // Titles, dates and official statements are not editable here.
  await assert.rejects(ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [{ field: 'title', old: ev.title, new: 'Y' }]), { g, root }), /cannot be changed/);
  await assert.rejects(ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [{ field: 'date', old: ev.date, new: '2026-11-14' }]), { g, root }), /cannot be changed/);
  await assert.rejects(ee.run(payload('h:notices/council-statement.json', [{ field: 'body', old: 'The council met.', new: 'The council met today.' }]), { g, root }), /official/);
  await assert.rejects(ee.run(payload('h:events/../x.json', [{ field: 'body', old: '', new: 'x' }]), { g, root }), /not an editable entry/);
  await assert.rejects(ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [{ field: 'body', old: ev.body, new: '   ' }]), { g, root }), /empty/);
  await assert.rejects(ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [{ field: 'link', old: JSON.stringify(ev.link), new: JSON.stringify({ text: 'x', url: 'javascript:alert(1)' }) }]), { g, root }), /bad link/);
  await assert.rejects(ee.run({ id: 'bad', body: '{}' }, { g, root }), /bad edit id/);

  // Link taken off.
  reset();
  await ee.run(payload(`h:events/2026-11-13-quiz-night.json`, [{ field: 'link', old: JSON.stringify(read(EV).link), new: '' }]), { g, root });
  assert.equal(read(EV).link, undefined);

  // Regular activity: one field, the file's compact layout kept.
  reset();
  await ee.run(payload('r:0', [{ field: 'where', old: 'The hall', new: 'Church Lench Village Hall' }]), { g, root });
  const regText = fs.readFileSync(path.join(root, 'src/items/regulars.json'), 'utf8');
  assert.match(regText, /"where": "Church Lench Village Hall"\} \]/);
  assert.equal(JSON.parse(regText).regulars[0].what, 'Lenches Ladies');

  // Where to eat also redeploys the Worker.
  reset();
  await ee.run(payload('e:boot-inn', [{ field: 'type', old: 'Pub', new: 'Pub and restaurant' }]), { g, root });
  assert.equal(read('src/_data/eat.json').places[0].type, 'Pub and restaurant');
  assert.deepEqual(outputs(), { commit: 'true', worker: 'true' });

  // Published submission: the column it publishes from (own wording or rewrite), and its link cells.
  const pending = [
    { _row: 7, id: 'p1', status: 'approved', title: 'Craft fair', summary: 'Stalls 10am to 4pm.', link_text: 'More', link_url: 'https://x.org' },
    { _row: 8, id: 'p2', status: 'approved', title: 'Own words', summary: 'Rewrite.', own_text: 'Their words.', verbatim_requested: 'TRUE' },
    { _row: 9, id: 'p3', status: 'approved', title: 'Council', summary: 'Statement.', official: 'TRUE' },
    { _row: 10, id: 'p4', status: 'pending', title: 'Waiting', summary: 'Not out yet.' },
  ];
  const issues = [{ issue_id: '2026-11-05', status: 'tested' }];
  reset();
  g = sheet(pending, issues);
  const r = await ee.run(payload('p:p1', [
    { field: 'body', old: 'Stalls 10am to 4pm.', new: 'Stalls 10am to 4pm, free entry.' },
    { field: 'link', old: JSON.stringify({ text: 'More', url: 'https://x.org' }), new: JSON.stringify({ text: 'Stallholders', url: 'https://x.org/stalls' }) },
  ]), { g, root, today: '2026-11-04' });
  assert.deepEqual(g.writes, [{ tab: 'Pending', row: 7, fields: { summary: 'Stalls 10am to 4pm, free entry.', link_text: 'Stallholders', link_url: 'https://x.org/stalls' } }]);
  assert.deepEqual(outputs(), { publish: 'true', rebuild: 'true', issue_date: '2026-11-05' });
  assert.equal(r.rebuild, true);
  reset();
  await ee.run(payload('p:p2', [{ field: 'body', old: 'Their words.', new: 'Their own words.' }]), { g, root, today: '2026-11-04' });
  assert.deepEqual(g.writes[1].fields, { own_text: 'Their own words.' });
  await assert.rejects(ee.run(payload('p:p3', [{ field: 'body', old: 'Statement.', new: 'S.' }]), { g, root }), /official/);
  await assert.rejects(ee.run(payload('p:p4', [{ field: 'body', old: 'Not out yet.', new: 'S.' }]), { g, root }), /not published/);
  await assert.rejects(ee.run(payload('p:p1', [{ field: 'title', old: 'Craft fair', new: 'S.' }]), { g, root }), /cannot be changed/);

  // Rebuild only when the next issue is built or tested (not sent, not a live draft).
  assert.deepEqual(ee.builtIssue([{ issue_id: '2026-11-05', status: 'built' }], '2026-11-04'), { rebuild: true, issue: '2026-11-05' });
  assert.equal(ee.builtIssue([{ issue_id: '2026-11-05', status: 'shadow' }], '2026-11-04').rebuild, false);
  assert.deepEqual(ee.builtIssue([{ issue_id: '2026-11-05', status: 'sent' }], '2026-11-05'), { rebuild: false, issue: '2026-11-12' });
  assert.equal(ee.builtIssue([], '2026-11-04').rebuild, false);

  // ---- Newsletter edit tags: only the panel's draft has them; the sent copy and its hash don't change.
  const { render } = require('./newsletter/render');
  const { editTags } = require('./newsletter/draft');
  const { whatsonKey } = require('./newsletter/select');
  const { loadWhatson, entryKeyOf } = require('../lib/whatson');
  const w = loadWhatson({ dir: path.join(root, 'src/items'), today: '2026-11-04' });
  assert.equal(entryKeyOf(w.events[0]), 'h:events/2026-11-13-quiz-night.json');
  assert.equal(entryKeyOf(w.regulars[0]), 'r:0');
  assert.equal(JSON.stringify(w.events[0]).includes('_entry'), false, 'the key never reaches JSON');
  const evKey = whatsonKey('events', w.events[0]);
  const model = {
    issueDate: '2026-11-05', keys: [evKey, 'p:p1', 'p:p3'], news: [], roads: [], elsewhere: [], siteUpdates: [],
    events: [{ key: evKey, title: w.events[0].title, body: w.events[0].body, meta: '', date: '2026-11-13', link: { text: 'Book', url: 'https://example.org/book' } }],
    notices: [{ key: 'p:p1', title: 'Craft fair', body: 'Stalls.', meta: '', link: { text: 'More', url: 'https://x.org' } }, { key: 'p:p3', title: 'Council', body: 'Statement.', meta: '' }],
    regulars: [{ day: 'Tuesday', time: '7.15pm', what: 'Lenches Ladies', where: 'Church Lench Village Hall', note: '' }],
    bins: { groups: [] }, bin: {},
  };
  const plain = render(model);
  assert.equal(/data-entry|data-field|data-label/.test(plain.html), false);
  const t = editTags(model, { whatson: w, pending });
  assert.deepEqual(t.entries, { [evKey]: 'h:events/2026-11-13-quiz-night.json', 'p:p1': 'p:p1', 'rg:0': 'r:0' });
  const tagged = render(t.model, { entries: t.entries });
  assert.match(tagged.html, /data-entry="h:events\/2026-11-13-quiz-night\.json" data-label="Event: Quiz night — The Lenches Club"/);
  assert.match(tagged.html, /data-entry="p:p1" data-label="Notice: Craft fair"/);
  assert.match(tagged.html, /<a data-field="link" href="https:\/\/x\.org"/);
  assert.match(tagged.html, /data-entry="r:0" data-label="Regular activity: Lenches Ladies" data-field="time frequency where note"/);
  assert.equal(/data-entry="p:p3"/.test(tagged.html), false, 'official statements are not tagged');
  assert.equal(render(model).hash, plain.hash, 'the sent copy is unchanged by tagging');
  assert.equal(tagged.text, plain.text);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('test-entryedit: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
