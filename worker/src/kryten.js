// worker/src/kryten.js
// Quick Sheet access for Kryten (4 Nov, Jon; idea 3 of the "speed things up" list): POST /k
// does what the Read Sheet tab and Write Sheet cells workflows do, in a second or two instead
// of a GitHub run of about a minute each.
// Full access (14 Nov, Jon): /k answers only Kryten, never a public log, so it reads every tab
// in full (real addresses, Contacts profiles and notes, Subscribers, Sends …) and writes every
// tab but the Kryten log. The Read Sheet tab and Write Sheet cells workflows keep their own
// stricter rules (their logs are public); worker/test/kryten.test.mjs checks they still
// refuse the personal tabs.
//   read    one tab as CSV (first line names the columns, first field the Sheet row)
//   set / append / undo   as Write Sheet cells: stale-checked, RAW, never row 1, no formulas,
//           at most 50 cells, never the Kryten log, and every write first adds a Kryten log
//           row (run = "kryten endpoint") so it can be undone
// Auth: header "authorization: Bearer <KRYTEN_TOKEN>" (Worker secret, added by hand in the
// Cloudflare dashboard; the same value is in Kryten's cloud environment). Without the secret
// (or with one under 32 characters) /k answers 404 as if it did not exist. Outside /admin,
// so Cloudflare Access does not cover it: the token is the only key. Nothing is logged but
// the operation and tab.

import { accessToken, SCOPES } from './admin/google.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/* ------------------------------------------------------------ read rules -- */

export const MAX_ROWS_CAP = 500;
const MAX_CELL = 2000;

/* ----------------------------------------------------------- write rules -- */

export const LOG_TAB = 'Kryten log';
export const LOG_HEADERS = ['id', 'at', 'action', 'tab', 'range', 'old', 'new', 'status', 'run'];
export const WRITE_REFUSED = [LOG_TAB.toLowerCase()];
export const MAX_CELLS = 50;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

export function parseRange(range) {
  const r = String(range || '').trim().toUpperCase();
  if (!r) return { range: '', startRow: 1, startCol: 'A', endCol: '' };
  const m = r.match(/^([A-Z]{1,3})(\d*)(?::([A-Z]{1,3})(\d*))?$/);
  if (!m) throw new Error(`Range "${range}" is not like A1:F20`);
  return { range: r, startRow: m[2] ? Number(m[2]) : 1, startCol: m[1], endCol: m[3] || m[1] };
}
export const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export function colLetters(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
const quoteTab = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

function csvCell(value) {
  let s = String(value == null ? '' : value);
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL) + '…';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv({ rows, header, startRow, startCol, maxRows }) {
  const first = colIndex(startCol);
  const all = header ? [header, ...rows] : rows;
  const width = Math.max(1, ...all.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => colLetters(first + i));
  const line = (n, r) => [n, ...cols.map((_, i) => csvCell(r[i]))].join(',');
  const out = [['row', ...cols].join(',')];
  if (header) out.push(line(1, header));
  const shown = rows.slice(0, maxRows);
  shown.forEach((r, i) => out.push(line(startRow + i, r)));
  if (rows.length > shown.length) out.push(`# ${rows.length - shown.length} more rows not shown (max rows ${maxRows})`);
  return out.join('\n');
}

/* ------------------------------------------------------- the Sheet calls -- */

// The calls both operations need, over fetch (the Worker has no googleapis). A fake with the
// same four functions stands in for tests.
export function sheetClient(env) {
  const id = String(env.SHEET_ID || '').trim();
  const call = async (url, init = {}) => {
    const token = await accessToken(env, SCOPES.sheets);
    const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    if (!r.ok) throw new Error(`Google API: HTTP ${r.status}`);
    return r.json();
  };
  return {
    titles: async () => ((await call(`${SHEETS}/${id}?fields=sheets.properties.title`)).sheets || []).map((s) => s.properties.title),
    get: async (a1) => (await call(`${SHEETS}/${id}/values/${encodeURIComponent(a1)}?valueRenderOption=FORMATTED_VALUE`)).values || [],
    put: (a1, values) => call(`${SHEETS}/${id}/values/${encodeURIComponent(a1)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values }) }),
    addTab: (title) => call(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) }),
  };
}

const findIn = (titles, t) => titles.find((x) => x === t) || titles.find((x) => norm(x) === norm(t));

/* ------------------------------------------------------------------ read -- */

export async function readTab(s, { tab, range, max_rows: maxRowsIn }) {
  const want = String(tab || '').trim();
  if (!want) throw new Error('tab is not set');
  const { range: r, startRow, startCol, endCol } = parseRange(range);
  const maxRows = Math.min(MAX_ROWS_CAP, Math.max(1, parseInt(maxRowsIn, 10) || 50));
  const titles = await s.titles();
  const title = findIn(titles, want);
  if (!title) throw new Error(`No tab called "${want}". Tabs: ${titles.join(', ')}`);
  const rows = await s.get(r ? `${quoteTab(title)}!${r}` : quoteTab(title));
  const header = startRow > 1 ? (await s.get(`${quoteTab(title)}!${startCol}1:${endCol}1`))[0] || [] : null;
  return { tab: title, rows: rows.length, csv: toCsv({ rows, header, startRow, startCol, maxRows }) };
}

/* ----------------------------------------------------------------- write -- */

export function parseValues(text, what = 'values') {
  if (Array.isArray(text)) text = JSON.stringify(text);
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  let v = s;
  if (/^\s*\[/.test(s)) {
    try { v = JSON.parse(s); } catch { throw new Error(`${what} is not valid JSON`); }
  }
  const rows = !Array.isArray(v) ? [[v]] : v.every(Array.isArray) ? v : [v];
  return rows.map((r) => r.map((x) => (x == null ? '' : String(x))));
}
function checkValues(rows) {
  const cells = rows.reduce((n, r) => n + r.length, 0);
  if (!cells) throw new Error('No values given');
  if (cells > MAX_CELLS) throw new Error(`${cells} cells is more than ${MAX_CELLS} in one write`);
  for (const r of rows) for (const v of r) if (/^\s*=/.test(v)) throw new Error('Formulas are never written');
}
export function targetRange(range, rows) {
  const p = parseRange(range);
  if (!p.range || !/\d/.test(p.range)) throw new Error('Range must name a cell, e.g. N36 or A36:N36');
  if (p.startRow < 2) throw new Error('Row 1 holds the headers and is never written');
  const width = Math.max(...rows.map((r) => r.length));
  const endCol = colLetters(colIndex(p.startCol) + width - 1);
  const endRow = p.startRow + rows.length - 1;
  return { a1: `${p.startCol}${p.startRow}:${endCol}${endRow}`, width, height: rows.length };
}
const grid = (values, height, width) => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => {
  const v = values && values[i] && values[i][j];
  return v == null ? '' : String(v);
}));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const blankGrid = (g) => g.every((r) => r.every((v) => v === ''));
const show = (g) => JSON.stringify(g);
const newId = (now) => 'w' + now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + Math.random().toString(16).slice(2, 6);

export async function writeCells(s, inputs, now = new Date()) {
  const action = norm(inputs.action) || 'set';
  const titles = await s.titles();
  const findTab = (t) => findIn(titles, t);

  if (action === 'undo') {
    const undoId = String(inputs.undo_id || '').trim();
    if (!undoId) throw new Error('undo needs undo_id (the id the write gave)');
    if (!findTab(LOG_TAB)) throw new Error('There is no Kryten log tab yet');
    const rows = await s.get(quoteTab(LOG_TAB));
    const h = (rows[0] || []).map(norm);
    const c = (k) => h.indexOf(k);
    const idx = rows.findIndex((r, i) => i > 0 && r[c('id')] === undoId);
    if (idx < 0) throw new Error(`No Kryten log entry ${undoId}`);
    const e = rows[idx];
    if (norm(e[c('status')]) !== 'done') throw new Error(`Entry ${undoId} is ${e[c('status')] || 'not done'}, so there is nothing to undo`);
    const tab = findTab(e[c('tab')]);
    if (!tab) throw new Error(`The ${e[c('tab')]} tab no longer exists`);
    const oldG = JSON.parse(e[c('old')]);
    const newG = JSON.parse(e[c('new')]);
    const a1 = e[c('range')];
    const now2 = grid(await s.get(`${quoteTab(tab)}!${a1}`), newG.length, newG[0].length);
    if (!same(now2, newG)) throw new Error(`${tab}!${a1} has changed since that write, so it is left alone: now ${show(now2)}`);
    await s.put(`${quoteTab(tab)}!${a1}`, oldG);
    await s.put(`${quoteTab(LOG_TAB)}!${colLetters(c('status') + 1)}${idx + 1}`, [[`undone ${now.toISOString()}`]]);
    return { id: undoId, tab, range: a1, message: `Undone ${undoId}: ${tab}!${a1} is back to ${show(oldG)}` };
  }

  if (!['set', 'append'].includes(action)) throw new Error(`Unknown action "${action}" (set, append or undo)`);
  const want = String(inputs.tab || '').trim();
  if (!want) throw new Error('tab is not set');
  if (WRITE_REFUSED.includes(norm(want))) throw new Error(`The ${want} tab is never written by Kryten; ask Jon`);
  const tab = findTab(want);
  if (!tab) throw new Error(`No tab called "${want}"`);
  const rows = parseValues(inputs.values);
  if (!rows) throw new Error('values is empty');
  checkValues(rows);

  let range = String(inputs.range || '').trim();
  if (action === 'append') {
    const colA = await s.get(`${quoteTab(tab)}!A:A`);
    const all = await s.get(quoteTab(tab));
    range = `A${Math.max(colA.length, all.length, 1) + 1}`;
  }
  const t = targetRange(range, rows);
  const target = `${quoteTab(tab)}!${t.a1}`;
  const before = grid(await s.get(target), t.height, t.width);
  const expect = parseValues(inputs.expect, 'expect');
  if (action === 'set' && expect) {
    if (!same(before, grid(expect, t.height, t.width))) throw new Error(`${tab}!${t.a1} holds ${show(before)}, not what was expected; nothing written`);
  } else if (!blankGrid(before)) {
    throw new Error(`${tab}!${t.a1} is not blank (${show(before)}); give expect with its current values to overwrite`);
  }
  const after = grid(rows, t.height, t.width);

  if (!findTab(LOG_TAB)) {
    await s.addTab(LOG_TAB);
    titles.push(LOG_TAB);
    await s.put(`${quoteTab(LOG_TAB)}!A1`, [LOG_HEADERS]);
  }
  const id = newId(now);
  const logRow = Math.max((await s.get(`${quoteTab(LOG_TAB)}!A:A`)).length, 1) + 1;
  await s.put(`${quoteTab(LOG_TAB)}!A${logRow}:I${logRow}`, [[id, now.toISOString(), action, tab, t.a1,
    JSON.stringify(before), JSON.stringify(after), 'pending', 'kryten endpoint']]);
  await s.put(target, after);
  await s.put(`${quoteTab(LOG_TAB)}!H${logRow}`, [['done']]);
  return { id, tab, range: t.a1, message: `Wrote ${tab}!${t.a1}: ${show(before)} -> ${show(after)}. Undo id: ${id}` };
}

/* ---------------------------------------------------------------- handler -- */

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Constant-time comparison of the bearer token with the secret.
export function tokenOk(header, secret) {
  const s = String(secret || '');
  if (s.length < 32) return false;
  const m = /^Bearer\s+(\S+)$/.exec(String(header || ''));
  if (!m) return false;
  const a = new TextEncoder().encode(m[1]);
  const b = new TextEncoder().encode(s);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

export async function handleKryten(request, env, client = null) {
  if (String(env.KRYTEN_TOKEN || '').length < 32) return new Response('Lenches approvals', { status: 404, headers: { 'content-type': 'text/plain' } });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!tokenOk(request.headers.get('authorization'), env.KRYTEN_TOKEN)) return json({ error: 'Not allowed' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }
  const op = norm(body && body.op);
  const s = client || sheetClient(env);
  try {
    if (op === 'read') {
      const out = await readTab(s, body);
      console.log(`Kryten read: ${out.tab}, ${out.rows} rows`);
      return json({ ok: true, ...out });
    }
    if (['set', 'append', 'undo'].includes(op)) {
      const out = await writeCells(s, { ...body, action: op });
      console.log(`Kryten ${op}: ${out.tab}`);
      return json({ ok: true, ...out });
    }
    return json({ error: 'op must be read, set, append or undo' }, 400);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
