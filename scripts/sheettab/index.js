// scripts/sheettab/index.js
// Read one tab of the Lenches Pipeline Sheet and print it to the log as CSV, for Kryten to
// quote exact cells (read-sheet-tab.yml). Read-only: its own client with the
// spreadsheets.readonly scope, never scripts/ingest/google.js. Logs may be public, so tabs
// holding subscriber or reader data are refused, Contacts shows names and roles only (rows with
// status ignore not at all), and email addresses are masked.
// Env: GOOGLE_SA_KEY, SHEET_ID, TAB (required); RANGE (e.g. A1:F20), MAX_ROWS (default 50).
'use strict';

const READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const REFUSED_TABS = ['subscribers', 'do not send', 'sends', 'replies', 'feedback'];
// Tabs printed with only these columns (by header); every other cell shows "(hidden)".
// Contacts: names and roles only, never profile, contributions or notes (agreed 25 Oct).
const PARTIAL_TABS = {
  contacts: ['email', 'name', 'organisation', 'village', 'role', 'contribution_count',
    'first_contact', 'last_contact', 'message_count', 'status', 'profile_source', 'updated_at'],
};
const MAX_ROWS_CAP = 500;
const MAX_CELL = 500;

function isRefused(tab) {
  return REFUSED_TABS.includes(String(tab).trim().toLowerCase());
}

function allowedColumns(tab) {
  return PARTIAL_TABS[String(tab).trim().toLowerCase()] || null;
}

// Blank the cells of columns whose header (headerRow, same columns as rows) is not allowed,
// and the whole of any row whose status is "ignore" (e.g. Jon's own addresses).
function redactColumns(rows, headerRow, allowed) {
  const h = (headerRow || []).map((x) => String(x || '').trim().toLowerCase());
  const ok = (i) => allowed.includes(h[i]);
  const statusCol = h.indexOf('status');
  return rows.map((r) => {
    if (statusCol >= 0 && String(r[statusCol] || '').trim().toLowerCase() === 'ignore') return ['(ignored row)'];
    return r.map((v, i) => (ok(i) || v === '' || v == null ? v : '(hidden)'));
  });
}

// A1-style range within the one tab only: letters and digits, never a "!" or another tab.
function parseRange(range) {
  const r = String(range || '').trim().toUpperCase();
  if (!r) return { range: '', startRow: 1, startCol: 'A', endCol: '' };
  const m = r.match(/^([A-Z]{1,3})(\d*)(?::([A-Z]{1,3})(\d*))?$/);
  if (!m) throw new Error(`Range "${range}" is not like A1:F20`);
  return { range: r, startRow: m[2] ? Number(m[2]) : 1, startCol: m[1], endCol: m[3] || m[1] };
}

function colIndex(letters) {
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}

function colLetters(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// j***@domain: first letter of the local part, the domain kept.
function maskEmails(text) {
  return String(text).replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2');
}

function csvCell(value) {
  let s = maskEmails(value == null ? '' : value);
  if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL) + '…';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rows: the values read from startRow on; header: row 1 of the same columns (or null when
// the read already starts at row 1). First line names the columns so cells can be quoted.
function toCsv({ rows, header, startRow, startCol, maxRows }) {
  const first = colIndex(startCol);
  const all = header ? [header, ...rows] : rows;
  const width = Math.max(1, ...all.map(r => r.length));
  const cols = Array.from({ length: width }, (_, i) => colLetters(first + i));
  const line = (n, r) => [n, ...cols.map((_, i) => csvCell(r[i]))].join(',');
  const out = [['row', ...cols].join(',')];
  if (header) out.push(line(1, header));
  const shown = rows.slice(0, maxRows);
  shown.forEach((r, i) => out.push(line(startRow + i, r)));
  if (rows.length > shown.length) out.push(`# ${rows.length - shown.length} more rows not shown (max rows ${maxRows})`);
  return out.join('\n');
}

function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

async function main() {
  const tab = String(process.env.TAB || '').trim();
  if (!tab) throw new Error('TAB is not set');
  if (isRefused(tab)) throw new Error(`The ${tab} tab holds personal data and is never printed to the log`);
  const { range, startRow, startCol, endCol } = parseRange(process.env.RANGE);
  const maxRows = Math.min(MAX_ROWS_CAP, Math.max(1, parseInt(process.env.MAX_ROWS, 10) || 50));

  const { google } = require('googleapis');
  const key = JSON.parse(process.env.GOOGLE_SA_KEY || '{}');
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: [READONLY_SCOPE] });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = meta.data.sheets.map(s => s.properties.title);
  const title = titles.find(t => t === tab) || titles.find(t => t.toLowerCase() === tab.toLowerCase());
  if (!title) throw new Error(`No tab called "${tab}". Tabs: ${titles.filter(t => !isRefused(t)).join(', ')}`);

  const get = async a1 => (await sheets.spreadsheets.values.get({
    spreadsheetId, range: a1, valueRenderOption: 'FORMATTED_VALUE',
  })).data.values || [];
  const rows = await get(range ? `${quoteTab(title)}!${range}` : quoteTab(title));
  const header = startRow > 1 ? (await get(`${quoteTab(title)}!${startCol}1:${endCol}1`))[0] || [] : null;
  const allowed = allowedColumns(title);
  let shown = rows;
  if (allowed) {
    const headerRow = header || rows[0] || [];
    // Without the status column an ignored row can't be recognised, so refuse.
    if (rows.length && !headerRow.some((x) => String(x || '').trim().toLowerCase() === 'status')) {
      throw new Error(`Read the ${title} tab with a range that includes its status column`);
    }
    shown = header ? redactColumns(rows, headerRow, allowed) : [rows[0] || [], ...redactColumns(rows.slice(1), headerRow, allowed)];
  }

  console.log(`Tab: ${title}${range ? ` · range ${range}` : ''} · ${rows.length} rows read`);
  console.log(toCsv({ rows: shown, header, startRow, startCol, maxRows }));
}

if (require.main === module) {
  main().catch(err => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}

module.exports = { isRefused, allowedColumns, redactColumns, parseRange, maskEmails, toCsv, colLetters, colIndex };
