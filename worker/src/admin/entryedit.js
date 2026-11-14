// worker/src/admin/entryedit.js
// "Edit everything" (4 Nov, Jon): the wording and links of listing entries, changed from the Edit
// page (/admin/page, ui/pageedit.js) and the Newsletter draft's editor (/admin/draft-edit).
// Entries are tagged in the site's templates and the draft (data-entry = the source key as in
// scripts/rimmer/fix.js sources(), data-field = the field or fields shown there):
//   h:events/<file>  h:notices/<file>   hand-written items (src/items/)
//   r:<index>                           Regular activities (src/items/regulars.json)
//   e:<id>  t:<id>                      Where to eat, Local trades (src/_data/eat.json, trades.json)
//   p:<Pending id>                      published submissions (their Pending row)
// Which fields can change: lib/entryfields.json (wording and links only; titles, names, dates and
// official statements stay "Ask Kryten").
//   GET  /admin/api/entry?key=          readEntry: the entry's current values (from main / the Sheet)
//   POST /admin/api/entry-save          saveEntry: { key, changes: [{ field, old, new }] }, each old
//                                       still current; then decide() entryedit (the changes as JSON
//                                       in the body, never env) -> entry-edit.yml (scripts/entryedit),
//                                       which re-checks and writes the file (commit + site build; eat
//                                       and trades also redeploy the Worker) or the Pending cells
//                                       (then Publish), and rebuilds a built newsletter (nlquiet).
//   GET  /admin/api/entry-status?id=&at=&p=&text=   entryStatus: saving / building / live / failed
//   GET  /admin/draft-edit              draftEditPage: the draft with the editor script in it

import { decide, github } from '../core.js';
import { readSource, showsText, validPagePath } from './pageedit.js';
import { readTable } from './sheet.js';
import { draftHtml } from './draft.js';
import SPEC from '../../../lib/entryfields.json' with { type: 'json' };

export { SPEC };
export const MAX_TEXT = 4000;
export const MAX_LINE = 600;
export const MAX_CHANGES = 8;
const LINK_RE = /^(https?:\/\/[^\s<>"]+\.[^\s<>"]+|mailto:[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}|tel:\+?[\d ]{6,}|\/[^\s<>"]*)$/i;
const str = (v) => String(v ?? '').trim();
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(str(v));
const LIVE = new Set(['approved', 'auto']);

/* ------------------------------------------------------------ keys -- */

// { kind, file?, index?, id? } or null.
export function parseKey(key) {
  const k = String(key || '');
  let m;
  if ((m = k.match(/^h:(events|notices)\/([a-z0-9][a-z0-9._-]{0,150}\.json)$/i)) && !m[2].includes('..')) return { kind: m[1], file: `src/items/${m[1]}/${m[2]}` };
  if ((m = k.match(/^r:(\d{1,4})$/))) return { kind: 'regulars', index: Number(m[1]), file: 'src/items/regulars.json' };
  if ((m = k.match(/^e:([a-z0-9][a-z0-9-]{0,79})$/))) return { kind: 'eat', id: m[1], file: 'src/_data/eat.json' };
  if ((m = k.match(/^t:([a-z0-9][a-z0-9-]{0,79})$/))) return { kind: 'trades', id: m[1], file: 'src/_data/trades.json' };
  if ((m = k.match(/^p:([A-Za-z0-9_-]{1,100})$/))) return { kind: 'pending', id: m[1] };
  return null;
}

export const fieldsOf = (kind) => {
  const s = SPEC.kinds[kind];
  return s ? [...s.text, ...s.links] : [];
};
export const isLinkField = (kind, field) => !!SPEC.kinds[kind] && SPEC.kinds[kind].links.includes(field);

// A link as stored for the stale check: JSON {text, url}, or '' for none (as fix.js valueOf).
export const linkValue = (l) => (l && typeof l === 'object' && (str(l.url) || str(l.text)) ? JSON.stringify({ text: str(l.text), url: str(l.url) }) : '');

// The text published for a submission: the submitter's own wording or the rewrite (lib/wording.js).
export function pendingBodyColumn(row) {
  if (!str(row.own_text)) return 'summary';
  const w = str(row.wording).toLowerCase();
  if (w === 'own') return 'own_text';
  if (w === 'rewrite') return 'summary';
  return truthy(row.verbatim_requested) ? 'own_text' : 'summary';
}
export const PENDING_LINKS = { link: ['link_text', 'link_url'], link2: ['link2_text', 'link2_url'] };

// The website page that shows an entry (the bar's "Live ✓" check and View page).
export function pageFor(kind, entry) {
  const e = entry || {};
  if (kind === 'events') return '/events/';
  if (kind === 'notices') return e.roads === true ? '/living-here/roads/' : '/notices/';
  if (kind === 'regulars') return '/regulars/';
  if (kind === 'eat') return '/living-here/eat/';
  if (kind === 'trades') return '/living-here/trades/';
  if (kind === 'pending') {
    if (/one\.network/i.test(str(e.link_url))) return '/living-here/roads/';
    return str(e.category).toLowerCase() === 'event' ? '/events/' : '/notices/';
  }
  return '/';
}

// The entry's current values: { kind, label, official, page, values: { field: string } }.
export function entryView(parsed, entry) {
  const { kind } = parsed;
  const e = entry || {};
  const values = {};
  if (kind === 'pending') {
    for (const f of SPEC.kinds.pending.text) values[f] = String(e[f === 'body' ? pendingBodyColumn(e) : f] ?? '');
    for (const [f, [t, u]] of Object.entries(PENDING_LINKS)) values[f] = linkValue({ text: e[t], url: e[u] });
  } else {
    for (const f of SPEC.kinds[kind].text) values[f] = typeof e[f] === 'string' ? e[f] : '';
    for (const f of SPEC.kinds[kind].links) values[f] = linkValue(e[f]);
  }
  const name = kind === 'regulars' ? `${str(e.what)}${str(e.day) ? ` (${str(e.day)})` : ''}` : str(e.title || e.name);
  return { kind, label: `${SPEC.kinds[kind].label}: ${name}`, official: truthy(e.official), page: pageFor(kind, e), values };
}

/* --------------------------------------------------------- cleaning -- */

// New text for a field: { ok, value } or { ok: false, error }. Plain text (the templates escape
// it); line breaks only in multi-line fields (a blank line starts a new paragraph).
export function cleanText(field, v) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ');
  if (SPEC.multiline.includes(field)) {
    s = s.split('\n').map((l) => l.replace(/[ \u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    s = s.replace(/\s+/g, ' ').trim();
  }
  const max = SPEC.multiline.includes(field) ? MAX_TEXT : MAX_LINE;
  if (s.length > max) return { ok: false, error: `Too long (at most ${max} characters)` };
  if (!s && SPEC.required.includes(field)) return { ok: false, error: 'The text can\'t be left empty: ask Kryten to take the entry off' };
  return { ok: true, value: s };
}

// New link: '' (no link) or JSON {text, url}. Accepts the JSON string or { text, url }.
export function cleanLink(v) {
  let l = v;
  if (typeof v === 'string') {
    if (!v.trim()) return { ok: true, value: '' };
    try { l = JSON.parse(v); } catch { return { ok: false, error: 'Not a link' }; }
  }
  if (!l || typeof l !== 'object') return { ok: true, value: '' };
  const text = String(l.text ?? '').replace(/\s+/g, ' ').trim();
  const url = str(l.url);
  if (!text && !url) return { ok: true, value: '' };
  if (!text || !url) return { ok: false, error: 'A link needs both its words and its address (or leave both empty to take it off)' };
  if (text.length > 120) return { ok: false, error: 'The link\'s words are too long (at most 120 characters)' };
  if (url.length > 500 || !LINK_RE.test(url)) return { ok: false, error: 'Links must start https://, mailto:, tel: or /' };
  return { ok: true, value: JSON.stringify({ text, url }) };
}

// Checks Jon's changes against the entry as it is now: { ok, changes } or { ok: false, status, error }.
export function checkChanges(parsed, view, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) return { ok: false, status: 400, error: 'Nothing to save' };
  if (view.official) return { ok: false, status: 403, error: 'This is an official statement: it stays in its own words. Ask Kryten.' };
  const allowed = fieldsOf(parsed.kind);
  const out = [];
  const seen = new Set();
  for (const c of changes) {
    const field = str(c && c.field);
    if (!allowed.includes(field) || seen.has(field)) return { ok: false, status: 400, error: `"${field}" can't be changed here: ask Kryten` };
    seen.add(field);
    const old = String((c && c.old) ?? '');
    if (view.values[field] !== old) return { ok: false, status: 409, error: `${view.label}: changed since you opened it. Reload and try again.` };
    const fresh = isLinkField(parsed.kind, field) ? cleanLink(c.new) : cleanText(field, c.new);
    if (!fresh.ok) return { ok: false, status: 400, error: `${SPEC.names[field] || field}: ${fresh.error}` };
    if (fresh.value !== old) out.push({ field, old, new: fresh.value });
  }
  return { ok: true, changes: out };
}

// What the live page must show once the change is published: the start of the first change.
export function checkText(parsed, changes) {
  for (const c of changes) {
    if (isLinkField(parsed.kind, c.field)) {
      if (c.new) return JSON.parse(c.new).text.slice(0, 60);
      continue;
    }
    const first = String(c.new).split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
    if (first) return first.slice(0, 60).trim();
  }
  return '';
}

/* ----------------------------------------------------------- reading -- */

const fail = (status, error) => ({ ok: false, status, error });

// The entry from main (repo files) or the Pending tab. { ok, parsed, view } or a failure.
export async function readEntry(env, key, { read = readSource, table = readTable } = {}) {
  const parsed = parseKey(key);
  if (!parsed) return fail(400, 'Not an entry that can be edited here: ask Kryten');
  let entry;
  if (parsed.kind === 'pending') {
    const { rows } = await table(env, 'Pending');
    const matches = rows.filter((r) => str(r.id) === parsed.id);
    if (matches.length !== 1) return fail(404, 'That submission is no longer in the Sheet');
    [entry] = matches;
    if (!LIVE.has(str(entry.status).toLowerCase())) return fail(409, 'That submission is not published: edit it on the Submissions screen');
  } else {
    let src;
    try {
      src = await read(env, parsed.file);
    } catch (e) {
      if (e.status === 404) return fail(404, 'That entry is no longer on the website (its file has gone)');
      throw e;
    }
    const o = JSON.parse(src.text);
    if (parsed.kind === 'events' || parsed.kind === 'notices') entry = o;
    else if (parsed.kind === 'regulars') entry = ((o && o.regulars) || [])[parsed.index];
    else entry = (((o && (parsed.kind === 'eat' ? o.places : o.trades)) || []).find((x) => str(x && x.id) === parsed.id));
    if (!entry || typeof entry !== 'object') return fail(404, 'That entry is no longer on the website');
  }
  return { ok: true, parsed, view: entryView(parsed, entry) };
}

// For the edit box: { ok, key, label, official, fields: [{ field, name, type, multiline, value }] }.
export async function entryInfo(env, key, deps) {
  const got = await readEntry(env, key, deps);
  if (!got.ok) return got;
  const { parsed, view } = got;
  return {
    ok: true, key, label: view.label, official: view.official, page: view.page,
    fields: fieldsOf(parsed.kind).map((f) => ({
      field: f, name: SPEC.names[f] || f, type: isLinkField(parsed.kind, f) ? 'link' : 'text',
      multiline: SPEC.multiline.includes(f), required: SPEC.required.includes(f), value: view.values[f],
    })),
  };
}

const newId = () => `ee${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

// Saves one entry's changes through decide(). meta = the Newsletter draft tab's meta (draftMeta), for
// "the newsletter will be rebuilt". { ok, id, at, page, check, rebuild, message } or a failure.
export async function saveEntry(env, body, { meta = null, deps, send = decide, now = Date.now() } = {}) {
  const key = String((body && body.key) || '');
  const got = await readEntry(env, key, deps);
  if (!got.ok) return got;
  const { parsed, view } = got;
  const checked = checkChanges(parsed, view, body.changes);
  if (!checked.ok) return checked;
  if (!checked.changes.length) return { ok: true, count: 0, message: 'No changes to save.' };
  const id = newId();
  const b = JSON.stringify({ key, changes: checked.changes });
  if (b.length > 20000) return fail(400, 'Too long to save in one go');
  if (!(await send(env, { a: 'entryedit', i: id, b }, '', b))) return fail(502, 'GitHub did not accept the change. Nothing has changed: try again.');
  const rebuild = !!(meta && meta.mode === 'frozen' && ['built', 'tested'].includes(str(meta.status).toLowerCase()));
  const n = checked.changes.length;
  return {
    ok: true, id, count: n, at: new Date(now).toISOString(), page: view.page, label: view.label,
    check: checkText(parsed, checked.changes), rebuild, issue: rebuild ? str(meta.issue_date) : '',
    message: `Saved ${n} change${n === 1 ? '' : 's'} to ${view.label}.`,
  };
}

/* ------------------------------------------------------------ status -- */

// The entry-edit.yml run for an edit (its run-name holds the edit id):
// { state: building|failed|done, phase?, url? }.
export function editRunState(runs, id, at, nowMs = Date.now()) {
  const mine = (runs || []).find((r) => String(r.display_title || '').includes(id));
  if (!mine) {
    const since = Date.parse(at) || nowMs;
    return nowMs - since < 10 * 60000 ? { state: 'building', phase: 'saving' } : { state: 'failed' };
  }
  const out = { url: mine.html_url };
  if (mine.status !== 'completed') return { state: 'building', phase: 'saving', ...out };
  if (mine.conclusion === 'success') return { state: 'done', ...out };
  return { state: 'failed', ...out };
}

export async function entryStatus(env, { id, at, page, text }, { fetcher = fetch, nowMs = Date.now() } = {}) {
  if (!/^ee[0-9a-f]{16}$/.test(String(id || ''))) return fail(400, 'Bad edit id');
  const r = await github(env, `/repos/${env.REPO}/actions/workflows/entry-edit.yml/runs?per_page=20`);
  if (!r.ok) return fail(502, `GitHub runs: HTTP ${r.status}`);
  const j = await r.json();
  const st = editRunState(j.workflow_runs || [], id, at, nowMs);
  if (st.state !== 'done') return { ok: true, ...st };
  // Saved: now wait until the published page shows the new wording (site build, Pages cache).
  if (await showsText(env, validPagePath(page), text, fetcher)) return { ok: true, state: 'live', url: st.url };
  return { ok: true, state: 'building', phase: 'publishing', url: st.url };
}

/* ------------------------------------------------------- draft editor -- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonForHtml = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

export function draftEditCsp(origin) {
  return [
    "default-src 'none'", `script-src ${origin}`, `style-src ${origin} 'unsafe-inline'`, 'img-src https://thelenches.org.uk data:',
    `connect-src ${origin}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join('; ');
}

// The draft (as /admin/draft shows it) with the editor in it, framed by the panel only.
export function draftEditHtml(html, { origin, csrf, version }) {
  const data = {
    mode: 'draft', csrf, blocks: [], entryApi: `${origin}/admin/api/entry`, entrySaveApi: `${origin}/admin/api/entry-save`,
    entryStatusApi: `${origin}/admin/api/entry-status`, site: 'https://thelenches.org.uk',
  };
  const tail = `<link rel="stylesheet" href="${esc(origin)}/admin/pageedit.css?v=${esc(version)}">`
    + `<script type="application/json" id="lenches-edit-data">${jsonForHtml(data)}</script>`
    + `<script src="${esc(origin)}/admin/pageedit.js?v=${esc(version)}" defer></script>`;
  const body = html || '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Newsletter draft</title></head><body style="font-family:system-ui,sans-serif;color:#555;padding:24px">No draft yet. Tap Refresh on the panel.</body></html>';
  return /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${tail}</body>`) : body + tail;
}

export async function draftEditPage(rows, opts) {
  return new Response(draftEditHtml(await draftHtml(rows), opts), {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': draftEditCsp(opts.origin),
    },
  });
}
