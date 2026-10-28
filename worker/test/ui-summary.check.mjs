// worker/test/ui-summary.check.mjs
// Browser check of the panel's Summary page (ui/client.js) against a mock API, on desktop
// and phone sizes: it opens first, each section's lines, "Nothing waiting" when empty, the
// holiday banner, and headings that open their screens. Saves screenshots (SHOTS=dir).
// Run: node worker/test/ui-summary.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-summary: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const now = Date.now();
const uk = (msAgo) => new Date(now - msAgo).toISOString().slice(0, 16).replace('T', ' ');
const H = 3600000;
let holiday = false;
let empty = false;
const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: { Issues: 3 }, holiday: { value: holiday ? 'TRUE' : 'FALSE', on: holiday }, newsletter: null,
  health: empty ? [{ date: uk(5 * H), status: 'OK' }] : [{ date: uk(5 * H), status: 'PROBLEMS', problems: 'Feed Harvington PC: HTTP 403' }],
  watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: empty ? [] : [
    { _row: 2, id: 'p1', title: 'Bonfire night', source: '', received: uk(50 * H), urgent: 'TRUE', status: 'pending' },
    { _row: 3, id: 'p2', title: 'Cheap watches', source: '', received: uk(5 * H), notes: 'Possible spam (confidence 0.5)', status: 'pending' },
    { _row: 4, id: 'p3', title: 'Parish council minutes', source: 'Harvington PC', received: uk(26 * H), status: 'pending' },
  ] },
  replies: { headers: [], rows: empty ? [] : [
    { _row: 5, reply_id: 'r1', to: 'sue@example.org', subject: 'Coffee morning', type: 'answer', status: 'awaiting', created_at: uk(26 * H) },
    { _row: 6, reply_id: 'r2', to: 'mark@example.org', subject: 'Road closure?', type: 'held', status: 'awaiting', created_at: uk(75 * H), hold_reason: 'possible auto-responder' },
  ] },
  owed: empty ? [] : [{ holding: { _row: 7, reply_id: 'h1', to: 'ann@example.org', subject: 'Hall booking', sent_at: uk(100 * H) }, draft: null }],
  photos: { headers: [], rows: [] }, photoFolders: [], photosRoot: 'r', today: '2026-10-28', toDelete: [], sent: [],
  feedback: { headers: [], rows: empty ? [] : [{ _row: 8, id: 'f1', _state: 'waiting', rating: '4', message: 'Bin dates wrong for Atch Lench', page_title: 'Bins', received: uk(30 * H), type: 'correction' }] },
});
const summaryData = () => (empty ? {
  today: '2026-10-28', failing: [], devTasks: [], lessons: [], outreach: { seasonal: 0, quiet: 0, lead: 0 }, orgs: { due: 0, chase: 0 },
  coming: { events: [], roads: [] }, subscribers: { since: '2026-10-22', joined: 0, left: 0, total: 425 },
  visitors: { off: true },
  issue: { date: '2026-10-29', deadline: '2026-10-28 18:00', deadlineAt: new Date(now - 2 * H).toISOString(), status: 'tested', row: 0, onThisDay: '', events: 0, fresh: 0 },
} : {
  today: '2026-10-28',
  failing: [{ name: 'Ingest', started: new Date(now - 2 * H).toISOString(), url: 'https://github.com/o/r/actions/runs/9' }],
  devTasks: [{ task: 'Groups page: add the group once consent arrives', waiting: 'a reply by email', added: '2026-10-28' }],
  lessons: [{ id: 'L1', lesson: 'Thank council clerks for their help.' }],
  outreach: { seasonal: 1, quiet: 1, lead: 0 }, orgs: { due: 1, chase: 0 },
  coming: { events: [{ date: '2026-10-31', end: '', title: 'Halloween trail', url: 'https://thelenches.org.uk/events/#ev' }],
    roads: [{ start: '2026-11-02', end: '2026-11-06', title: 'Road closure — Ab Lench Road', url: 'https://thelenches.org.uk/living-here/roads/' }] },
  subscribers: { since: '2026-10-22', joined: 4, left: 1, total: 428 },
  visitors: { since: 'x', views: 812, visits: 301, days: [{ date: '2026-10-27', views: 400, visits: 150 }, { date: '2026-10-28', views: 412, visits: 151 }],
    pages: [{ path: '/', views: 300 }, { path: '/bins/', views: 120 }] },
  issue: { date: '2026-10-29', deadline: '2026-10-28 18:00', deadlineAt: new Date(now + 28 * H).toISOString(), status: '', row: 12, onThisDay: 'In 1886, the Statue of Liberty was dedicated in New York.', events: 6, fresh: 3 },
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/summary') return send(summaryData());
  if (url.pathname === '/admin/api/lessons') return send({ headers: [], rows: [] });
  return send({ error: 'nf' }, 'application/json', 404);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    holiday = name === 'phone';
    empty = false;
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/admin`);
    const main = page.locator('.main');
    await main.locator('.card.sum', { hasText: 'Subscribers' }).waitFor();
    const menu = (await page.locator('nav.side button').allInnerTexts()).map((t) => t.replace(/\s*\d+$/, '').trim());
    assert.equal(menu[0], 'Summary');
    assert.equal(await page.locator('nav.side button[aria-current="page"]').innerText(), 'Summary');
    const text = await main.innerText();
    assert.match(text, /Submissions to approve \(3\)/);
    assert.match(text, /Bonfire night[\s\S]*Urgent/);
    assert.match(text, /Cheap watches[\s\S]*Possible spam/);
    assert.match(text, /Newsletter deadline \(Wednesday 6pm\) in 1 day [34] hours/);
    assert.match(text, /Replies needed \(2\)[\s\S]*mark@example\.org · Road closure\?[\s\S]*Held: possible auto-responder/);
    assert.match(text, /Owed a reply \(1\)[\s\S]*Hall booking · holding reply 4 days ago/);
    assert.match(text, /Feedback \(1\)[\s\S]*★★★★☆ "Bin dates wrong/);
    assert.match(text, /Feed Harvington PC: HTTP 403/);
    assert.match(text, /Ingest · last run failed/);
    assert.match(text, /Development tasks \(1\)[\s\S]*waiting on a reply by email/);
    assert.match(text, /Next newsletter: Thu 29 Oct[\s\S]*Deadline in 1 day [34] hours[\s\S]*Not built yet[\s\S]*6 events in its two weeks, 3 new items[\s\S]*On this day: In 1886/);
    assert.match(text, /Halloween trail[\s\S]*Road closure — Ab Lench Road · until Fri 6 Nov/);
    assert.match(text, /2 contacts due a nudge · 1 seasonal, 1 gone quiet/);
    assert.match(text, /1 organisation due a check/);
    assert.match(text, /Holly lessons awaiting approval \(1\)[\s\S]*Thank council clerks/);
    assert.match(text, /\+4 joined, −1 unsubscribed or blocked · since the newsletter of Thu 22 Oct/);
    assert.match(text, /Visitors[\s\S]*812 page views, 301 visits · last 7 days[\s\S]*By day: Tue 27 Oct 400 · Wed 28 Oct 412[\s\S]*\/bins\/ · 120 views/);
    assert.equal(/Holiday mode is ON/.test(text), holiday, 'holiday banner only when on');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `summary-${name}.png`), fullPage: true });
    // A heading opens its screen.
    await main.locator('button.sum-h', { hasText: 'Holly lessons' }).click();
    assert.match(await page.locator('.intro').innerText(), /^Rules Holly follows/);
    // Empty: "Nothing waiting", and the missing On this day warning.
    empty = true;
    holiday = false;
    await page.locator('nav.side button', { hasText: 'Summary' }).click();
    await page.locator('button.btn', { hasText: 'Reload' }).click();
    await main.locator('.card.sum', { hasText: 'Subscribers' }).waitFor();
    await page.waitForTimeout(300);
    const t2 = await main.innerText();
    assert.match(t2, /Submissions to approve \(0\)[\s→]*Nothing waiting/);
    assert.match(t2, /Replies needed \(0\)[\s→]*Nothing waiting/);
    assert.match(t2, /All clear/);
    assert.match(t2, /Development tasks \(0\)[\s→]*Nothing outstanding/);
    assert.match(t2, /No On this day line for Thu 29 Oct/);
    assert.match(t2, /Deadline passed[\s\S]*Preview emailed: waiting for your tap/);
    assert.match(t2, /Nothing in the next 7 days/);
    assert.match(t2, /Not set up: the Worker needs CF_ANALYTICS_TOKEN/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `summary-${name}-empty.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-summary: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
