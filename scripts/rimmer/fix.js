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
//   apply_many  Apply all ticked (5 Nov, Jon): the same apply for each finding in turn, in one
//            checkout, so the workflow makes one commit and one site build (and at most one Publish).
//            One that fails is marked failed with its reason; the others still go ahead.
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
// Wider fixes (4 Nov, Jon): dates, links and removing a whole entry, each still one change Jon applies.
const DATE_FIELDS = { events: ['date', 'endDate'], notices: ['expires'] };
const LINK_FIELDS = ['link', 'link2'];
const PENDING_LINKS = { link: ['link_text', 'link_url'], link2: ['link2_text', 'link2_url'] };
const REMOVABLE = ['events', 'notices', 'regulars', 'eat', 'trades'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const LINK_RE = /^(https?:\/\/[^\s<>"]+\.[^\s<>"]+|mailto:[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}|tel:\+?[\d ]{6,}|\/[^\s<>"]*)$/i;

const readJson = (rel, root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
// The editable text fields of an entry. With empty = true, allowed fields it lacks are offered as ""
// so Holly can fill one in (e.g. a regular activity's missing place).
const pick = (o, fields, empty = false) => Object.fromEntries(fields
  .filter((f) => (typeof o[f] === 'string' && o[f].trim()) || (empty && (o[f] === undefined || o[f] === '')))
  .map((f) => [f, typeof o[f] === 'string' ? o[f] : '']));
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const ymdOr = (v) => (isYmd(str(v)) ? str(v) : '');
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const linkOf = (l) => (l && (str(l.url) || str(l.text)) ? { text: str(l.text), url: str(l.url) } : null);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now());

// What kind of change a field is: text, date, link or remove.
function typeOf(field) {
  if (field === 'remove') return 'remove';
  if (LINK_FIELDS.includes(field)) return 'link';
  if (['date', 'endDate', 'expires'].includes(field)) return 'date';
  return 'text';
}

/* ---------------------------------------------------------- sources -- */

// Every editable unit: { key, kind, label, fields: { name: text }, dates, links, removable, entry,
// official, where (file or row) }.
function sources({ root = ROOT, pending = [] } = {}) {
  const out = [];
  for (const kind of ['events', 'notices']) {
    const dir = path.join(root, FILES[kind]);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let o;
      try { o = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      out.push({
        key: `h:${kind}/${file}`, kind, label: `${kind === 'events' ? 'Event' : 'Notice'}: ${str(o.title)}`, fields: pick(o, ITEM_FIELDS),
        dates: Object.fromEntries(DATE_FIELDS[kind].map((f) => [f, ymdOr(o[f])])),
        links: { link: linkOf(o.link), link2: linkOf(o.link2) },
        removable: true, entry: o, official: truthy(o.official), file: `${FILES[kind]}/${file}`,
      });
    }
  }
  const tryRead = (rel) => { try { return readJson(rel, root); } catch { return null; } };
  const regs = tryRead(FILES.regulars);
  ((regs && regs.regulars) || []).forEach((r, i) => out.push({ key: `r:${i}`, kind: 'regulars', label: `Regular activity: ${str(r.what)}${r.day ? ` (${r.day})` : ''}`, fields: pick(r, REGULAR_FIELDS, true), removable: true, entry: r, file: FILES.regulars, path: ['regulars', i] }));
  const eat = tryRead(FILES.eat);
  ((eat && eat.places) || []).forEach((p, i) => out.push({ key: `e:${str(p.id) || i}`, kind: 'eat', label: `Where to eat: ${str(p.name)}`, fields: pick(p, EAT_FIELDS, true), removable: true, entry: p, file: FILES.eat, path: ['places', i] }));
  const trades = tryRead(FILES.trades);
  ((trades && trades.trades) || []).forEach((t, i) => out.push({ key: `t:${str(t.id) || i}`, kind: 'trades', label: `Local trades: ${str(t.name)}`, fields: pick(t, TRADE_FIELDS, true), removable: true, entry: t, file: FILES.trades, path: ['trades', i] }));
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
    const links = Object.fromEntries(Object.entries(PENDING_LINKS).map(([f, [t, u]]) => [f, linkOf({ text: r[t], url: r[u] })]));
    out.push({ key: `p:${str(r.id)}`, kind: 'pending', label: `Submission: ${str(r.title)} (Pending row ${r._row})`, fields, links, official: truthy(r.official), row: r._row });
  }
  return out;
}

// A field's current value as stored in the finding's fix_old (null: the entry has no such field).
// Links are JSON {text, url} ('' = none); remove is the whole entry as JSON, so Apply removes
// exactly what Holly saw.
function valueOf(src, field) {
  const t = typeOf(field);
  if (t === 'remove') return src.removable ? JSON.stringify(src.entry) : null;
  if (t === 'link') return has(src.links, field) ? (src.links[field] ? JSON.stringify(src.links[field]) : '') : null;
  if (t === 'date') return has(src.dates, field) ? src.dates[field] : null;
  return has(src.fields, field) ? src.fields[field] : null;
}

// Everything an entry says (its text, dates and links): facts Holly may move between its fields.
function entryText(src) {
  const parts = [...Object.values(src.fields || {}), ...Object.values(src.dates || {})];
  for (const l of Object.values(src.links || {})) if (l) parts.push(l.text, l.url);
  return parts.filter(Boolean).join(' \n ');
}

const words = (t) => new Set(str(t).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9£@.]+/).filter((w) => w.length >= 3));
const flat = (t) => str(t).toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');

// The likeliest sources for a finding: its quoted words verbatim first, then shared words.
function candidates(finding, all, n = MAX_CANDIDATES) {
  const quote = flat(finding.quote);
  const want = words(`${finding.quote} ${finding.where}`);
  return all.map((s) => {
    const text = entryText(s);
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
Propose ONE change to ONE of the candidate entries you are given that fixes it, or say you cannot.
The person who runs the site checks it and applies it.
The changes you can make:
- a text field in "fields": give "field" and the whole new text in "new_value". Change as little
  as possible: keep the rest of the field word for word. A field shown as "" is empty and may be
  filled in, if that fixes the problem.
- a date in "dates" (YYYY-MM-DD): "date" and "endDate" are an event's first and last day ("endDate"
  may be "" for a one-day event); "expires" is the FIRST day a notice is hidden (so the day after
  the last day it should show). Give the new date in "new_value". Use the calendar for weekdays.
- a link in "links" ("link", or "link2", the second link): give "field" and the new "link_text"
  (the words readers click) and "link_url" (https://…, mailto:…, tel:… or a site path like
  /churches/). Leave both empty to take the link off.
- field "remove": take the whole entry off the website, when it is over, a repeat of another
  entry, or should not be listed at all. Only for entries with "can_remove": true. Say why in
  "reason".
Rules:
- Facts only from the entry itself (any of its fields, dates or links) or from the instruction the
  person who runs the site typed ("instruction"). Never invent or guess a name, phone number,
  email address, link, date, time, price or place. If the fix needs a fact you were not given
  (e.g. a contact number or the right date), answer cannot and say what is needed, so the person
  can type it in.
- Entries marked official are statements from councils and other official bodies: their words may
  only have obvious typos corrected; otherwise answer cannot. Their dates and links may be fixed.
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
      field: { type: 'string', description: 'The field to change: a name from its fields, dates or links, or "remove".' },
      new_value: { type: 'string', description: 'A text field: its whole new text. A date: YYYY-MM-DD.' },
      link_text: { type: 'string', description: 'A link: the words readers click.' },
      link_url: { type: 'string', description: 'A link: its address.' },
      reason: { type: 'string', description: 'One sentence: what changed and why.' },
      cannot: { type: 'string', description: 'If no safe fix: why, and what the person should type or who should fix it.' },
    },
  },
};

const candidateView = (c) => ({
  key: c.key, label: c.label, official: !!c.official, fields: c.fields,
  ...(c.dates ? { dates: c.dates } : {}), ...(c.links ? { links: c.links } : {}), can_remove: !!c.removable,
});

function fixRequest(finding, note, cands, today = ukToday()) {
  const user = JSON.stringify({
    today,
    finding: { where: finding.where, page: finding.page, problem: finding.problem, quote: finding.quote, suggestion: finding.suggestion },
    instruction: note || '(none: use the suggestion if it needs no new facts)',
    candidates: cands.map(candidateView),
  }, null, 1);
  const cal = rimmer.calendar(today, 180, 14);
  return { model: MODEL(), max_tokens: 8000, system: SYSTEM, tools: [TOOL], messages: [{ role: 'user', content: `${user}\n\nCalendar:\n${cal}` }] };
}

// Phone numbers, emails, links and other figures in the new text that are not in the old text or
// Jon's instruction: Holly may not add facts.
function newFacts(oldText, newText, note) {
  const known = `${oldText} ${note}`.toLowerCase().replace(/\s+/g, '');
  const tokens = String(newText).match(/[^\s@]+@[^\s@]+\.[a-z]{2,}|https?:\/\/\S+|www\.\S+|\+?\d[\d ()-]{5,}\d|\d+(?:[.:]\d+)?/gi) || [];
  return tokens.map((t) => t.replace(/[.,;)]+$/, '')).filter((t) => !known.includes(t.toLowerCase().replace(/\s+/g, '')));
}

// Is this date written in the text (2026-12-06, 6 Dec, 6th December, December 6, 6/12)?
function dateMentioned(ymd, text) {
  if (!isYmd(ymd)) return false;
  const t = String(text).toLowerCase();
  if (t.includes(ymd)) return true;
  const [y, m, d] = ymd.split('-').map(Number);
  const mon = MONTHS[m - 1];
  const mo = `(?:${mon}|${mon.slice(0, 3)}${m === 9 ? '|sept' : ''})\\.?`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  return new RegExp(`(?:^|[^0-9])${day}\\s+(?:of\\s+)?${mo}(?![a-z])|${mo}\\s+${day}(?![0-9])|(?:^|[^0-9])0?${d}/0?${m}(?:/(?:${y}|${y % 100}))?(?![0-9])`).test(t);
}

// Is this link's address (or email, or number) written in the text?
function linkKnown(url, text) {
  const core = String(url).toLowerCase().replace(/^(https?:\/\/|mailto:|tel:)/, '').replace(/^www\./, '').replace(/\/+$/, '').replace(/\s+/g, '');
  return core.length >= 3 && String(text).toLowerCase().replace(/\s+/g, '').includes(core);
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

const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const ASK = 'Type the right details in the Fix box and try again.';

// Holly's answer -> { ok, source, label, field, old, new, reason } or { ok: false, reason }.
function checkProposal(input, cands, note, { today = ukToday() } = {}) {
  const i = input || {};
  const field = str(i.field);
  if (str(i.cannot) && !str(i.new_value) && !str(i.link_url) && field !== 'remove') return { ok: false, reason: clip(i.cannot, 400) };
  const c = cands.find((x) => x.key === str(i.source));
  if (!c) return { ok: false, reason: 'Holly did not pick one of the entries found. Try Fix again with an instruction, or send it to Kryten.' };
  const type = typeOf(field);
  const old = valueOf(c, field);
  if (old === null) {
    return { ok: false, reason: type === 'remove' ? 'Only events, notices, regular activities, places to eat and trades can be removed here.' : `That entry has no "${field}" to change.` };
  }
  const done = (neu) => ({ ok: true, source: c.key, label: c.label, field, old, new: neu, reason: clip(i.reason, 300) });
  const known = `${entryText(c)} \n ${note}`;

  if (type === 'remove') {
    if (!str(i.reason)) return { ok: false, reason: 'Holly gave no reason to take the entry off.' };
    return done('');
  }

  if (type === 'date') {
    const neu = str(i.new_value);
    if (!neu && field !== 'endDate') return { ok: false, reason: `Holly gave no ${field === 'expires' ? 'date to hide it from' : 'date'}.` };
    if (neu && !isYmd(neu)) return { ok: false, reason: 'Holly gave no proper date.' };
    if (neu === old) return { ok: false, reason: 'Holly found nothing to change in that entry.' };
    if (field !== 'expires') {
      if (neu && neu < today) return { ok: false, reason: 'That date has passed: to take the event off, remove it instead.' };
      const start = field === 'date' ? neu : c.dates.date;
      const end = field === 'endDate' ? neu : c.dates.endDate;
      if (start && end && end < start) return { ok: false, reason: 'The end date would be before the first day: both need changing. Send it to Kryten.' };
    }
    const fromText = neu && (dateMentioned(neu, known) || (field === 'expires' && (neu <= today || dateMentioned(addDays(neu, -1), known))));
    if (neu && !fromText) return { ok: false, reason: `Holly would have used a date nobody gave her (${neu}). ${ASK}` };
    return done(neu);
  }

  if (type === 'link') {
    const text = oneLine(i.link_text);
    const url = str(i.link_url);
    if (!text && !url) return old ? done('') : { ok: false, reason: 'Holly found nothing to change in that entry.' };
    if (!text || !url) return { ok: false, reason: 'A link needs both its words and its address.' };
    if (!LINK_RE.test(url) || url.length > 500) return { ok: false, reason: 'Holly gave no usable link address.' };
    if (text.length > 120) return { ok: false, reason: 'The link\'s words are too long.' };
    if (!linkKnown(url, known)) return { ok: false, reason: `Holly would have added a link nobody gave her (${clip(url, 80)}). ${ASK}` };
    const added = newFacts(entryText(c), text, note);
    if (added.length) return { ok: false, reason: `Holly would have added details nobody gave her (${added.slice(0, 3).join(', ')}). ${ASK}` };
    const neu = JSON.stringify({ text, url });
    if (neu === old) return { ok: false, reason: 'Holly found nothing to change in that entry.' };
    return done(neu);
  }

  const neu = String(i.new_value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  if (!neu || neu.length > 2000) return { ok: false, reason: 'Holly gave no usable new text.' };
  if (neu === old.trim()) return { ok: false, reason: 'Holly found nothing to change in that entry.' };
  const added = newFacts(old, neu, note);
  if (added.length) return { ok: false, reason: `Holly would have added details nobody gave her (${added.slice(0, 3).join(', ')}). ${ASK}` };
  if (c.official && editDistance(old, neu) > MAX_OFFICIAL_EDITS) return { ok: false, reason: 'This is an official statement: it stays in its own words (only typos are corrected).' };
  return done(neu);
}

// The Rimmer tab cells for Holly's result. status: "proposed" (Jon asked) or "offered" (drafted
// with Rimmer's own run; replaced by his next run like any open finding).
function fixFields(result, status = 'proposed') {
  return result.ok
    ? { fix_status: status, fix_source: result.source, fix_label: result.label, fix_field: result.field, fix_old: result.old, fix_new: result.new, fix_reason: result.reason }
    : { fix_status: 'cannot', fix_source: '', fix_label: '', fix_field: '', fix_old: '', fix_new: '', fix_reason: result.reason };
}

// Finds the entry and asks Holly for one change. { result, cands, usage }.
async function draftFix(finding, { all, note = '', client, today = ukToday() }) {
  const cands = candidates(finding, all);
  if (!cands.length) {
    return { cands, result: { ok: false, reason: 'No listing, regular activity or website update holds these words: it may come from a page template or the layout. Send it to Kryten.' } };
  }
  const { res, block } = await callTool(client, fixRequest(finding, note, cands, today), TOOL.name);
  const result = block && res.stop_reason !== 'max_tokens' ? checkProposal(block.input, cands, note, { today }) : { ok: false, reason: 'Holly gave no answer. Try Fix again.' };
  return { cands, result, usage: res && res.usage };
}

/* ----------------------------------------------------------- write -- */

// Writes `text` if it parses to exactly `expected` (a layout-keeping edit), else 2-space JSON.
function writeJson(file, expected, text) {
  let ok = false;
  try { ok = typeof text === 'string' && JSON.stringify(JSON.parse(text)) === JSON.stringify(expected); } catch { ok = false; }
  fs.writeFileSync(file, ok ? text : `${JSON.stringify(expected, null, 2)}\n`);
}

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

// Removes one entry from a list in a repo JSON file. Where the entry sits on a line of its own
// (Regular activities) only that line goes; otherwise the file is rewritten as 2-space JSON.
function removeArrayEntry(src, root = ROOT) {
  const file = path.join(root, src.file);
  const text = fs.readFileSync(file, 'utf8');
  const o = JSON.parse(text);
  const [listKey, idx] = src.path;
  const list = o[listKey];
  if (!Array.isArray(list) || JSON.stringify(list[idx]) !== JSON.stringify(src.entry)) throw new Error('changed since Holly looked');
  list.splice(idx, 1);
  const lines = text.split('\n');
  const same = (l) => { try { return JSON.stringify(JSON.parse(l.trim().replace(/,$/, ''))) === JSON.stringify(src.entry); } catch { return false; } };
  const at = lines.map((l, n) => (same(l) ? n : -1)).filter((n) => n >= 0);
  let tryText = null;
  if (at.length === 1) {
    const n = at[0];
    const out = lines.slice(0, n).concat(lines.slice(n + 1));
    if (!lines[n].trim().endsWith(',') && n > 0) out[n - 1] = out[n - 1].replace(/,\s*$/, '');
    tryText = out.join('\n');
  }
  writeJson(file, o, tryText);
}

// Sets (or, with '', deletes) a date or link of a hand-written event or notice. Moving an event's
// date renames its file to match (YYYY-MM-DD-slug.json); the file name must be free.
function writeItemField(src, field, newValue, root = ROOT) {
  const file = path.join(root, src.file);
  const text = fs.readFileSync(file, 'utf8');
  const o = JSON.parse(text);
  const type = typeOf(field);
  let tryText = null;
  if (type === 'date') {
    if (newValue) {
      if (typeof o[field] === 'string' && o[field]) tryText = text.replace(new RegExp(`("${field}"\\s*:\\s*)"${o[field]}"`), (m, a) => `${a}"${newValue}"`);
      o[field] = newValue;
    } else delete o[field];
  } else if (type === 'link') {
    const l = newValue ? JSON.parse(newValue) : null;
    if (l) o[field] = { ...(o[field] && typeof o[field] === 'object' ? o[field] : {}), text: l.text, url: l.url };
    else delete o[field];
  } else throw new Error(`cannot set ${field} here`);
  let dest = file;
  if (src.kind === 'events' && field === 'date') {
    const base = path.basename(file);
    if (/^\d{4}-\d{2}-\d{2}-/.test(base)) dest = path.join(path.dirname(file), `${newValue}${base.slice(10)}`);
    if (dest !== file && fs.existsSync(dest)) throw new Error(`there is already an event file called ${path.basename(dest)}`);
  }
  writeJson(dest, o, tryText);
  if (dest !== file) fs.unlinkSync(file);
  return path.relative(root, dest).split(path.sep).join('/');
}

// Writes one proposed change to the repo (the current value already checked by apply).
function writeRepoChange(src, field, oldValue, newValue, root = ROOT) {
  const type = typeOf(field);
  if (type === 'text') return writeRepoField(src, field, oldValue, newValue, root);
  if (type === 'remove') {
    if (src.kind === 'events' || src.kind === 'notices') return fs.unlinkSync(path.join(root, src.file));
    return removeArrayEntry(src, root);
  }
  if (src.kind !== 'events' && src.kind !== 'notices') throw new Error(`cannot set ${field} here`);
  return writeItemField(src, field, newValue, root);
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
  const { cands, result } = await draftFix(row, { all, note, client });
  await g.updateRow(TAB, row._row, fixFields(result));
  console.log(`Rimmer fix ${id}: ${cands.length} candidate(s); ${result.ok ? `proposed a change (${KIND_WORDS[result.source.split(':')[0]]}, ${typeOf(result.field)})` : 'no safe fix'}.`);
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
    const target = (await g.readTable('Pending')).find((r) => str(r.id) === key.slice(2));
    if (!target) return fail('the submission is no longer in Pending');
    const type = typeOf(field);
    if (type === 'text' && PENDING_FIELDS[field]) {
      const col = PENDING_FIELDS[field];
      if (String(target[col] ?? '') !== String(row.fix_old ?? '')) return fail('it has changed since Holly looked: tap Fix again');
      await g.updateRow('Pending', target._row, { [col]: row.fix_new });
    } else if (type === 'link' && PENDING_LINKS[field]) {
      const [tc, uc] = PENDING_LINKS[field];
      const cur = linkOf({ text: target[tc], url: target[uc] });
      if ((cur ? JSON.stringify(cur) : '') !== String(row.fix_old ?? '')) return fail('it has changed since Holly looked: tap Fix again');
      const l = str(row.fix_new) ? JSON.parse(row.fix_new) : { text: '', url: '' };
      await g.updateRow('Pending', target._row, { [tc]: l.text, [uc]: l.url });
    } else return fail('that change cannot be made to a submission');
    output('publish', 'true');
  } else {
    const src = sources({ root }).find((s) => s.key === key);
    if (!src || src.kind === 'pending') return fail('the entry no longer exists');
    const now = valueOf(src, field);
    if (now === null || now !== String(row.fix_old ?? '')) return fail('it has changed since Holly looked: tap Fix again');
    try { writeRepoChange(src, field, now, String(row.fix_new ?? ''), root); } catch (e) { return fail(e.message); }
    output('commit', 'true');
    // The Worker bundles trades.json and eat.json (Recommend, Suggest): redeploy it too.
    if (src.kind === 'eat' || src.kind === 'trades') output('worker', 'true');
  }
  await g.updateRow(TAB, row._row, { status: 'fixed', fix_status: 'applied', fixed_at: ukStamp(Date.now()) });
  console.log(`Rimmer fix ${id}: applied (${KIND_WORDS[key.split(':')[0]]}, ${typeOf(field)}).`);
  return { ok: true };
}

// Several fixes in one run: each applied in turn against the files as the previous one left them,
// so a second fix to the same entry still checks it holds what Holly saw.
async function applyMany(ids, { g, root = ROOT }) {
  const out = [];
  for (const id of ids) {
    try {
      out.push((await apply(id, { g, root })) || { ok: false, reason: 'no fix waiting' });
    } catch (e) {
      console.error(`Rimmer fix ${id}: error (${e && e.message ? e.message : e}).`);
      const row = await findRow(g, id).catch(() => null);
      if (row && str(row.fix_status) === 'applying') await g.updateRow(TAB, row._row, { fix_status: 'failed', fix_reason: 'Something went wrong while applying it. Try again.' }).catch(() => {});
      out.push({ ok: false, reason: 'error' });
    }
  }
  console.log(`Rimmer fixes: ${out.filter((r) => r.ok).length} of ${ids.length} applied.`);
  return out;
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
  if (action === 'apply_many') {
    const ids = (Array.isArray(p.ids) ? p.ids : []).map(str);
    if (!ids.length || ids.length > 20 || ids.some((x) => !/^[A-Za-z0-9_-]{1,100}$/.test(x)) || new Set(ids).size !== ids.length) throw new Error('Bad list of finding ids');
    return applyMany(ids, { g });
  }
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

module.exports = {
  sources, candidates, fixRequest, checkProposal, fixFields, draftFix, newFacts, dateMentioned, linkKnown, editDistance, valueOf, typeOf,
  writeRepoField, writeRepoChange, removeArrayEntry, propose, apply, applyMany, SYSTEM, TOOL, PENDING_FIELDS, PENDING_LINKS,
};
