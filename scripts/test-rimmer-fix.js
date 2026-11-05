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
assert.match(fix.checkProposal({ source: q, field: 'expires', new_value: '2026-12-01' }, cands, '').reason, /no "expires" to change/);
assert.match(fix.checkProposal({ source: q, field: 'date', new_value: 'x' }, cands, '').reason, /no proper date/);
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
  const sent = JSON.parse(req.messages[0].content[0].text.split('\n\nCalendar:')[0]);
  assert.ok(sent.instruction);
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'propose_fix', input: answers[current] }] };
} } };

// Wider fixes (4 Nov): event dates (file renamed), notice expires, links, removing an entry.
async function wider() {
  const today = '2026-11-04';
  put('src/items/events/2026-11-29-handbell-concert.json', { date: '2026-11-29', title: 'Handbell concert — St Peter\'s, Church Lench', body: 'Handbells for Advent on Sunday 6 December, 3pm.', link: { text: 'Email the ringers', url: 'mailto:ring@example.org' } });
  put('src/items/notices/severn-trent-works.json', { title: 'Severn Trent works — Main Street', body: 'Pipe works on Main Street until Friday 13 November.', expires: '2026-12-31' });
  put('src/items/notices/council-closed.json', { title: 'Council office closed', body: 'Closed on 20 November. See www.council.example.gov.uk for more.', official: true, expires: '2026-11-21' });
  put('src/items/regulars.json', null, '{"_help": "x",\n  "regulars": [\n    { "day": "Monday", "what": "Yoga" },\n    { "day": "Tuesday", "what": "Lenches Ladies" }\n  ]\n}\n');
  const pend = [{ _row: 9, id: 'p9', title: 'Fireworks', summary: 'Fireworks at the Club. Tickets at www.lenchesclub.example.org/fireworks', link_text: 'Email the club', link_url: 'mailto:club@example.org', link2_text: '', link2_url: '' }];
  put('src/_data/pipeline.json', { events: [{ id: 'p9', title: 'Fireworks' }], notices: [] });
  const all = fix.sources({ root, pending: pend });
  const by = (k) => all.filter((s) => s.key === k);
  const hb = 'h:events/2026-11-29-handbell-concert.json';
  const st = 'h:notices/severn-trent-works.json';

  // Event date: only a date the entry (or Jon) gives; never past; file renamed on Apply.
  const d = fix.checkProposal({ source: hb, field: 'date', new_value: '2026-12-06', reason: 'The body says 6 December.' }, by(hb), '', { today });
  assert.equal(d.ok, true);
  assert.equal(d.old, '2026-11-29');
  assert.match(fix.checkProposal({ source: hb, field: 'date', new_value: '2026-12-13' }, by(hb), '', { today }).reason, /date nobody gave her \(2026-12-13\)/);
  assert.equal(fix.checkProposal({ source: hb, field: 'date', new_value: '2026-12-13' }, by(hb), 'It is now on 13th Dec', { today }).ok, true);
  assert.match(fix.checkProposal({ source: hb, field: 'date', new_value: '2026-11-01' }, by(hb), '1 November', { today }).reason, /passed/);
  assert.match(fix.checkProposal({ source: hb, field: 'endDate', new_value: '2026-11-20' }, by(hb), '20 Nov', { today }).reason, /before the first day/);
  // Notice expires: the first day hidden, so the day after a date in the text is fine; today hides it now.
  assert.equal(fix.checkProposal({ source: st, field: 'expires', new_value: '2026-11-14' }, by(st), '', { today }).ok, true);
  assert.equal(fix.checkProposal({ source: st, field: 'expires', new_value: today }, by(st), '', { today }).ok, true);
  assert.equal(fix.checkProposal({ source: st, field: 'expires', new_value: '2026-11-20' }, by(st), '', { today }).ok, false);
  assert.ok(fix.dateMentioned('2026-12-06', 'Sunday 6th Dec at 3pm'));
  assert.ok(fix.dateMentioned('2026-12-06', 'December 6'));
  assert.ok(fix.dateMentioned('2026-12-06', 'on 06/12/2026'));
  assert.ok(!fix.dateMentioned('2026-12-06', '16 December'));
  assert.ok(!fix.dateMentioned('2026-12-06', '6 decorations'));
  // Links: the address must be written in the entry or Jon's note; words checked for new figures.
  const pf = 'p:p9';
  const l = fix.checkProposal({ source: pf, field: 'link', link_text: 'Tickets on the club\'s website', link_url: 'https://www.lenchesclub.example.org/fireworks' }, by(pf), '', { today });
  assert.equal(l.ok, true);
  assert.deepEqual(JSON.parse(l.old), { text: 'Email the club', url: 'mailto:club@example.org' });
  assert.match(fix.checkProposal({ source: pf, field: 'link', link_text: 'Tickets', link_url: 'https://tickets.example.com/' }, by(pf), '', { today }).reason, /link nobody gave her/);
  assert.match(fix.checkProposal({ source: pf, field: 'link', link_text: 'Tickets', link_url: 'javascript:alert(1)' }, by(pf), '', { today }).reason, /no usable link/);
  assert.match(fix.checkProposal({ source: pf, field: 'link', link_text: '', link_url: 'https://www.lenchesclub.example.org/' }, by(pf), '', { today }).reason, /both its words/);
  assert.equal(fix.checkProposal({ source: hb, field: 'link', link_text: '', link_url: '' }, by(hb), '', { today }).new, '');
  // Official: words typos only, but a broken link may be fixed and an expired one removed.
  const oc = 'h:notices/council-closed.json';
  assert.equal(fix.checkProposal({ source: oc, field: 'link', link_text: 'Council website', link_url: 'https://www.council.example.gov.uk' }, by(oc), '', { today }).ok, true);
  // Remove: whole entries only where allowed, with a reason; never a submission or a website update.
  assert.equal(fix.checkProposal({ source: 'r:1', field: 'remove', reason: 'No longer meets.' }, by('r:1'), '', { today }).ok, true);
  assert.match(fix.checkProposal({ source: 'r:1', field: 'remove' }, by('r:1'), '', { today }).reason, /no reason/);
  assert.match(fix.checkProposal({ source: pf, field: 'remove', reason: 'x' }, by(pf), '', { today }).reason, /can be removed here/);
  assert.match(fix.checkProposal({ source: 's:a-2026-11', field: 'remove', reason: 'x' }, by('s:a-2026-11'), '', { today }).reason, /can be removed here/);

  // Apply each, through the Sheet row as the panel leaves it.
  const rows = [];
  let n = 0;
  const g2 = {
    readTable: async (tab) => (tab === 'Pending' ? pend : rows),
    updateRow: async (tab, r, f) => Object.assign((tab === 'Pending' ? pend : rows).find((x) => x._row === r), f),
  };
  const applyRow = async (res) => {
    n += 1;
    rows.push({ _row: 100 + n, id: `W${n}`, status: 'open', ...fix.fixFields(res), fix_status: 'applying' });
    const out = await fix.apply(`W${n}`, { g: g2, root });
    return [out, rows[rows.length - 1]];
  };
  let [out] = await applyRow(d);
  assert.equal(out.ok, true);
  assert.ok(!fs.existsSync(path.join(root, 'src/items/events/2026-11-29-handbell-concert.json')));
  const moved = JSON.parse(fs.readFileSync(path.join(root, 'src/items/events/2026-12-06-handbell-concert.json'), 'utf8'));
  assert.equal(moved.date, '2026-12-06');
  assert.equal(moved.link.url, 'mailto:ring@example.org');
  [out] = await applyRow(fix.checkProposal({ source: st, field: 'expires', new_value: '2026-11-14' }, by(st), '', { today }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'src/items/notices/severn-trent-works.json'), 'utf8')).expires, '2026-11-14');
  [out] = await applyRow(l);
  assert.equal(out.ok, true);
  assert.equal(pend[0].link_url, 'https://www.lenchesclub.example.org/fireworks');
  assert.equal(pend[0].link_text, 'Tickets on the club\'s website');
  // Stale: applying the same link change again finds the cells changed.
  let row;
  [out, row] = await applyRow(l);
  assert.equal(out.ok, false);
  assert.equal(row.fix_status, 'failed');
  // Remove a regular activity: only its line goes, the rest of the layout stays.
  [out] = await applyRow(fix.checkProposal({ source: 'r:1', field: 'remove', reason: 'No longer meets.' }, by('r:1'), '', { today }));
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/items/regulars.json'), 'utf8'), '{"_help": "x",\n  "regulars": [\n    { "day": "Monday", "what": "Yoga" }\n  ]\n}\n');
  // Remove a notice: the file goes. A changed entry is never removed.
  const rmOc = fix.checkProposal({ source: oc, field: 'remove', reason: 'It has passed.' }, by(oc), '', { today });
  put('src/items/notices/council-closed.json', { title: 'Council office closed', body: 'Changed.', official: true });
  [out] = await applyRow(rmOc);
  assert.equal(out.ok, false);
  assert.ok(fs.existsSync(path.join(root, 'src/items/notices/council-closed.json')));
  [out] = await applyRow(fix.checkProposal({ source: st, field: 'remove', reason: 'Works over.' }, fix.sources({ root }).filter((s) => s.key === st), '', { today }));
  assert.equal(out.ok, true);
  assert.ok(!fs.existsSync(path.join(root, 'src/items/notices/severn-trent-works.json')));
  // Remove a trade: the Worker is redeployed too.
  put('src/_data/trades.json', { trades: [{ id: 'a-plumber', name: 'A Plumber', trade: 'Plumbers' }, { id: 'b-builder', name: 'B Builder', trade: 'Builders' }] });
  fs.writeFileSync(process.env.GITHUB_OUTPUT, '');
  const tr = fix.sources({ root }).filter((s) => s.key === 't:a-plumber');
  [out] = await applyRow(fix.checkProposal({ source: 't:a-plumber', field: 'remove', reason: 'Retired.' }, tr, '', { today }));
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'src/_data/trades.json'), 'utf8')).trades.map((t) => t.id), ['b-builder']);
  assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), /worker=true/);
  // Apply all ticked (5 Nov): several fixes in one run, in turn against the files as the previous
  // one left them; two to the same entry both apply, a stale one fails, the rest still go.
  put('src/items/regulars.json', { regulars: [{ day: 'Monday', time: '9am', what: 'Yoga', where: 'Hall' }, { day: 'Friday', time: '7pm', what: 'Quizz', where: 'Club' }] });
  const batch = [
    ['B1', 'r:0', 'what', 'Yoga', 'Gentle yoga'],
    ['B2', 'r:0', 'time', '9am', '9.30am'],
    ['B3', 'r:1', 'what', 'Quiz night', 'Quiz'],
    ['B4', 'r:1', 'what', 'Quizz', 'Quiz'],
  ];
  for (const [id, src, field, old, nw] of batch) rows.push({ _row: 200 + rows.length, id, status: 'open', fix_status: 'applying', fix_source: src, fix_field: field, fix_old: old, fix_new: nw, fix_label: 'Regular' });
  fs.writeFileSync(process.env.GITHUB_OUTPUT, '');
  const many = await fix.applyMany(['B1', 'B2', 'B3', 'B4'], { g: g2, root });
  assert.deepEqual(many.map((r) => r.ok), [true, true, false, true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'src/items/regulars.json'), 'utf8')).regulars.map((r) => [r.time, r.what]), [['9.30am', 'Gentle yoga'], ['7pm', 'Quiz']]);
  assert.deepEqual(['B1', 'B2', 'B3', 'B4'].map((id) => rows.find((r) => r.id === id).fix_status), ['applied', 'applied', 'failed', 'applied']);
  assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), /commit=true/);
  // A finding no longer waiting is left alone.
  assert.deepEqual((await fix.applyMany(['B1'], { g: g2, root })).map((r) => r.ok), [false]);
  // Holly is told about dates, links and removing, with a calendar.
  const req = fix.fixRequest({ where: 'w', problem: 'p' }, '', by(hb.replace('2026-11-29', '2026-12-06')), today);
  assert.match(req.messages[0].content, /Calendar:\n/);
  assert.match(fix.SYSTEM, /"remove"/);
}

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

  // Rimmer's own run drafts fixes ("offered"); a finding with no entry costs no Claude call.
  const all2 = fix.sources({ root, pending });
  let calls = 0;
  const counting = { messages: { create: async (req) => { calls += 1; return client.messages.create(req); } } };
  current = 'K1-n2';
  const d1 = await fix.draftFix({ ...quiz }, { all: all2, client: counting, note: "Fran's number is 01386 123456" });
  assert.equal(d1.result.ok, true);
  assert.equal(fix.fixFields(d1.result, 'offered').fix_status, 'offered');
  const d2 = await fix.draftFix({ where: 'Footer', quote: 'zzqx wwvy', problem: 'Layout' }, { all: all2, client: counting });
  assert.equal(d2.result.ok, false);
  assert.equal(calls, 1);

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

  await wider();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('rimmer fix: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
