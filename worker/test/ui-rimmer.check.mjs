// worker/test/ui-rimmer.check.mjs
// Browser check of Rimmer (ui/client.js rimmerCard) against a mock API, on desktop and phone
// sizes: Summary lists the open findings; Fix… with an instruction asks Holly (propose), her
// proposal shows Now/After with Apply (confirm) and the finding goes once applied; fixes Holly
// drafted with Rimmer's run (date, removal) show ready with Apply / Discard fix; How this works; Send to Kryten
// moves one to the Kryten list; Dismiss; Health's three Check buttons and Check showing new findings.
// Saves screenshots (SHOTS=dir). Run: node worker/test/ui-rimmer.check.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLIENT_JS } from '../src/admin/ui/client.js';
import { CLIENT_CSS } from '../src/admin/ui/css.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('ui-rimmer: Playwright not installed here, skipped');
  process.exit(0);
}
const SHOTS = process.env.SHOTS || '';

const stateData = () => ({
  email: 'admin@example.org', sheetId: 'sheet', gids: {}, holiday: { value: 'FALSE', on: false }, newsletter: null, draft: null,
  health: [], watchdog: { open: false }, googleAccount: 'sa@example.iam.gserviceaccount.com',
  pending: { headers: [], rows: [] }, replies: { headers: [], rows: [] }, owed: [], photos: { headers: [], rows: [] },
  photoFolders: [], photosRoot: 'r', today: '2026-11-02', toDelete: [], feedback: { headers: [], rows: [] }, sent: [],
});
const summary = {
  today: '2026-11-02', failing: [], devTasks: [], lessons: [], outreach: { seasonal: 0, quiet: 0, lead: 0 }, orgs: { due: 0, chase: 0 },
  coming: { events: [], roads: [] }, subscribers: { since: '2026-10-29', joined: 0, left: 0, total: 425 },
  visitors: { views: 120, visits: 40, days: [{ date: '2026-11-01', views: 27, visits: 9 }], pages: [] },
  issue: { date: '2026-11-05', deadline: '2026-11-04 18:00', deadlineAt: '2026-11-04T18:00:00.000Z', status: '', row: 0, onThisDay: 'x', events: 0, fresh: 0 },
  lastSent: null,
};
const F = (id, scope, severity, page, where, problem, extra = {}) => ({ id, created_at: '2026-11-01 19:17', scope, target: '', page, where, severity, problem, quote: '', suggestion: '', fix_status: '', fix_note: '', fix_label: '', fix_field: '', fix_old: '', fix_new: '', fix_reason: '', ...extra });
let rimmer;
let posts;
const reset = () => {
  posts = [];
  rimmer = {
    kryten: [],
    last: { newsletter: '2026-11-01 18:37', listings: '2026-11-01 19:17' },
    open: [
      F('K1-n1', 'newsletter', 'problem', 'newsletter', 'Website update', 'The same two pages are announced twice.', { quote: 'There are two new pages', suggestion: 'Remove one of the two.' }),
      F('K1-l1', 'listings', 'check', '/events/', 'Quiz night', 'Saturday 7 November is a Saturday but the body says Friday.', { quote: 'Friday 7 November' }),
      // Drafted with Rimmer's own run (4 Nov): a date fix and a removal, ready for Apply.
      F('K1-l2', 'listings', 'problem', '/events/', 'Handbell concert', 'Listed on 29 November but the body says 6 December.', {
        fix_status: 'offered', fix_label: 'Event: Handbell concert', fix_field: 'date', fix_old: '2026-11-29', fix_new: '2026-12-06', fix_reason: 'The body says 6 December.' }),
      F('K1-l3', 'listings', 'check', '/notices/', 'Severn Trent works', 'The works ended last week.', {
        fix_status: 'offered', fix_label: 'Notice: Severn Trent works', fix_field: 'remove', fix_old: JSON.stringify({ title: 'Severn Trent works', body: 'Pipe works until 30 October.' }), fix_new: '', fix_reason: 'The works are over.' }),
    ],
  };
};
reset();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.method === 'POST') {
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(JSON.parse(b || '{}'))); });
    posts.push([url.pathname, body]);
    if (url.pathname === '/admin/api/rimmer-dismiss') {
      rimmer.open = rimmer.open.filter((f) => f.id !== body.id);
      return send({ ok: true, message: 'Dismissed' });
    }
    if (url.pathname === '/admin/api/rimmer-kryten') {
      const f = rimmer.open.find((x) => x.id === body.id);
      rimmer.open = rimmer.open.filter((x) => x.id !== body.id);
      rimmer.kryten.unshift({ ...f, fix_note: body.note });
      return send({ ok: true, message: 'Sent to Kryten' });
    }
    if (url.pathname === '/admin/api/rimmer-fix') {
      const f = rimmer.open.find((x) => x.id === body.id);
      if (body.op === 'propose') {
        f.fix_status = 'asked';
        setTimeout(() => Object.assign(f, { fix_status: 'proposed', fix_label: 'Event: Quiz night', fix_field: 'body', fix_old: 'Tickets from Fran.', fix_new: 'Tickets from Fran on 01386 123456.', fix_reason: 'Added the number you gave.' }), 50);
        return send({ ok: true, value: 'asked', message: 'Holly is drafting' });
      }
      if (body.op === 'discard') {
        f.fix_status = 'discarded';
        return send({ ok: true, value: 'discarded', message: 'Discarded' });
      }
      if (body.op === 'apply') {
        f.fix_status = 'applying';
        setTimeout(() => { rimmer.open = rimmer.open.filter((x) => x.id !== body.id); }, 50);
        return send({ ok: true, value: 'applying', message: 'Applying' });
      }
      return send({ ok: false }, 'application/json', 400);
    }
    if (url.pathname === '/admin/api/rimmer-apply-many') {
      const ids = body.items.map((x) => x.id);
      for (const f of rimmer.open) if (ids.includes(f.id)) f.fix_status = 'applying';
      setTimeout(() => { rimmer.open = rimmer.open.filter((x) => !ids.includes(x.id)); }, 50);
      return send({ ok: true, applied: ids, skipped: [], message: `Applying ${ids.length} fixes together` });
    }
    if (url.pathname === '/admin/api/rimmer-run') {
      setTimeout(() => {
        rimmer.last = { ...rimmer.last, [body.scope]: '2026-11-02 10:00' };
        rimmer.open.push(F('K2-s1', body.scope, 'problem', '/bins/', 'Bin days', 'Two different collection days are given.'));
      }, 100);
      return send({ ok: true, message: 'Checking' });
    }
    return send({ ok: false }, 'application/json', 404);
  }
  if (url.pathname === '/admin') return send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin/app.css"><script src="/admin/app.js" defer></script></head><body><div id="app"></div></body></html>', 'text/html');
  if (url.pathname === '/admin/app.js') return send(CLIENT_JS, 'text/javascript');
  if (url.pathname === '/admin/app.css') return send(CLIENT_CSS, 'text/css');
  if (url.pathname === '/admin/api/session') return send({ email: 'admin@example.org', csrf: 'c' });
  if (url.pathname === '/admin/api/state') return send(stateData());
  if (url.pathname === '/admin/api/summary') return send(summary);
  if (url.pathname === '/admin/api/rimmer') return send(rimmer);
  return send({ error: 'nf' }, 'application/json', 404);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    reset();
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Speed up the 15-20 second polling for the check.
    await page.addInitScript(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, Math.min(ms, 200), ...a); });
    await page.goto(`${base}/admin`);
    const main = page.locator('.main');
    const card = main.locator('.card.rimmer');
    await card.locator('.finding').first().waitFor();
    let text = await card.innerText();
    assert.match(text, /Rimmer \(4\)/);
    // How this works: folded until opened.
    assert.doesNotMatch(text, /Discard fix throws/);
    await card.locator('details.help summary').click();
    assert.match(await card.locator('details.help').innerText(), /Now \/ After[\s\S]*Apply makes the change[\s\S]*Discard fix throws Holly's fix away[\s\S]*Dismiss closes the finding/);
    await card.locator('details.help summary').click();
    // Fixes Holly drafted with Rimmer's run: shown ready, in words.
    const hb = card.locator('.finding', { hasText: 'Handbell' });
    assert.match(await hb.innerText(), /Holly's fix \(drafted with Rimmer's check\): Event: Handbell concert \(date\)\s+Now\s+Sun 29 Nov 2026\s+After\s+Sun 6 Dec 2026\s+The body says 6 December\. \(The file is renamed to match\.\)/);
    assert.equal(await hb.locator('button', { hasText: 'Fix…' }).count(), 0);
    const st = card.locator('.finding', { hasText: 'Severn Trent' });
    assert.match(await st.innerText(), /\(take it off the website\)\s+Now\s+Notice: Severn Trent works\s+Pipe works until 30 October\.\s+After\s+Taken off the website/);
    for (const b of ['Apply (remove it)', 'Discard fix', 'Ask again…', 'Send to Kryten', 'Dismiss']) assert.equal(await st.locator('button', { hasText: b }).count(), 1, b);
    assert.match(text, /Problem\s+Website update\s+The same two pages are announced twice\.\s+"There are two new pages"\s+Suggested fix: Remove one of the two\./);
    assert.match(text, /Check\s+\/events\/ · Quiz night/);
    assert.match(text, /Newsletter last checked/);
    // Two fixes ready: the batch bar, Apply all ticked off until one is ticked.
    assert.match(text, /Tick findings to deal with several at once\./);
    for (const b of ['Apply ticked fixes', 'Send ticked to Kryten', 'Dismiss ticked']) assert.equal(await card.locator('.batch-bar button', { hasText: b }).isDisabled(), true, b);
    assert.equal(await card.locator('.fix-tick input').count(), 4);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rimmer-summary-${name}.png`), fullPage: true });
    // Fix… with an instruction, Holly's proposal, Apply.
    page.on('dialog', (d) => d.accept());
    const quiz = card.locator('.finding', { hasText: 'Quiz night' });
    await quiz.locator('button', { hasText: 'Fix…' }).click();
    await quiz.locator('textarea').fill("Fran's number is 01386 123456");
    await quiz.locator('button', { hasText: 'Ask Holly for a fix' }).click();
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-fix', { id: 'K1-l1', op: 'propose', note: "Fran's number is 01386 123456", expected: '' }]);
    await quiz.locator('.fix-proposal').waitFor();
    assert.match(await quiz.innerText(), /Holly's fix: Event: Quiz night \(text\)\s+Now\s+Tickets from Fran\.\s+After\s+Tickets from Fran on 01386 123456\./);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rimmer-fix-${name}.png`), fullPage: true });
    await quiz.locator('button', { hasText: 'Apply' }).click();
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-fix', { id: 'K1-l1', op: 'apply', note: '', expected: 'proposed' }]);
    await card.locator('.finding', { hasText: 'Quiz night' }).waitFor({ state: 'detached' });
    assert.match(await card.innerText(), /Rimmer \(3\)/);
    // Apply a drafted date fix; discard then dismiss the drafted removal.
    await hb.locator('button', { hasText: 'Apply' }).click();
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-fix', { id: 'K1-l2', op: 'apply', note: '', expected: 'offered' }]);
    await hb.waitFor({ state: 'detached' });
    await st.locator('button', { hasText: 'Discard fix' }).click();
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-fix', { id: 'K1-l3', op: 'discard', note: '', expected: 'offered' }]);
    await st.locator('button', { hasText: 'Fix…' }).waitFor();
    await st.locator('button', { hasText: 'Dismiss' }).click();
    await st.waitFor({ state: 'detached' });
    assert.match(await card.innerText(), /Rimmer \(1\)/);
    // Send to Kryten
    await card.locator('.finding', { hasText: 'Website update' }).locator('button', { hasText: 'Send to Kryten' }).click();
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-kryten', { id: 'K1-n1', note: '' }]);
    // Nothing open now: Summary folds Rimmer into "No action needed".
    await main.locator('.sum-clear', { hasText: 'Rimmer' }).waitFor();

    // Health: the card with all three buttons; Check whole site shows the new finding.
    await page.locator('button', { hasText: 'Diagnostic' }).first().click();
    const hc = main.locator('.card.rimmer');
    await hc.waitFor();
    assert.match(await hc.innerText(), /Sent to Kryten \(1\)[\s\S]*Newsletter · Website update: The same two pages/);
    for (const b of ['Check newsletter', 'Check listings', 'Check whole site']) assert.equal(await hc.locator('button', { hasText: b }).count(), 1, b);
    await hc.locator('.finding', { hasText: 'Bin' }).waitFor({ state: 'detached' }).catch(() => {});
    await hc.locator('button', { hasText: 'Check whole site' }).click();
    await hc.locator('.finding', { hasText: 'Two different collection days' }).waitFor();
    assert.deepEqual(posts.find((p) => p[0] === '/admin/api/rimmer-run'), ['/admin/api/rimmer-run', { scope: 'site' }]);
    assert.match(await hc.innerText(), /Whole site last checked/);
    // Dismiss
    await hc.locator('.finding', { hasText: 'Two different collection days' }).locator('button', { hasText: 'Dismiss' }).click();
    await hc.locator('.finding', { hasText: 'Two different collection days' }).waitFor({ state: 'detached' });
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-dismiss', { id: 'K2-s1' }]);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rimmer-health-${name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Apply all ticked (5 Nov): tick one, then Tick all, one post for both, both go.
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    reset();
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let asked = '';
    page.on('dialog', (d) => { asked = d.message(); d.accept(); });
    await page.addInitScript(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, Math.min(ms, 200), ...a); });
    await page.goto(`${base}/admin`);
    const card = page.locator('.main .card.rimmer');
    await card.locator('.finding').first().waitFor();
    await card.locator('.finding', { hasText: 'Handbell' }).locator('.fix-tick input').check();
    const bar = card.locator('.batch-bar');
    assert.match(await bar.innerText(), /1 finding ticked \(1 fix ready\)[\s\S]*Tick all[\s\S]*Apply ticked fixes \(1\)/);
    await card.locator('.finding', { hasText: 'Severn Trent' }).locator('.fix-tick input').check();
    assert.match(await bar.innerText(), /2 findings ticked \(2 fixes ready\)[\s\S]*Apply ticked fixes \(2\)[\s\S]*Send ticked to Kryten \(2\)[\s\S]*Dismiss ticked \(2\)/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rimmer-batch-${name}.png`), fullPage: true });
    await bar.locator('button', { hasText: 'Apply ticked fixes' }).click();
    assert.match(asked, /Apply 2 fixes together\?[\s\S]*Event: Handbell concert \(date\)[\s\S]*Notice: Severn Trent works \(take it off the website\)[\s\S]*rebuilds once/);
    assert.deepEqual(posts.at(-1), ['/admin/api/rimmer-apply-many', { items: [{ id: 'K1-l2', expected: 'offered' }, { id: 'K1-l3', expected: 'offered' }] }]);
    await card.locator('.finding', { hasText: 'Handbell' }).waitFor({ state: 'detached' });
    await card.locator('.finding', { hasText: 'Severn Trent' }).waitFor({ state: 'detached' });
    assert.match(await card.innerText(), /Rimmer \(2\)/);
    // The other two (no fix ready): Tick all, then Send ticked to Kryten; then a fresh check, Dismiss ticked.
    await bar.locator('button', { hasText: 'Tick all' }).click();
    assert.match(await bar.innerText(), /2 findings ticked\s[\s\S]*Apply ticked fixes/);
    assert.equal(await bar.locator('button', { hasText: 'Apply ticked fixes' }).isDisabled(), true);
    await bar.locator('button', { hasText: 'Send ticked to Kryten' }).click();
    assert.match(asked, /Send 2 findings to Kryten\?[\s\S]*Newsletter · Website update[\s\S]*\/events\/ · Quiz night/);
    await card.locator('.finding').first().waitFor({ state: 'detached' });
    assert.deepEqual(posts.slice(-2).map((p) => p[0]), ['/admin/api/rimmer-kryten', '/admin/api/rimmer-kryten']);
    assert.equal(rimmer.kryten.length, 2);
    assert.equal(await card.locator('.batch-bar').count(), 0);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll');
    // Dismiss ticked
    rimmer.open.push(F('K3-s1', 'site', 'check', '/bins/', 'Bins', 'One.'), F('K3-s2', 'site', 'check', '/bins/', 'Footnote', 'Two.'));
    await page.reload();
    const c2 = page.locator('.main .card.rimmer');
    await c2.locator('.finding').first().waitFor();
    await c2.locator('.batch-bar button', { hasText: 'Tick all' }).click();
    await c2.locator('.batch-bar button', { hasText: 'Dismiss ticked' }).click();
    assert.match(asked, /Dismiss 2 findings\? Rimmer won't raise them again\./);
    await c2.locator('.finding').first().waitFor({ state: 'detached' });
    assert.deepEqual(posts.slice(-2), [['/admin/api/rimmer-dismiss', { id: 'K3-s1' }], ['/admin/api/rimmer-dismiss', { id: 'K3-s2' }]]);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ui-rimmer: all checks passed (desktop and phone)');
} finally {
  await browser.close();
  server.close();
}
