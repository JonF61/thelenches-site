// scripts/rimmer/fix.js
// Fix… on one of Rimmer's findings (3 Nov, Jon). Two steps, each through decide() from the panel
// (actions rfix / rfix_ok) and rimmer-fix.yml:
//   propose  finds where the finding's words live (hand-written events and notices, Regular
//            activities, Where to eat, Local trades, website updates, the bin line, and published
//            submissions in the Pending tab), asks Holly for the new text of ONE field, checks it
//            (no new phone numbers, addresses, links or figures unless Jon typed them; official
//            statements only lightly corrected) and writes the proposal to the finding's row
//            (fix_status proposed, or "cannot" with the reason).
//   apply    re-checks that the field still holds what Holly saw, writes the new text (a repo file,
//            committed by the workflow, which then runs the site build; or a Pending cell, after
//            which the workflow runs Publish) and marks the finding fixed.
// Jon's instruction is read from the row's fix_note (written by the panel), never from env.
// Logs print the source kind and counts only (logs are public).
'use strict';

const fs = require('fs');
const path = require('path');
const { callTool } = require('../ingest/toolcall');
const rimmer = require('./index');

const ROOT = path.join(__dirname, '..', '..');
const { TAB, str, clip, ukStamp } = rimmer;
const MODEL = () => process.env.HOLLY_MODEL || 'claude-opus-5-5';
const MAX_CANDIDATES = 6;
const MAX_OFFICIAL_EDITS = 12;

const FILES = {
  events: 'src/items/events', notices: 'src/items/notices', regulars: 'src/items/regulars.json', bin: 'src/items/bin-and-footnote.json',
  eat: 'src/_data/eat.json', trades: 'src/_data/trades.json', siteupdates: 'src/_data/siteupdates.json', pipeline: 'src/_data/pipeline.json',
};
const ITEM_FIELDS = ['title', 'body'];
const REGULAR_FIELDS = ['what', 'where', 'time', 'note', 'frequency', 'about', 'runBy', 'forWho', 'cost', 'booking', 'bring', 'phone', 'email'];
const EAT_FIELDS = ['where', 'type', 'food', 'phone', 'note'];
const TRADE_FIELDS = ['what', 'covers', 'base', 'contact', 'phone', 'phone2', 'email', 'other'];
const PENDING_FIELDS = { title: 'title', body: 'summary' };

const readJson = (rel, root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
// The editable text fields of an entry. With empty = true, allowed fields it lacks are offered as ""
// so Holly can fill one in (e.g. a regular activity's missing place).
const pick = (o, fields, empty = false) => Object.fromEntries(fields
  .filter((f) => (typeof o[f] === 'string' && o[f].trim()) || (empty && (o[f] === undefined || o[f] === '')))
  .map((f) => [f, typeof o[f] === 'string' ? o[f] : '']));
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));

/* ---------------------------------------------------------- sources -- */

// Every editable unit: { key, kind, label, fields: { name: text }, official, where (file or row) }.
function sources({ root = ROOT, pending = [] } = {}) {
  const out = [];
  for (const kind of ['events', 'notices']) {
    const dir = path.join(root, FILES[kind]);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let o;
      try { o = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      out.push({ key: `h:${kind}/${file}`, kind, label: `${kind === 'events' ? 'Event' : 'Notice'}: ${str(o.title)}`, fields: pick(o, ITEM_FIELDS), official: truthy(o.official), file: `${FILES[kind]}/${file}` });
    }
  }
  const tryRead = (rel) => { try { return readJson(rel, root); } catch { return null; } };
  const regs = tryRead(FILES.regulars);
  ((regs && regs.regulars) || []).forEach((r, i) => out.push({ key: `r:${i}`, kind: 'regulars', label: `Regular activity: ${str(r.what)}${r.day ? ` (${r.day})` : ''}`, fields: pick(r, REGULAR_FIELDS, true), file: FILES.regulars, path: ['regulars', i] }));
  const eat = tryRead(FILES.eat);
  ((eat && eat.places) || []).forEach((p, i) => out.push({ key: `e:${str(p.id) || i}`, kind: 'eat', label: `Where to eat: ${str(p.name)}`, fields: pick(p, EAT_FIELDS, true), file: FILES.eat, path: ['places', i] }));
  const trades = tryRead(FILES.trades);
  ((trades && trades.trades) || []).forEach((t, i) => out.push({ key: `t:${str(t.id) || i}`, kind: 'trades', label: `Local trades: ${str(t.name)}`, fields: pick(t, TRADE_FIELDS, true), file: FILES.trades, path: ['trades', i] }));
  const su = tryRead(FILES.siteupdates);
  ((su && su.entries) || []).forEach((e, i) => out.push({ key: `s:${str(e.key)}`, kind: 'siteupdates', label: `Website update: ${str(e.key)}`, fields: pick(e, ['text']), file: FILES.siteupdates, path: ['entries', i] }));
  const bin = tryRead(FILES.bin);
  if (bin && typeof bin.bin === 'string') out.push({ key: 'b:bin', kind: 'bin', label: 'Bin line', fields: { bin: bin.bin }, file: FILES.bin, path: [] });
  // Published submissions: the ids in pipeline.json, edited in their Pending row (Publish rebuilds the file).
  const pipe = tryRead(FILES.pipeline);
  const ids = new Set([...((pipe && pipe.events) || []), ...((pipe && pipe.notices) || [])].map((x) => str(x.id)).filter(Boolean));
  for (const r of pending) {
    if (!ids.has(str(r.id))) continue;
    const fields = {};
    for (const [shown, col] of Object.entries(PENDING_FIELDS)) if (str(r[col])) fields[shown] = String(r[col]);
    out.push({ key: `p:${str(r.id)}`, kind: 'pending', label: `Submission: ${str(r.title)} (Pending row ${r._row})`, fields, official: truthy(r.official), row: r._row });
  }
  return out;
}

const words = (t) => new Set(str(t).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9£@.]+/).filter((w) => w.length >= 3));
const flat = (t) => str(t).toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');

// The likeliest sources for a finding: its quoted words verbatim first, then shared words.
function candidates(finding, all, n = MAX_CANDIDATES) {
  const quote = flat(finding.quote);
  const want = words(`${finding.quote} ${finding.where}`);
  return all.map((s) => {
    const text = Object.values(s.fields).join(' \n ');
    const have = words(`${s.label} ${text}`);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (quote.length >= 6 && flat(text).includes(quote)) score += 50;
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.s);
}

/* ----------------------------------------------------------- Holly -- */

const KIND_WORDS = { h: 'event or notice', r: 'regular activity', e: 'Where to eat', t: 'Local trades', s: 'website update', b: 'bin line', p: 'submission' };

const SYSTEM = `You are Holly, who writes the listings for a small community website and weekly
newsletter for the Lenches villages in Worcestershire. Rimmer, a reviewer, has flagged a problem.
Propose ONE change to ONE field of ONE of the candidate entries you are given that fixes it, or
say you cannot.
Rules:
- Change as little as possible: keep the rest of the field word for word. A field shown as
  "" is empty and may be filled in, if that fixes the problem.
- Facts only from the field itself or from the instruction the person who runs the site typed
  ("instruction"). Never invent or guess a name, phone number, email address, link, date, time,
  price or place. If the fix needs a fact you were not given (e.g. a contact number), answer
  cannot and say what is needed, so the person can type it in.
- Entries marked official are statements from councils and other official bodies: only obvious
  typos may be corrected; otherwise answer cannot.
- Do not fix a problem that is not in the entries given (e.g. it comes from the page layout):
  answer cannot and say it needs Kryten (the developer).
- British English, plain words, the same style as the entry.`;

const TOOL = {
  name: 'propose_fix',
  description: 'The one change that fixes the finding, or why it cannot be fixed here.',
  input_schema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'The key of the candidate entry to change.' },
      field: { type: 'string', description: 'The field to change.' },
      new_value: { type: 'string', description: 'The whole new text of that field.' },
      reason: { type: 'string', description: 'One sentence: what changed and why.' },
      cannot: { type: 'string', description: 'If no safe fix: why, and what the person should type or who should fix it.' },
    },
  },
};

function fixRequest(finding, note, cands) {
  const user = JSON.stringify({
    finding: { where: finding.where, page: finding.page, problem: finding.problem, quote: finding.quote, suggestion: finding.suggestion },
    instruction: note || '(none: use the suggestion if it needs no new facts)',
    candidates: cands.map((c) => ({ key: c.key, label: c.label, official: !!c.official, fields: c.fields })),
  }, null, 1);
  return { model: MODEL(), max_tokens: 8000, system: SYSTEM, tools: [TOOL], messages: [{ role: 'user', content: user }] };
}

// Phone numbers, emails, links and other figures in the new text that are not in the old text or
// Jon's instruction: Holly may not add facts.
function newFacts(oldText, newText, note) {
  const known = `${oldText} ${note}`.toLowerCase().replace(/\s+/g, '');
  const tokens = String(newText).match(/[^\s@]+@[^\s@]+\.[a-z]{2,}|https?:\/\/\S+|www\.\S+|\+?\d[\d ()-]{5,}\d|\d+(?:[.:]\d+)?/gi) || [];
  return tokens.map((t) => t.replace(/[.,;)]+$/, '')).filter((t) => !known.includes(t.toLowerCase().replace(/\s+/g, '')));
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > MAX_OFFICIAL_EDITS) return MAX_OFFICIAL_EDITS + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Holly's answer -> { ok, source, field, old, new, reason } or { ok: false, reason }.
function checkProposal(input, cands, note) {
  const i = input || {};
  if (str(i.cannot) && !str(i.new_value)) return { ok: false, reason: clip(i.cannot, 400) };
  const c = cands.find((x) => x.key === str(i.source));
  if (!c) return { ok: false, reason: 'Holly did not pick one of the entries found. Try Fix again with an instruction, or send it to Kryten.' };
  const field = str(i.field);
  if (!Object.prototype.hasOwnProperty.call(c.fields, field)) return { ok: false, reason: `That entry has no "${field}" text to change.` };
  const old = c.fields[field];
  const neu = String(i.new_value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  if (!neu || neu.length > 2000) return { ok: false, reason: 'Holly gave no usable new text.' };
  if (neu === old.trim()) return { ok: false, reason: 'Holly found nothing to change in that entry.' };
  const added = newFacts(old, neu, note);
  if (added.length) return { ok: false, reason: `Holly would have added details nobody gave her (${added.slice(0, 3).join(', ')}). Type the right details in the Fix box and try again.` };
  if (c.official && editDistance(old, neu) > MAX_OFFICIAL_EDITS) return { ok: false, reason: 'This is an official statement: it stays in its own words (only typos are corrected).' };
  return { ok: true, source: c.key, label: c.label, field, old, new: neu, reason: clip(i.reason, 300) };
}

/* ----------------------------------------------------------- write -- */

// Sets one string field in a repo JSON file, keeping the file's own layout where the old text is
// unique in it; otherwise rewrites it with 2-space JSON.
function writeRepoField(src, field, oldText, newText, root = ROOT) {
  const file = path.join(root, src.file);
  const text = fs.readFileSync(file, 'utf8');
  const o = JSON.parse(text);
  let target = o;
  for (const k of src.path || []) target = target[k];
  if (!target || (target[field] ?? '') !== oldText) throw new Error('changed since Holly looked');
  const from = JSON.stringify(oldText);
  if (oldText && text.split(from).length === 2) {
    fs.writeFileSync(file, text.replace(from, () => JSON.stringify(newText)));
  } else {
    target[field] = newText;
    fs.writeFileSync(file, `${JSON.stringify(o, null, 2)}\n`);
  }
}

/* ------------------------------------------------------------- run -- */

function output(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

async function findRow(g, id) {
  const rows = await g.readTable(TAB);
  const matches = rows.filter((r) => str(r.id) === id);
  if (matches.length !== 1) throw new Error(`${matches.length ? 'More than one' : 'No'} ${TAB} row with id ${id}`);
  return matches[0];
}

async function propose(id, { g, client, root = ROOT }) {
  const row = await findRow(g, id);
  if (str(row.status) !== 'open') { console.log(`Finding ${id} is ${str(row.status)}: nothing to do.`); return null; }
  const note = clip(row.fix_note, 600);
  const all = sources({ root, pending: await g.readTable('Pending') });
  const cands = candidates(row, all);
  let result;
  if (!cands.length) {
    result = { ok: false, reason: 'No listing, regular activity or website update holds these words: it may come from a page template or the layout. Send it to Kryten.' };
  } else {
    const { res, block } = await callTool(client, fixRequest(row, note, cands), TOOL.name);
    result = block && res.stop_reason !== 'max_tokens' ? checkProposal(block.input, cands, note) : { ok: false, reason: 'Holly gave no answer. Try Fix again.' };
  }
  await g.updateRow(TAB, row._row, result.ok
    ? { fix_status: 'proposed', fix_source: result.source, fix_label: result.label, fix_field: result.field, fix_old: result.old, fix_new: result.new, fix_reason: result.reason }
    : { fix_status: 'cannot', fix_source: '', fix_label: '', fix_field: '', fix_old: '', fix_new: '', fix_reason: result.reason });
  console.log(`Rimmer fix ${id}: ${cands.length} candidate(s); ${result.ok ? `proposed a change (${KIND_WORDS[result.source.split(":")[0]]})` : 'no safe fix'}.`);
  return result;
}

async function apply(id, { g, root = ROOT }) {
  const row = await findRow(g, id);
  if (str(row.fix_status) !== 'applying' || str(row.status) !== 'open') { console.log(`Finding ${id}: no fix waiting to apply.`); return null; }
  const key = str(row.fix_source);
  const field = str(row.fix_field);
  const fail = async (why) => {
    await g.updateRow(TAB, row._row, { fix_status: 'failed', fix_reason: why });
    console.log(`Rimmer fix ${id}: not applied (${why}).`);
    return { ok: false, reason: why };
  };
  if (key.startsWith('p:')) {
    const col = PENDING_FIELDS[field];
    const target = (await g.readTable('Pending')).find((r) => str(r.id) === key.slice(2));
    if (!col || !target) return fail('the submission is no longer in Pending');
    if (String(target[col] ?? '') !== String(row.fix_old ?? '')) return fail('it has changed since Holly looked: tap Fix again');
    await g.updateRow('Pending', target._row, { [col]: row.fix_new });
    output('publish', 'true');
  } else {
    const src = sources({ root }).find((s) => s.key === key);
    if (!src || src.kind === 'pending') return fail('the entry no longer exists');
    if (!Object.prototype.hasOwnProperty.call(src.fields, field) || src.fields[field] !== String(row.fix_old ?? '')) return fail('it has changed since Holly looked: tap Fix again');
    try { writeRepoField(src, field, row.fix_old, row.fix_new, root); } catch (e) { return fail(e.message); }
    output('commit', 'true');
  }
  await g.updateRow(TAB, row._row, { status: 'fixed', fix_status: 'applied', fixed_at: ukStamp(Date.now()) });
  console.log(`Rimmer fix ${id}: applied (${KIND_WORDS[key.split(":")[0]]}).`);
  return { ok: true };
}

async function main() {
  let p = {};
  if (process.env.GITHUB_EVENT_PATH) {
    try { p = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).client_payload || {}; } catch { p = {}; }
  }
  const id = str(p.id || process.env.FINDING_ID);
  const action = str(p.action || process.env.FIX_ACTION);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Bad finding id');
  const g = require('../ingest/google');
  if (action === 'apply') {
    try {
      return await apply(id, { g });
    } catch (e) {
      const row = await findRow(g, id).catch(() => null);
      if (row && str(row.fix_status) === 'applying') await g.updateRow(TAB, row._row, { fix_status: 'failed', fix_reason: 'Something went wrong while applying it. Try again.' });
      throw e;
    }
  }
  if (action !== 'propose') throw new Error(`Unknown action "${action}"`);
  const Anthropic = require('@anthropic-ai/sdk');
  try {
    return await propose(id, { g, client: new Anthropic({ maxRetries: 2, timeout: 300000 }) });
  } catch (e) {
    const row = await findRow(g, id).catch(() => null);
    if (row) await g.updateRow(TAB, row._row, { fix_status: 'cannot', fix_reason: 'Something went wrong while Holly was looking. Try Fix again.' });
    throw e;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { sources, candidates, fixRequest, checkProposal, newFacts, editDistance, writeRepoField, propose, apply, SYSTEM, TOOL, PENDING_FIELDS };
