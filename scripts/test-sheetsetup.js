// Tests for scripts/sheetsetup (Harvington stage 4): headers only, never over a used row 1,
// Settings starts safe. Run: node scripts/test-sheetsetup.js
process.env.SITE = 'harvington';
const assert = require('assert');
const { plan, settingsRows } = require('./sheetsetup');
const site = require('../lib/site');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// sheetId: env wins (tests), else site.json; a site without one fails clearly.
ok(site.sheetId({ SHEET_ID: 'abc' }) === 'abc', 'SHEET_ID env wins');
ok(site.sheetId({}) === require('../sites/harvington/_data/site.json').sheetId, 'Harvington sheetId from site.json');
ok(site.sheetId({}) !== require('../sites/lenches/_data/site.json').sheetId, 'Harvington Sheet is not the Lenches one');
ok(require('../sites/lenches/_data/site.json').sheetId.length > 20, 'Lenches site.json has its sheetId');

const source = [
  { title: 'Pending', headers: ['id', 'status', 'title'] },
  { title: 'Settings', headers: ['source', 'match', 'mode', 'silent_days', 'setting', 'value'] },
  { title: 'Checker', headers: ['x'] },
  { title: 'Replies', headers: ['status', 'to'] },
];
const target = [
  { title: 'Sheet1', headers: [] },
  { title: 'Replies', headers: ['something'] },
  { title: 'Pending', headers: [] },
];
const p = plan(source, target);
ok(!p.some((s) => s.title === 'Checker'), 'obsolete Checker tab skipped');
ok(p.find((s) => s.title === 'Pending').add === false && p.find((s) => s.title === 'Pending').headers.length === 3, 'blank existing tab gets headers');
ok(p.find((s) => s.title === 'Settings').add === true, 'missing tab added');
ok(p.find((s) => s.title === 'Replies').skip, 'tab with headers left alone');
ok(!p.some((s) => s.title === 'Sheet1'), 'target-only tab untouched');

const lenches = [
  ['source', 'match', 'mode', 'silent_days', 'setting', 'value'],
  ['one.network', 'noreply@one.network', 'auto', '', 'holiday_mode', 'TRUE'],
  ['Submissions', 'website@thelenches.org.uk', 'approve', '', 'replies_mode', 'live'],
  ['', '', '', '', 'reply_max_per_day', '30'],
  ['', '', '', '', 'test_to', 'someone@example.org'],
  ['', '', '', '', 'newsletter_mode', 'live'],
  ['', '', '', '', 'auto_window', 'event'],
  ['', '', '', '', 'from_name', 'The Lenches Website and Newsletter Team'],
];
const cfg = { email: 'website@harvingtonvillage.org.uk', fromName: 'The Harvington Website and Newsletter Team' };
const rows = settingsRows(lenches, cfg);
const kv = Object.fromEntries(rows.filter((r) => r[4]).map((r) => [r[4], r[5]]));
ok(kv.holiday_mode === 'FALSE' && kv.replies_mode === 'shadow' && kv.newsletter_mode === 'off', 'nothing goes out at first');
ok(kv.auto_window === '', 'veto window off');
ok(kv.reply_max_per_day === '30', 'limits copied');
ok(kv.test_to === '', 'addresses not copied');
ok(kv.from_name === cfg.fromName, 'site from_name');
ok(/^\d{4}-\d{2}-\d{2}$/.test(kv.start_date), 'start_date today');
ok(rows[0][0] === 'Submissions' && rows[0][1] === cfg.email, 'own Submissions source');
ok(!rows.some((r) => /one\.network|thelenches/.test(r[1])), 'no Lenches sources copied');
ok(rows.every((r) => r.length === 6), 'six columns per row');

console.log(`sheetsetup: ${n} checks passed`);

// Workflows: no hard-coded Sheet id; any that reads the Sheet takes its site from the run.
const fs = require('fs');
const dir = require('path').join(__dirname, '..', '.github', 'workflows');
const EXPR = "SITE: ${{ github.event.client_payload.site || github.event.inputs.site || 'lenches' }}";
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
  const y = fs.readFileSync(require('path').join(dir, f), 'utf8');
  ok(!/SHEET_ID:/.test(y), `${f}: no hard-coded SHEET_ID`);
  if (/GOOGLE_SA_KEY/.test(y) && !['sheet-setup.yml', 'build.yml', 'publish.yml'].includes(f)) ok(y.includes(EXPR), `${f}: SITE from the run`);
}
console.log(`sheetsetup + workflows: ${n} checks passed`);
