// worker/test/entryedit.test.mjs
// Offline tests for admin/entryedit.js ("edit everything", 4 Nov): entry keys, what can change
// (wording and links only, never official statements), the stale check, the save through decide()
// (entryedit -> entry-edit.yml, the changes in the body), the run status, the draft editor page,
// and that its rules match scripts/entryedit (which re-checks every save).
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  parseKey, entryView, checkChanges, cleanText, cleanLink, checkText, readEntry, entryInfo, saveEntry, editRunState,
  draftEditHtml, draftEditCsp, pendingBodyColumn, pageFor,
} from '../src/admin/entryedit.js';
import { validPayload, dispatchFor, PANEL_ONLY } from '../src/core.js';

const require = createRequire(import.meta.url);
const script = require('../../scripts/entryedit/index.js');

const EVENT = { date: '2026-11-13', title: 'Quiz night', body: 'Teams of six, 7.30pm.', link: { text: 'Book', url: 'https://x.org/b' } };
const files = {
  'src/items/events/2026-11-13-quiz.json': EVENT,
  'src/items/notices/council.json': { title: 'Council', body: 'Met.', official: true },
  'src/items/regulars.json': { regulars: [{ day: 'Tuesday', time: '7pm', what: 'Ladies', where: 'Hall' }] },
  'src/_data/eat.json': { places: [{ id: 'boot-inn', name: 'Boot Inn', type: 'Pub', where: 'Flyford' }] },
  'src/_data/trades.json': { trades: [{ id: 'sparks', name: 'Sparks', trade: 'Electrician', phone: '01386 000000' }] },
};
const read = async (env, p) => {
  if (!(p in files)) throw Object.assign(new Error('nf'), { status: 404 });
  return { text: JSON.stringify(files[p]), sha: 'x' };
};
const PENDING = [
  { id: 'p1', status: 'approved', title: 'Fair', summary: 'Stalls.', link_text: '', link_url: '', category: 'event' },
  { id: 'p2', status: 'pending', title: 'Waiting', summary: 'S.' },
  { id: 'p3', status: 'auto', title: 'Statement', summary: 'S.', official: 'TRUE' },
];
const table = async () => ({ headers: [], rows: PENDING });
const deps = { read, table };

test('parseKey takes only the source keys, never a path outside src/items', () => {
  assert.deepEqual(parseKey('h:events/2026-11-13-quiz.json'), { kind: 'events', file: 'src/items/events/2026-11-13-quiz.json' });
  assert.equal(parseKey('r:3').index, 3);
  assert.equal(parseKey('e:boot-inn').id, 'boot-inn');
  assert.equal(parseKey('t:sparks').kind, 'trades');
  assert.equal(parseKey('p:1a1a-4').id, '1a1a-4');
  for (const bad of ['h:events/../x.json', 'h:events/a/b.json', 'h:pages/x.json', 's:key', 'b:bin', 'p:a b', '', 'r:x']) assert.equal(parseKey(bad), null, bad);
});

test('entryView: the values the edit box shows, links as JSON, submissions from the column they publish', () => {
  const v = entryView(parseKey('h:events/2026-11-13-quiz.json'), EVENT);
  assert.equal(v.label, 'Event: Quiz night');
  assert.equal(v.values.body, EVENT.body);
  assert.equal(v.values.link, JSON.stringify(EVENT.link));
  assert.equal(v.values.link2, '');
  assert.equal(v.page, '/events/');
  assert.equal(pendingBodyColumn({ own_text: 'Mine', verbatim_requested: 'TRUE' }), 'own_text');
  assert.equal(pendingBodyColumn({ own_text: 'Mine', verbatim_requested: 'TRUE', wording: 'rewrite' }), 'summary');
  assert.equal(pendingBodyColumn({ summary: 'x' }), 'summary');
  assert.equal(entryView(parseKey('p:p9'), { title: 'T', summary: 'R', own_text: 'O', wording: 'own' }).values.body, 'O');
  assert.equal(pageFor('notices', { roads: true }), '/living-here/roads/');
  assert.equal(pageFor('pending', { link_url: 'https://one.network/x' }), '/living-here/roads/');
  assert.equal(pageFor('pending', { category: 'notice' }), '/notices/');
  assert.equal(entryView(parseKey('r:0'), { what: 'Ladies', day: 'Tuesday' }).label, 'Regular activity: Ladies (Tuesday)');
});

test('checkChanges: stale, official, titles and dates refused; unchanged skipped; text and links cleaned', () => {
  const p = parseKey('h:events/2026-11-13-quiz.json');
  const v = entryView(p, EVENT);
  assert.equal(checkChanges(p, v, [{ field: 'body', old: 'Something else', new: 'x' }]).status, 409);
  assert.equal(checkChanges(p, v, [{ field: 'title', old: 'Quiz night', new: 'x' }]).status, 400);
  assert.equal(checkChanges(p, v, [{ field: 'date', old: '2026-11-13', new: '2026-11-14' }]).status, 400);
  assert.equal(checkChanges(p, v, []).status, 400);
  assert.equal(checkChanges(p, { ...v, official: true }, [{ field: 'body', old: v.values.body, new: 'x' }]).status, 403);
  assert.equal(checkChanges(p, v, [{ field: 'body', old: v.values.body, new: '  ' }]).status, 400);
  const ok = checkChanges(p, v, [{ field: 'body', old: v.values.body, new: v.values.body }, { field: 'link', old: v.values.link, new: { text: ' Book  now ', url: 'https://x.org/b' } }]);
  assert.deepEqual(ok, { ok: true, changes: [{ field: 'link', old: v.values.link, new: JSON.stringify({ text: 'Book now', url: 'https://x.org/b' }) }] });
  assert.equal(cleanText('body', 'a\r\n\r\n\r\n\r\nb\u0007c').value, 'a\n\nb c');
  assert.equal(cleanText('where', 'The\nhall').value, 'The hall');
  assert.equal(cleanText('note', '').value, '');
  assert.equal(cleanLink({ text: 'x', url: 'javascript:alert(1)' }).ok, false);
  assert.equal(cleanLink({ text: 'x', url: '' }).ok, false);
  assert.equal(cleanLink({ text: '', url: '' }).value, '');
  assert.equal(cleanLink(JSON.stringify({ text: 'Call', url: 'tel:01386 000000' })).ok, true);
  assert.equal(checkText(p, [{ field: 'body', new: 'First para here.\n\nSecond.' }]), 'First para here.');
  assert.equal(checkText(p, [{ field: 'link', new: JSON.stringify({ text: 'Book now', url: '/x' }) }]), 'Book now');
});

test('the rules match scripts/entryedit, which re-checks every save', () => {
  const samples = ['h:events/2026-11-13-quiz.json', 'h:events/../x.json', 'r:2', 'e:boot-inn', 't:x', 'p:abc', 'p:a/b', 's:x'];
  for (const k of samples) assert.equal(!!script.parseKey(k), !!parseKey(k), k);
  for (const [f, v] of [['body', 'a\r\n\r\n\r\nb'], ['where', ' a \n b '], ['body', ' '], ['about', 'x'.repeat(4001)], ['note', 'x'.repeat(601)]]) {
    assert.equal(script.cleanText(f, v).ok, cleanText(f, v).ok, `${f}`);
    if (cleanText(f, v).ok) assert.equal(script.cleanText(f, v).value, cleanText(f, v).value);
  }
  for (const l of ['', JSON.stringify({ text: 'a', url: 'https://x.org' }), JSON.stringify({ text: 'a', url: 'ftp://x' }), JSON.stringify({ text: '', url: 'https://x.org' })]) {
    assert.deepEqual(script.cleanLink(l), { ...cleanLink(l), ...(cleanLink(l).ok ? {} : { error: script.cleanLink(l).error }) });
  }
});

test('readEntry / entryInfo: from main or the Pending row; unpublished and missing entries refused', async () => {
  const info = await entryInfo({}, 't:sparks', deps);
  assert.equal(info.ok, true);
  assert.equal(info.label, 'Local trades: Sparks');
  assert.deepEqual(info.fields.find((f) => f.field === 'phone'), { field: 'phone', name: 'Phone', type: 'text', multiline: false, required: false, value: '01386 000000' });
  assert.equal(info.fields.some((f) => f.field === 'name' || f.field === 'trade'), false);
  assert.equal((await entryInfo({}, 'h:notices/council.json', deps)).official, true);
  assert.equal((await readEntry({}, 'h:events/2026-01-01-gone.json', deps)).status, 404);
  assert.equal((await readEntry({}, 'e:nowhere', deps)).status, 404);
  assert.equal((await readEntry({}, 'r:5', deps)).status, 404);
  assert.equal((await readEntry({}, 'p:p2', deps)).status, 409);
  assert.equal((await readEntry({}, 'p:p1', deps)).view.page, '/events/');
  assert.equal((await readEntry({}, 'x:y', deps)).status, 400);
});

test('saveEntry: one decide() entryedit with the changes in the body; the newsletter rebuild flagged when built', async () => {
  const sent = [];
  const send = async (env, p, reason, body) => { sent.push({ p, body }); return true; };
  const res = await saveEntry({}, { key: 'h:events/2026-11-13-quiz.json', changes: [{ field: 'body', old: EVENT.body, new: 'Teams of six, from 7.30pm.' }] },
    { deps, send, meta: { mode: 'frozen', status: 'tested', issue_date: '2026-11-05' }, now: Date.parse('2026-11-04T10:00:00Z') });
  assert.equal(res.ok, true);
  assert.match(res.id, /^ee[0-9a-f]{16}$/);
  assert.equal(res.rebuild, true);
  assert.equal(res.issue, '2026-11-05');
  assert.equal(res.page, '/events/');
  assert.equal(res.check, 'Teams of six, from 7.30pm.');
  assert.equal(sent.length, 1);
  const { p, body } = sent[0];
  assert.equal(p.a, 'entryedit');
  assert.equal(validPayload(p), true);
  assert.ok(PANEL_ONLY.includes('entryedit'));
  assert.deepEqual(JSON.parse(body), { key: 'h:events/2026-11-13-quiz.json', changes: [{ field: 'body', old: EVENT.body, new: 'Teams of six, from 7.30pm.' }] });
  assert.deepEqual(dispatchFor(p, '', body), ['entry-edit', { id: p.i, body }]);
  // The script reads exactly this payload.
  assert.equal(script.checkPayload(body).changes[0].new, 'Teams of six, from 7.30pm.');
  // A live draft: no rebuild. Nothing changed: no dispatch. GitHub refusing: an error, nothing saved.
  assert.equal((await saveEntry({}, { key: 'r:0', changes: [{ field: 'where', old: 'Hall', new: 'The hall' }] }, { deps, send, meta: { mode: 'live' } })).rebuild, false);
  const n = sent.length;
  assert.equal((await saveEntry({}, { key: 'r:0', changes: [{ field: 'where', old: 'Hall', new: 'Hall' }] }, { deps, send })).count, 0);
  assert.equal(sent.length, n);
  assert.equal((await saveEntry({}, { key: 'r:0', changes: [{ field: 'where', old: 'Hall', new: 'X' }] }, { deps, send: async () => false })).status, 502);
  assert.equal((await saveEntry({}, { key: 'p:p3', changes: [{ field: 'body', old: 'S.', new: 'T.' }] }, { deps, send })).status, 403);
  assert.equal(validPayload({ a: 'entryedit', i: 'ee1', b: 'x'.repeat(20001) }), false);
  assert.equal(validPayload({ a: 'entryedit', i: 'ee1' }), false);
});

test('editRunState: follows the entry-edit run named with the edit id', () => {
  const id = `ee${'0'.repeat(16)}`;
  const at = '2026-11-04T10:00:00Z';
  const now = Date.parse(at) + 60000;
  const run = (o) => ({ display_title: `Listing edit ${id}`, html_url: 'u', status: 'completed', conclusion: 'success', ...o });
  assert.deepEqual(editRunState([], id, at, now), { state: 'building', phase: 'saving' });
  assert.deepEqual(editRunState([], id, at, now + 20 * 60000), { state: 'failed' });
  assert.equal(editRunState([run({ status: 'in_progress', conclusion: null })], id, at, now).phase, 'saving');
  assert.equal(editRunState([run({})], id, at, now).state, 'done');
  assert.equal(editRunState([run({ conclusion: 'failure' })], id, at, now).state, 'failed');
  assert.equal(editRunState([run({ display_title: 'Listing edit ee1111111111111111' })], id, at, now).state, 'building');
});

test('draft editor page: the editor script from the Worker only, framed by the panel only', () => {
  const html = draftEditHtml('<!doctype html><html><head></head><body><p>Hi</p></body></html>', { origin: 'https://w.example', csrf: 'tok', version: '5' });
  assert.match(html, /<script src="https:\/\/w\.example\/admin\/pageedit\.js\?v=5" defer><\/script><\/body>/);
  const data = JSON.parse(html.match(/<script type="application\/json" id="lenches-edit-data">([^<]*)<\/script>/)[1]);
  assert.equal(data.mode, 'draft');
  assert.equal(data.entrySaveApi, 'https://w.example/admin/api/entry-save');
  const csp = draftEditCsp('https://w.example');
  assert.match(csp, /script-src https:\/\/w\.example;/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
});
