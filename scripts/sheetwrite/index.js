// scripts/sheetwrite/index.js
// Write cells of the Lenches Pipeline Sheet for Kryten (write-sheet.yml), with an undo log.
//   set    — write VALUES over RANGE (e.g. N36 or A36:N36). Stale-checked: the cells must
//            hold EXPECT (blank when EXPECT is not given), so nothing is overwritten unseen.
//   append — write VALUES as new row(s) after the last row with anything in it (from column A).
//   undo   — put back the old values of Kryten log entry UNDO_ID, only if the cells still
//            hold what that write put there; the entry is then marked undone.
// Every set/append first adds a row to the Kryten log tab (id, at, action, tab, range, old,
// new, status, run; made by the run), so any write can be undone; the nightly "Lenches backup"
// copy of the whole Sheet is the fallback. Never writes row 1 (headers), formulas (values are
// written RAW and a leading "=" is refused) or more than MAX_CELLS cells, and refuses the tabs
// that hold the subscriber list and send records. Values come from the dispatch event file,
// never env, so they don't appear in the (public) log, which prints masked values only.
// Env: GOOGLE_SA_KEY, SHEET_ID; inputs action, tab, range, values, expect, undo_id (from
// GITHUB_EVENT_PATH, else env ACTION, TAB, RANGE, VALUES, EXPECT, UNDO_ID for local runs).
'use strict';

const { parseRange, colIndex, colLetters, maskEmails } = require('../sheettab');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const LOG_TAB = 'Kryten log';
const LOG_HEADERS = ['id', 'at', 'action', 'tab', 'range', 'old', 'new', 'status', 'run'];
const REFUSED_TABS = ['subscribers', 'do not send', 'sends', 'deleted contacts', 'sign-ups', LOG_TAB.toLowerCase()];
const MAX_CELLS = 50;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const isRefused = (tab) => REFUSED_TABS.includes(norm(tab));

// VALUES / EXPECT: a JSON array of rows (["a","b"] = one row, [["a"],["b"]] = a column),
// or plain text for one cell. Every value becomes a string.
function parseValues(text, what = 'values') {
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
  if (cells > MAX_CELLS) throw new Error(`${cells} cells is more than ${MAX_CELLS} in one run`);
  for (const r of rows) for (const v of r) {
    if (/^\s*=/.test(v)) throw new Error('Formulas are never written');
  }
}

// The block of cells RANGE covers once VALUES are placed at its top-left cell.
function targetRange(range, rows) {
  const p = parseRange(range);
  if (!p.range || !/\d/.test(p.range)) throw new Error('Range must name a cell, e.g. N36 or A36:N36');
  if (p.startRow < 2) throw new Error('Row 1 holds the headers and is never written');
  const width = Math.max(...rows.map((r) => r.length));
  const endCol = colLetters(colIndex(p.startCol) + width - 1);
  const endRow = p.startRow + rows.length - 1;
  return { a1: `${p.startCol}${p.startRow}:${endCol}${endRow}`, width, height: rows.length };
}

// Pad a values.get result to height x width so comparisons are cell by cell.
function grid(values, height, width) {
  return Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => {
    const v = values && values[i] && values[i][j];
    return v == null ? '' : String(v);
  }));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const blankGrid = (g) => g.every((r) => r.every((v) => v === ''));

function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

function newId(now) {
  return 'w' + now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + Math.random().toString(16).slice(2, 6);
}

function show(g) {
  return maskEmails(JSON.stringify(g));
}

function readInputs(env) {
  let inputs = {};
  if (env.GITHUB_EVENT_PATH) {
    try { inputs = JSON.parse(require('fs').readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).inputs || {}; } catch { inputs = {}; }
  }
  const pick = (k) => (inputs[k] != null ? inputs[k] : env[k.toUpperCase()] || '');
  return { action: norm(pick('action')) || 'set', tab: String(pick('tab')).trim(), range: String(pick('range')).trim(),
    values: pick('values'), expect: pick('expect'), undoId: String(pick('undo_id')).trim() };
}

// sheets: a googleapis sheets v4 client (or a fake with the same calls, for tests).
async function run({ sheets, spreadsheetId, inputs, now = new Date(), runUrl = '', log = console.log }) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  const findTab = (t) => titles.find((x) => x === t) || titles.find((x) => norm(x) === norm(t));
  const get = async (a1) => (await sheets.spreadsheets.values.get({
    spreadsheetId, range: a1, valueRenderOption: 'FORMATTED_VALUE',
  })).data.values || [];
  const put = (a1, values) => sheets.spreadsheets.values.update({
    spreadsheetId, range: a1, valueInputOption: 'RAW', requestBody: { values },
  });

  async function ensureLog() {
    if (findTab(LOG_TAB)) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB } } }] } });
    titles.push(LOG_TAB);
    await put(`${quoteTab(LOG_TAB)}!A1`, [LOG_HEADERS]);
  }

  if (inputs.action === 'undo') {
    if (!inputs.undoId) throw new Error('undo needs undo_id (the id the write printed)');
    if (!findTab(LOG_TAB)) throw new Error('There is no Kryten log tab yet');
    const rows = await get(quoteTab(LOG_TAB));
    const h = (rows[0] || []).map(norm);
    const c = (k) => h.indexOf(k);
    const idx = rows.findIndex((r, i) => i > 0 && r[c('id')] === inputs.undoId);
    if (idx < 0) throw new Error(`No Kryten log entry ${inputs.undoId}`);
    const e = rows[idx];
    if (norm(e[c('status')]) !== 'done') throw new Error(`Entry ${inputs.undoId} is ${e[c('status')] || 'not done'}, so there is nothing to undo`);
    const tab = findTab(e[c('tab')]);
    if (!tab) throw new Error(`The ${e[c('tab')]} tab no longer exists`);
    const oldG = JSON.parse(e[c('old')]);
    const newG = JSON.parse(e[c('new')]);
    const a1 = e[c('range')];
    const now2 = grid(await get(`${quoteTab(tab)}!${a1}`), newG.length, newG[0].length);
    if (!same(now2, newG)) throw new Error(`${tab}!${a1} has changed since that write, so it is left alone: now ${show(now2)}`);
    await put(`${quoteTab(tab)}!${a1}`, oldG);
    const statusCell = `${quoteTab(LOG_TAB)}!${colLetters(c('status') + 1)}${idx + 1}`;
    await put(statusCell, [[`undone ${now.toISOString()}`]]);
    log(`Undone ${inputs.undoId}: ${tab}!${a1} is back to ${show(oldG)}`);
    return { id: inputs.undoId, tab, range: a1, old: oldG, new: newG };
  }

  if (!['set', 'append'].includes(inputs.action)) throw new Error(`Unknown action "${inputs.action}" (set, append or undo)`);
  if (!inputs.tab) throw new Error('tab is not set');
  if (isRefused(inputs.tab)) throw new Error(`The ${inputs.tab} tab is never written by Kryten; ask Jon`);
  const tab = findTab(inputs.tab);
  if (!tab) throw new Error(`No tab called "${inputs.tab}"`);
  const rows = parseValues(inputs.values);
  if (!rows) throw new Error('values is empty');
  checkValues(rows);

  let range = inputs.range;
  if (inputs.action === 'append') {
    const colA = await get(`${quoteTab(tab)}!A:A`);
    const all = await get(quoteTab(tab));
    const last = Math.max(colA.length, all.length, 1);
    range = `A${last + 1}`;
  }
  const t = targetRange(range, rows);
  const target = `${quoteTab(tab)}!${t.a1}`;
  const before = grid(await get(target), t.height, t.width);
  const expect = parseValues(inputs.expect, 'expect');
  if (inputs.action === 'set' && expect) {
    if (!same(before, grid(expect, t.height, t.width))) throw new Error(`${tab}!${t.a1} holds ${show(before)}, not what was expected; nothing written`);
  } else if (!blankGrid(before)) {
    throw new Error(`${tab}!${t.a1} is not blank (${show(before)}); give expect with its current values to overwrite`);
  }
  const after = grid(rows, t.height, t.width);

  await ensureLog();
  const id = newId(now);
  const logRows = await get(`${quoteTab(LOG_TAB)}!A:A`);
  const logRow = Math.max(logRows.length, 1) + 1;
  await put(`${quoteTab(LOG_TAB)}!A${logRow}:I${logRow}`, [[id, now.toISOString(), inputs.action, tab, t.a1,
    JSON.stringify(before), JSON.stringify(after), 'pending', runUrl]]);
  await put(target, after);
  await put(`${quoteTab(LOG_TAB)}!H${logRow}`, [['done']]);
  log(`Wrote ${tab}!${t.a1}: ${show(before)} -> ${show(after)}`);
  log(`Undo id: ${id}`);
  return { id, tab, range: t.a1, old: before, new: after };
}

async function main() {
  const { google } = require('googleapis');
  const key = JSON.parse(process.env.GOOGLE_SA_KEY || '{}');
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });
  const sheets = google.sheets({ version: 'v4', auth });
  const e = process.env;
  const runUrl = e.GITHUB_RUN_ID ? `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}` : '';
  await run({ sheets, spreadsheetId: e.SHEET_ID, inputs: readInputs(e), runUrl });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::${maskEmails(err.message)}`);
    process.exit(1);
  });
}

module.exports = { run, parseValues, checkValues, targetRange, grid, readInputs, isRefused, LOG_TAB, LOG_HEADERS, MAX_CELLS };
