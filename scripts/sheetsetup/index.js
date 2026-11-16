// Sets up a second site's Pipeline Sheet from the Lenches one (Harvington stage 4, 16 Nov 2026).
// Copies each Lenches tab's NAME and HEADER ROW only (row 1, never any data), so the same code
// finds the same columns, and starts the Settings tab with safe values (see settingsRows).
// It never changes the Lenches Sheet (read-only there) and never touches a tab that already
// has anything in row 1. Without APPLY=true it only prints what it would do.
//
// Env: GOOGLE_SA_KEY, SITE (the site to set up; never lenches), APPLY ("true" to write).
// The target is that site's site.json sheetId; the Sheet must be shared with the service
// account as an editor. Logs print tab names and header counts only.
const path = require('path');
const { SITE, siteConfig, sheetId } = require('../../lib/site');

const SOURCE_ID = require(path.join(__dirname, '../../sites/lenches/_data/site.json')).sheetId;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
// Lenches tabs not copied: obsolete (Rimmer's first tab).
const SKIP = new Set(['Checker']);
// Settings values copied from the Lenches as they are (limits and timings). Every other key
// gets the value in START, or is left blank for Jon (addresses, start date choices).
const COPY = new Set(['reply_max_per_run', 'reply_max_per_day', 'reply_max_per_sender', 'urgent_window_days',
  'digest_time', 'reply_sources', 'approval_emails']);

const todayUk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

// What the new Sheet's Settings tab starts with: nothing goes out until Jon switches it on.
function startValues(cfg) {
  return {
    holiday_mode: 'FALSE',
    start_date: todayUk(),
    replies_mode: 'shadow',
    newsletter_mode: 'off',
    from_name: cfg.fromName || '',
    auto_window: '',
    auto_window_emails: 'FALSE',
  };
}

// Settings rows (from row 2): sources in A:D (just the site's own Submissions address),
// key/value settings in E:F, in the Lenches order.
function settingsRows(lenchesRows, cfg) {
  const start = startValues(cfg);
  const pairs = [];
  const seen = new Set();
  for (const r of lenchesRows.slice(1)) {
    const key = String(r[4] || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pairs.push([key, key in start ? start[key] : COPY.has(key) ? String(r[5] ?? '') : '']);
  }
  for (const [k, v] of Object.entries(start)) if (!seen.has(k)) pairs.push([k, v]);
  const sources = [['Submissions', String(cfg.email || '').toLowerCase(), 'approve', '']];
  const n = Math.max(sources.length, pairs.length);
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([...(sources[i] || ['', '', '', '']), ...(pairs[i] || ['', ''])]);
  return rows;
}

const q = (t) => `'${String(t).replace(/'/g, "''")}'`;

// The plan: which tabs to add, which to fill (blank row 1), which to leave.
function plan(source, target) {
  const steps = [];
  for (const s of source) {
    if (SKIP.has(s.title)) continue;
    const t = target.find((x) => x.title === s.title);
    if (!t) steps.push({ title: s.title, add: true, headers: s.headers });
    else if (!t.headers.some((h) => String(h).trim())) steps.push({ title: s.title, add: false, headers: s.headers });
    else steps.push({ title: s.title, skip: 'already has headers' });
  }
  return steps;
}

async function tabs(sheets, spreadsheetId, rows = 1) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  if (!titles.length) return [];
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: titles.map((t) => `${q(t)}!1:${rows}`) });
  return titles.map((title, i) => {
    const values = (res.data.valueRanges[i] && res.data.valueRanges[i].values) || [];
    return { title, headers: values[0] || [], values };
  });
}

async function main() {
  if (SITE === 'lenches') throw new Error('SITE is lenches: this sets up another site\'s Sheet, never the Lenches one');
  const targetId = sheetId();
  if (targetId === SOURCE_ID) throw new Error('The target Sheet is the Lenches Sheet');
  const apply = String(process.env.APPLY || '').toLowerCase() === 'true';
  const { google } = require('googleapis');
  const key = JSON.parse(process.env.GOOGLE_SA_KEY || '{}');
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });
  const sheets = google.sheets({ version: 'v4', auth });

  const source = await tabs(sheets, SOURCE_ID);
  const settingsSrc = await sheets.spreadsheets.values.get({ spreadsheetId: SOURCE_ID, range: `'Settings'!A1:F100` });
  const target = await tabs(sheets, targetId);
  const steps = plan(source, target);
  for (const s of steps) {
    console.log(s.skip ? `Leave  ${s.title} (${s.skip})` : `${s.add ? 'Add   ' : 'Fill  '} ${s.title}: ${s.headers.length} header(s)`);
  }
  const todo = steps.filter((s) => !s.skip);
  const doSettings = todo.some((s) => s.title === 'Settings');
  const settings = doSettings ? settingsRows(settingsSrc.data.values || [], siteConfig()) : [];
  if (doSettings) console.log(`Settings: ${settings.length} starter row(s) (replies_mode shadow, newsletter_mode off, holiday_mode FALSE)`);
  if (!apply) { console.log(`Dry run: ${todo.length} tab(s) to set up. Run again with apply ticked to write.`); return; }
  if (!todo.length) { console.log('Nothing to do.'); return; }

  const adds = todo.filter((s) => s.add).map((s) => ({ addSheet: { properties: { title: s.title } } }));
  if (adds.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: targetId, requestBody: { requests: adds } });
  const data = todo.filter((s) => s.headers.length).map((s) => ({ range: `${q(s.title)}!A1`, values: [s.headers] }));
  if (doSettings && settings.length) data.push({ range: `'Settings'!A2`, values: settings });
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: targetId, requestBody: { valueInputOption: 'RAW', data } });
  }
  console.log(`Done: ${adds.length} tab(s) added, ${todo.length} header row(s) written.`);
}

if (require.main === module) {
  main().catch((err) => { console.error(`::error::${err.message}`); process.exit(1); });
}

module.exports = { plan, settingsRows, startValues };
