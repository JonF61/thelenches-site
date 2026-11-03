// scripts/test-rimmer-fix.js: offline test of Fix… on Rimmer's findings (scripts/rimmer/fix.js):
// finding the entry, Holly's proposal checked (no invented details, official words kept), the
// proposal written to the row, and Apply writing a repo file (layout kept) or a Pending cell.
// Sheet and Claude mocked; files in a temporary folder. Run: node scripts/test-rimmer-fix.js
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fix = require('./rimmer/fix');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rimmer-fix-'));
const put = (rel, obj, raw) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), raw || `${JSON.stringify(obj, null, 2)}\n`); };
put('src/items/events/2026-11-13-quiz-night.json', { date: '2026-11-13', title: "Liz's Quiz and pub night — The Lenches Club", body: 'Teams of up to six, 7.30pm. Tickets from Fran.' });
put('src/items/notices/council-statement.json', { title: 'Parish council statement', body: 'The council has agreed the budjet for next year.', official: true });
// regulars.json in a compact layout that a full rewrite would change.
put('src/items/regulars.json', null, '{"_help": "x",\n  "regulars": [ {"day": "Tuesday", "time": "7.15pm", "what": "Lenches Ladies", "frequency": "2nd Tuesday of the month"} ]\n}\n');
put('src/_data/eat.json', { areas: ['Nearby villages'], places: [{ id: 'boot-inn', name: 'Boot Inn', area: 'Nearby villages', where: 'Flyford Flavell', type: 'Pub' }] });
put('src/_data/trades.json', { trades: [] });
put('src/_data/siteupdates.json', { entries: [{ key: 'a-2026-11', from: '2026-11-05', link: 'https://x', text: 'There is a new page.' }] });
put('src/items/bin-and-footnote.json', { bin: 'Bins: check your day.' });
put('src/_data/pipeline.json', { events: [{ id: 'p1', title: 'Craft fair' }], notices: [] });

const pending = [
  { _row: 7, id: 'p1', title: 'Craft fair', summary: 'Stalls from 10am to 4pm at the hall, entry free.', official: '' },
  { _row: 8, id: 'p2', title: 'Not published', summary: 'Tickets from Fran.' },
];

// sources and candidates
const all = fix.sources({ root, pending });
assert.deepEqual(all.map((s) => s.key).sort(), ['b:bin', 'e:boot-inn', 'h:events/2026-11-13-quiz-night.json', 'h:notices/council-statement.json', 'p:p1', 'r:0', 's:a-2026-11']);
const quiz = { id: 'K1-n2', where: "Coming up – Liz's Quiz and pub night", quote: 'Tickets from Fran.', problem: 'No contact for Fran.', suggestion: 'Add a contact.' };
assert.equal(fix.candidates(quiz, all)[0].key, 'h:events/2026-11-13-quiz-night.json');
const ladies = { where: 'Regular activities – Tuesday', quote: 'Lenches Ladies · 7.15pm (2nd Tuesday of the month, September to July)', problem: 'No place.' };
assert.equal(fix.candidates(ladies, all)[0].key, 'r:0');
assert.equal(all.find((s) => s.key === 'p:p1').fields.body, 'Stalls from 10am to 4pm at the hall, entry free.');

// checkProposal
const cands = fix.candidates(quiz, all);
const q = 'h:events/2026-11-13-quiz-night.json';
assert.match(fix.checkProposal({ source: q, field: 'body', new_value: 'Teams of up to six, 7.30pm. Tickets from Fran on 01386 123456.' }, cands, '').reason, /added details nobody gave her \(01386 123456\)/);
const ok = fix.checkProposal({ source: q, field: 'body', new_value: 'Teams of up to six, 7.30pm. Tickets from Fran on 01386 123456.', reason: 'Added the number Jon gave.' }, cands, "Fran's number is 01386 123456");
assert.equal(ok.ok, true);
assert.equal(ok.old, 'Teams of up to six, 7.30pm. Tickets from Fran.');
assert.match(fix.checkProposal({ cannot: 'Needs a contact number for Fran.' }, cands, '').reason, /Needs a contact number/);
assert.match(fix.checkProposal({ source: 'h:events/other.json', field: 'body', new_value: 'x' }, cands, '').reason, /did not pick/);
assert.match(fix.checkProposal({ source: q, field: 'date', new_value: 'x' }, cands, '').reason, /no "date" text/);
const official = all.filter((s) => s.key === 'h:notices/council-statement.json');
assert.equal(fix.checkProposal({ source: official[0].key, field: 'body', new_value: 'The council has agreed the budget for next year.' }, official, '').ok, true);
assert.match(fix.checkProposal({ source: official[0].key, field: 'body', new_value: 'The council has now agreed next year\'s budget after a long debate.' }, official, '').reason, /official statement/);
assert.deepEqual(fix.newFacts('From 7.30pm', 'From 7.30pm, email a@b.org or see www.x.org', ''), ['a@b.org', 'www.x.org']);

// propose and apply with mocks
const sheet = [
  { _row: 2, id: 'K1-n2', status: 'open', scope: 'newsletter', ...quiz, fix_status: 'asked', fix_note: "Fran's number is 01386 123456" },
  { _row: 3, id: 'K1-n5', status: 'open', scope: 'newsletter', ...ladies, fix_status: 'asked', fix_note: 'It meets at The Lenches Club' },
  { _row: 4, id: 'K1-p1', status: 'open', scope: 'listings', where: 'Craft fair', quote: 'Stalls from 10am to 4pm', problem: 'typo', fix_status: 'asked', fix_note: '' },
];
const updates = [];
const g = {
  readTable: async (tab) => (tab === 'Pending' ? pending : sheet),
  updateRow: async (tab, r, fields) => {
    updates.push([tab, r, fields]);
    const t = tab === 'Pending' ? pending : sheet;
    Object.assign(t.find((x) => x._row === r), fields);
  },
};
const answers = {
  'K1-n2': { source: q, field: 'body', new_value: 'Teams of up to six, 7.30pm. Tickets from Fran on 01386 123456.', reason: 'Added the number.' },
  'K1-n5': { source: 'r:0', field: 'where', new_value: 'The Lenches Club', reason: 'Added the place.' },
  'K1-p1': { source: 'p:p1', field: 'body', new_value: 'Stalls from 10am to 4pm at the village hall, entry free.', reason: 'Clearer.' },
};
let current = '';
const client = { messages: { create: async (req) => {
  const sent = JSON.parse(req.messages[0].content[0].text);
  assert.ok(sent.instruction);
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'propose_fix', input: answers[current] }] };
} } };

(async () => {
  current = 'K1-n2';
  assert.equal((await fix.propose('K1-n2', { g, client, root })).ok, true);
  assert.equal(sheet[0].fix_status, 'proposed');
  assert.equal(sheet[0].fix_new, 'Teams of up to six, 7.30pm. Tickets from Fran on 01386 123456.');
  // Regulars has no "where" yet: Holly may fill the empty field in.
  current = 'K1-n5';
  const r5 = await fix.propose('K1-n5', { g, client, root });
  assert.equal(r5.ok, true);
  assert.equal(sheet[1].fix_old, '');
  sheet[1].fix_status = 'applying';
  assert.equal((await fix.apply('K1-n5', { g, root })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'src/items/regulars.json'), 'utf8')).regulars[0].where, 'The Lenches Club');
  // Holly may not fill a field with details nobody gave (Jon's note had none).
  current = 'K1-n5';
  Object.assign(sheet[1], { status: 'open', fix_status: 'asked', fix_note: '' });
  answers['K1-n5'] = { source: 'r:0', field: 'phone', new_value: '01386 999999' };
  assert.equal((await fix.propose('K1-n5', { g, client, root })).ok, false);
  assert.equal(sheet[1].fix_status, 'cannot');
  current = 'K1-p1';
  assert.equal((await fix.propose('K1-p1', { g, client, root })).ok, true);

  // Apply: repo file, layout kept elsewhere
  sheet[0].fix_status = 'applying';
  process.env.GITHUB_OUTPUT = path.join(root, 'out.txt');
  assert.equal((await fix.apply('K1-n2', { g, root })).ok, true);
  const ev = JSON.parse(fs.readFileSync(path.join(root, 'src/items/events/2026-11-13-quiz-night.json'), 'utf8'));
  assert.equal(ev.body, 'Teams of up to six, 7.30pm. Tickets from Fran on 01386 123456.');
  assert.equal(sheet[0].status, 'fixed');
  assert.equal(sheet[0].fix_status, 'applied');
  // Apply: Pending cell, then Publish
  sheet[2].fix_status = 'applying';
  assert.equal((await fix.apply('K1-p1', { g, root })).ok, true);
  assert.equal(pending[0].summary, 'Stalls from 10am to 4pm at the village hall, entry free.');
  assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), /commit=true\n(commit=true\n)?publish=true/);
  // Stale: the text changed since the proposal
  sheet[1].status = 'open';
  fs.writeFileSync(process.env.GITHUB_OUTPUT, '');
  Object.assign(sheet[1], { fix_status: 'applying', fix_source: 'b:bin', fix_field: 'bin', fix_old: 'Something else', fix_new: 'New' });
  assert.equal((await fix.apply('K1-n5', { g, root })).ok, false);
  assert.equal(sheet[1].fix_status, 'failed');
  // writeRepoField keeps a file's own layout when the old text is unique
  put('src/items/regulars.json', null, '{"_help": "x",\n  "regulars": [ {"day": "Tuesday", "time": "7.15pm", "what": "Lenches Ladies"} ]\n}\n');
  const regs = { file: 'src/items/regulars.json', path: ['regulars', 0] };
  fix.writeRepoField(regs, 'time', '7.15pm', '7.30pm', root);
  assert.equal(fs.readFileSync(path.join(root, 'src/items/regulars.json'), 'utf8'), '{"_help": "x",\n  "regulars": [ {"day": "Tuesday", "time": "7.30pm", "what": "Lenches Ladies"} ]\n}\n');
  assert.throws(() => fix.writeRepoField(regs, 'time', '7.15pm', '8pm', root), /changed since/);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('rimmer fix: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
