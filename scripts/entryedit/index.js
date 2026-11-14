// scripts/entryedit/index.js
// "Edit everything" (4 Nov, Jon): writes one listing edit Jon saved on the Edit page or the
// Newsletter draft's editor (worker/src/admin/entryedit.js -> decide() entryedit -> entry-edit.yml).
// The payload (read from the event file, never env): { id, body: JSON { key, changes: [{ field, old, new }] } }.
//   repo entries (h:events/<file>, h:notices/<file>, r:<i>, e:<id>, t:<id>): each field must still
//     hold `old` (else nothing is written and the run fails), then scripts/rimmer/fix.js
//     writeRepoChange writes it; the workflow commits and runs the site build (eat and trades also
//     redeploy the Worker, which bundles them)
//   p:<Pending id>: the published submission's Pending cells (the body column it publishes from,
//     link_text/link_url, link2_text/link2_url), stale-checked the same way; then Publish
//   official statements and any field outside lib/entryfields.json are refused
// If the next issue is already built (Issues built/tested), the workflow then rebuilds it (as the
// panel's Rebuild, nlquiet: sends nothing), so Test send is needed again before Send to all.
// Logs print the edit id, the kind and the field names only (logs are public).
'use strict';

const fs = require('fs');
const path = require('path');
const fix = require('../rimmer/fix');
const SPEC = require('../../lib/entryfields.json');

const ROOT = path.join(__dirname, '..', '..');
const LIVE = new Set(['approved', 'auto']);
const MAX_TEXT = 4000;
const MAX_LINE = 600;
const LINK_RE = /^(https?:\/\/[^\s<>"]+\.[^\s<>"]+|mailto:[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}|tel:\+?[\d ]{6,}|\/[^\s<>"]*)$/i;
const str = (v) => String(v ?? '').trim();
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));

// Same rules as worker/src/admin/entryedit.js (worker/test/entryedit.test.mjs checks they agree).
function parseKey(key) {
  const k = String(key || '');
  let m;
  if ((m = k.match(/^h:(events|notices)\/([a-z0-9][a-z0-9._-]{0,150}\.json)$/i)) && !m[2].includes('..')) return { kind: m[1] };
  if ((m = k.match(/^r:(\d{1,4})$/))) return { kind: 'regulars' };
  if ((m = k.match(/^e:([a-z0-9][a-z0-9-]{0,79})$/))) return { kind: 'eat' };
  if ((m = k.match(/^t:([a-z0-9][a-z0-9-]{0,79})$/))) return { kind: 'trades' };
  if ((m = k.match(/^p:([A-Za-z0-9_-]{1,100})$/))) return { kind: 'pending', id: m[1] };
  return null;
}
const isLink = (kind, field) => SPEC.kinds[kind].links.includes(field);
const linkValue = (l) => (l && typeof l === 'object' && (str(l.url) || str(l.text)) ? JSON.stringify({ text: str(l.text), url: str(l.url) }) : '');

function cleanText(field, v) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ');
  if (SPEC.multiline.includes(field)) {
    s = s.split('\n').map((l) => l.replace(/[  ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    s = s.replace(/\s+/g, ' ').trim();
  }
  const max = SPEC.multiline.includes(field) ? MAX_TEXT : MAX_LINE;
  if (s.length > max) return { ok: false, error: 'too long' };
  if (!s && SPEC.required.includes(field)) return { ok: false, error: 'empty' };
  return { ok: true, value: s };
}

function cleanLink(v) {
  let l = v;
  if (typeof v === 'string') {
    if (!v.trim()) return { ok: true, value: '' };
    try { l = JSON.parse(v); } catch { return { ok: false, error: 'not a link' }; }
  }
  if (!l || typeof l !== 'object') return { ok: true, value: '' };
  const text = String(l.text ?? '').replace(/\s+/g, ' ').trim();
  const url = str(l.url);
  if (!text && !url) return { ok: true, value: '' };
  if (!text || !url) return { ok: false, error: 'half a link' };
  if (text.length > 120) return { ok: false, error: 'link words too long' };
  if (url.length > 500 || !LINK_RE.test(url)) return { ok: false, error: 'bad link address' };
  return { ok: true, value: JSON.stringify({ text, url }) };
}

function pendingBodyColumn(row) {
  if (!str(row.own_text)) return 'summary';
  const w = str(row.wording).toLowerCase();
  if (w === 'own') return 'own_text';
  if (w === 'rewrite') return 'summary';
  return truthy(row.verbatim_requested) ? 'own_text' : 'summary';
}
const PENDING_LINKS = { link: ['link_text', 'link_url'], link2: ['link2_text', 'link2_url'] };

class EditError extends Error {}

// The payload's changes, checked: [{ field, old, new }] (new already clean).
function checkPayload(body) {
  let p;
  try { p = typeof body === 'string' ? JSON.parse(body) : body; } catch { throw new EditError('unreadable payload'); }
  const parsed = parseKey(p && p.key);
  if (!parsed) throw new EditError('not an editable entry');
  const allowed = [...SPEC.kinds[parsed.kind].text, ...SPEC.kinds[parsed.kind].links];
  const changes = Array.isArray(p.changes) ? p.changes : [];
  if (!changes.length || changes.length > 8) throw new EditError('nothing to change');
  const seen = new Set();
  const out = changes.map((c) => {
    const field = str(c && c.field);
    if (!allowed.includes(field) || seen.has(field)) throw new EditError(`field ${field || '?'} cannot be changed here`);
    seen.add(field);
    const fresh = isLink(parsed.kind, field) ? cleanLink(c.new) : cleanText(field, c.new);
    if (!fresh.ok) throw new EditError(`${field}: ${fresh.error}`);
    return { field, old: String(c.old ?? ''), new: fresh.value };
  });
  return { key: str(p.key), parsed, changes: out };
}

const STALE = 'it has changed since Jon opened it';

// Pending: the cells to write, after the stale check. { tab: 'Pending', row, fields }.
function pendingUpdate(row, changes) {
  if (!row) throw new EditError('the submission is no longer in Pending');
  if (!LIVE.has(str(row.status).toLowerCase())) throw new EditError('the submission is not published');
  if (truthy(row.official)) throw new EditError('official statements stay in their own words');
  const fields = {};
  for (const c of changes) {
    if (c.field === 'body') {
      const col = pendingBodyColumn(row);
      if (String(row[col] ?? '') !== c.old) throw new EditError(STALE);
      fields[col] = c.new;
    } else if (PENDING_LINKS[c.field]) {
      const [t, u] = PENDING_LINKS[c.field];
      if (linkValue({ text: row[t], url: row[u] }) !== c.old) throw new EditError(STALE);
      const l = c.new ? JSON.parse(c.new) : { text: '', url: '' };
      fields[t] = l.text;
      fields[u] = l.url;
    } else throw new EditError(`field ${c.field} cannot be changed on a submission`);
  }
  return fields;
}

// Repo entries: checks every field first, then writes them (fix.js writeRepoChange, which keeps
// the file's layout where it can). Returns the source.
function writeRepo(key, changes, root = ROOT) {
  const src = fix.sources({ root }).find((s) => s.key === key);
  if (!src || src.kind === 'pending' || src.kind === 'siteupdates' || src.kind === 'bin') throw new EditError('the entry no longer exists');
  if (src.official || truthy(src.entry && src.entry.official)) throw new EditError('official statements stay in their own words');
  for (const c of changes) {
    const now = isLink(src.kind, c.field) ? linkValue(src.entry && src.entry[c.field]) : (src.entry && typeof src.entry[c.field] === 'string' ? src.entry[c.field] : '');
    if (now !== c.old) throw new EditError(STALE);
  }
  for (const c of changes) fix.writeRepoChange(src, c.field, c.old, c.new, root);
  return src;
}

function output(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

// Whether the next issue is built (Issues built/tested): { rebuild, issue }.
function builtIssue(issues, today) {
  const { issueDateFor } = require('../newsletter/draft');
  const issue = issueDateFor(today, issues);
  const rows = (issues || []).filter((r) => str(r.issue_id) === issue);
  const last = rows[rows.length - 1];
  return { rebuild: !!last && ['built', 'tested'].includes(str(last.status).toLowerCase()), issue };
}

async function run(payload, { g, root = ROOT, today } = {}) {
  const id = str(payload && payload.id);
  if (!/^ee[0-9a-f]{16}$/.test(id)) throw new EditError('bad edit id');
  const { key, parsed, changes } = checkPayload(payload.body);
  const fields = changes.map((c) => c.field).join(', ');
  if (parsed.kind === 'pending') {
    const rows = await g.readTable('Pending');
    const matches = rows.filter((r) => str(r.id) === parsed.id);
    if (matches.length !== 1) throw new EditError('the submission is no longer in Pending');
    await g.updateRow('Pending', matches[0]._row, pendingUpdate(matches[0], changes));
    output('publish', 'true');
  } else {
    const src = writeRepo(key, changes, root);
    output('commit', 'true');
    // The Worker bundles trades.json and eat.json (Recommend, Suggest): redeploy it too.
    if (src.kind === 'eat' || src.kind === 'trades') output('worker', 'true');
  }
  console.log(`Entry edit ${id}: ${parsed.kind}, ${changes.length} change(s) (${fields}).`);
  const day = today || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now());
  const b = builtIssue(await g.readTable('Issues'), day);
  if (b.rebuild) {
    output('rebuild', 'true');
    output('issue_date', b.issue);
    console.log(`The ${b.issue} issue is built: it will be rebuilt with this change (Test send again before Send to all).`);
  }
  return { kind: parsed.kind, changes: changes.length, rebuild: b.rebuild };
}

async function main() {
  let p = {};
  if (process.env.GITHUB_EVENT_PATH) {
    try { p = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).client_payload || {}; } catch { p = {}; }
  }
  const g = require('../ingest/google');
  try {
    await run(p, { g });
  } catch (e) {
    if (e instanceof EditError) {
      console.error(`Entry edit ${str(p.id).slice(0, 20)}: not saved (${e.message}).`);
      process.exit(1);
    }
    throw e;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { run, checkPayload, pendingUpdate, writeRepo, builtIssue, parseKey, cleanText, cleanLink, pendingBodyColumn, linkValue, EditError };
