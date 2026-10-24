// worker/src/admin/index.js
// Admin panel, served under /admin by the approvals Worker. Cloudflare Access sits in
// front; every request here (pages, API, images) is checked again with verifyAccess,
// so the workers.dev URL can't skip it. The Sheet stays the source of truth.
//   GET  /admin                     the panel (this version: a connection check page)
//   GET  /admin/api/session         { email, csrf }
//   GET  /admin/api/state           queue data: Pending, Replies, Photos, holiday mode,
//                                   latest Health and Issues rows, tab gids
//   POST /admin/api/edit            { tab, key, field, expected, value }: one plain field
//                                   edit, refused (409, current value) if the cell changed
//   POST /admin/api/action          { kind: pending|reply|photo, id, action, reason?, body?,
//                                   expected? }: decisions go through core.js decide(),
//                                   the same path as the signed email links
//   GET  /admin/img/mail/MSG/PART   a Pending image (email attachment)
//   GET  /admin/img/drive/ID[?size=N]  a Photos image (Drive thumbnail, else the file)
// Nothing here can send the newsletter or change repository code: the only GitHub call
// is decide(), for the item and reply actions listed in actions.js.

import { ACTIONS, decide } from '../core.js';
import { verifyAccess } from './access.js';
import { makeCsrf, checkCsrf, sameOrigin } from './csrf.js';
import { getValues, sheetGids, gmailImage, driveImage } from './google.js';
import { readTable, readSettingsPairs, editCell, checkedWrite } from './sheet.js';
import { planPending, planReply, planPhoto } from './actions.js';

const MAX_BODY = 20000;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
// Issues cells too big or too technical for the panel.
const ISSUE_SKIP = new Set(['snapshot', 'item_keys', 'image_keys', 'content_hash']);
// Photos rows still waiting for a decision.
const PHOTO_WAITING = new Set(['', 'new']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
});

const html = (body, status = 200) => new Response(`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Lenches admin</title>
<style>
:root{--bg:#F6F1E4;--card:#fff;--ink:#2b2b2b;--muted:#666;--accent:#3F5233;--bad:#A33B2B}
@media (prefers-color-scheme: dark){:root{--bg:#161a14;--card:#22281f;--ink:#e8e6df;--muted:#a3a39a;--accent:#9cc28a;--bad:#e08a7c}}
body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:16px}
main{max-width:640px;margin:24px auto;background:var(--card);border-radius:10px;padding:24px}
h1{color:var(--accent);font-size:1.3rem;margin-top:0}
.muted{color:var(--muted);font-size:.9rem}.bad{color:var(--bad)}
li{margin:4px 0}
</style></head><body><main>${body}</main></body></html>`, {
  status, headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
});

const forbidden = () => new Response('Forbidden', {
  status: 403, headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain' },
});

/* ---------------------------------------------------------------- reads -- */

async function settled(promises) {
  const out = await Promise.allSettled(promises);
  return out.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason && r.reason.message }));
}

// Feeds in Settings A:C ({ source, match }), for "Trust this source" on RSS items.
async function readSources(env) {
  const values = await getValues(env, "'Settings'!A1:C100");
  return values.slice(1).map((r) => ({ source: String(r[0] ?? '').trim(), match: String(r[1] ?? '').trim() }))
    .filter((s) => s.source && s.match);
}

async function state(env, email) {
  const [pending, replies, photos, settings, health, issues, gids] = await settled([
    readTable(env, 'Pending'), readTable(env, 'Replies'), readTable(env, 'Photos'),
    readSettingsPairs(env), readTable(env, 'Health'), readTable(env, 'Issues'), sheetGids(env),
  ]);
  const rowsOf = (t, keep) => (t.error ? t : { headers: t.headers, rows: t.rows.filter(keep) });
  const holiday = settings.error ? settings : (settings.find((p) => p.key === 'holiday_mode') || { value: '' });
  const last = (t) => (t.error ? t : t.rows.filter((r) => Object.values(r).some((v) => v !== '' && typeof v === 'string')).pop() || null);
  const issue = last(issues);
  if (issue && !issue.error) for (const k of ISSUE_SKIP) delete issue[k];
  return {
    email,
    pending: rowsOf(pending, (r) => r.status === 'pending'),
    replies: rowsOf(replies, (r) => r.status === 'awaiting'),
    photos: rowsOf(photos, (r) => r.drive_id && PHOTO_WAITING.has(String(r.status || '').trim().toLowerCase())),
    holiday: holiday.error ? holiday : { value: holiday.value, on: String(holiday.value).trim().toUpperCase() === 'TRUE' },
    health: last(health),
    issue,
    gids,
  };
}

async function homePage(env, email) {
  const s = await state(env, email);
  const count = (t) => (t.error ? `<span class="bad">not readable: ${esc(t.error)}</span>` : String(t.rows.length));
  const missingPeopleOk = !s.pending.error && !s.pending.headers.includes('people_ok');
  return html(`<h1>Lenches admin</h1>
<p>Signed in as ${esc(email)}. The screens arrive in the next update; this page checks the connections.</p>
<ul>
<li>Pending items waiting: ${count(s.pending)}</li>
<li>Replies awaiting you: ${count(s.replies)}</li>
<li>Photos waiting: ${count(s.photos)}</li>
<li>Holiday mode: ${s.holiday.error ? `<span class="bad">not readable: ${esc(s.holiday.error)}</span>` : (s.holiday.on ? 'ON' : 'off')}</li>
<li>Latest health check: ${s.health && !s.health.error ? `${esc(s.health.date)} ${esc(s.health.status)}` : '<span class="bad">none found</span>'}</li>
<li>Latest newsletter: ${s.issue && !s.issue.error ? `${esc(s.issue.issue_date || s.issue.issue_id)} ${esc(s.issue.status)}` : '<span class="bad">none found</span>'}</li>
</ul>
${missingPeopleOk ? '<p class="bad">Pending has no people_ok column yet: approving items whose image shows people is blocked until it is added.</p>' : ''}
<p class="muted">Nothing on this page changes anything.</p>`);
}

/* --------------------------------------------------------------- writes -- */

async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function doEdit(env, body) {
  const r = await editCell(env, {
    tab: String(body.tab || ''), key: String(body.key ?? ''), field: String(body.field || ''),
    expected: body.expected, value: body.value,
  });
  return r.ok ? json({ ok: true, value: r.value }) : json(r, r.status);
}

async function doAction(env, body) {
  const kind = String(body.kind || '');
  const id = String(body.id ?? '');
  const action = String(body.action || '');

  if (kind === 'photo') {
    const { rows } = await readTable(env, 'Photos');
    const matches = rows.filter((r) => id && r.drive_id === id);
    const plan = planPhoto({ action, expected: body.expected }, matches.length === 1 ? matches[0] : null);
    if (plan.error) return json({ ok: false, ...plan }, plan.status);
    const r = await checkedWrite(env, {
      tab: 'Photos', keyCol: 'drive_id', key: id, field: plan.field, expected: plan.expected, value: plan.value,
    });
    return r.ok ? json({ ok: true, value: r.value, message: `Marked ${r.value}. The daily photos run publishes approved photos.` }) : json(r, r.status);
  }

  let plan;
  if (kind === 'pending') {
    const needSources = action === 'trust';
    const [{ headers, rows }, sources] = await Promise.all([
      readTable(env, 'Pending'), needSources ? readSources(env) : [],
    ]);
    const matches = rows.filter((r) => id && r.id === id);
    plan = planPending({ action, id }, matches.length === 1 ? matches[0] : null,
      { hasPeopleOk: headers.includes('people_ok'), sources });
  } else if (kind === 'reply') {
    plan = planReply({ action, id, reason: body.reason, body: body.body });
  } else {
    return json({ ok: false, error: `Unknown kind "${kind}"` }, 400);
  }
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  if (!(await decide(env, plan.p, plan.reason || '', plan.body || ''))) {
    return json({ ok: false, error: 'GitHub did not accept the request. Nothing has changed; try again in a few minutes.' }, 502);
  }
  return json({ ok: true, message: `${ACTIONS[plan.p.a][1]}. It takes a minute or two to show in the Sheet.` });
}

/* --------------------------------------------------------------- images -- */

async function image(env, path, url) {
  let m = path.match(/^\/admin\/img\/mail\/([A-Za-z0-9]{6,40})\/([0-9.]{1,20})$/);
  let got;
  try {
    if (m) {
      got = await gmailImage(env, m[1], m[2]);
    } else if ((m = path.match(/^\/admin\/img\/drive\/([A-Za-z0-9_-]{10,100})$/))) {
      const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 0, 0), 1600);
      got = await driveImage(env, m[1], size);
    } else {
      return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    }
  } catch (e) {
    console.error(`Admin image ${path}: ${e.message}`);
    return new Response('Image not available', { status: e.status === 404 || e.status === 415 ? e.status : 502, headers: SECURITY_HEADERS });
  }
  return new Response(got.bytes, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': got.type,
      'content-disposition': 'inline',
      // Private to this browser; an image under an id never changes.
      'cache-control': 'private, max-age=86400',
    },
  });
}

/* ---------------------------------------------------------------- entry -- */

export async function handleAdmin(request, env) {
  const auth = await verifyAccess(request, env);
  if (!auth.email) {
    console.log(`Admin refused: ${auth.error}`);
    return forbidden();
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (path === '/admin') return await homePage(env, auth.email);
      if (path === '/admin/api/session') return json({ email: auth.email, csrf: await makeCsrf(env, auth.email) });
      if (path === '/admin/api/state') return json(await state(env, auth.email));
      if (path.startsWith('/admin/img/')) return await image(env, path, url);
      return json({ error: 'Not found' }, 404);
    }
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return json({ ok: false, error: 'Cross-site request refused' }, 403);
      if (!(await checkCsrf(env, auth.email, request.headers.get('x-csrf-token')))) {
        return json({ ok: false, error: 'Session expired: reload the page' }, 403);
      }
      const body = await readJson(request);
      if (!body) return json({ ok: false, error: 'Bad request' }, 400);
      if (path === '/admin/api/edit') return await doEdit(env, body);
      if (path === '/admin/api/action') return await doAction(env, body);
      return json({ ok: false, error: 'Not found' }, 404);
    }
    return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS });
  } catch (e) {
    console.error(`Admin ${request.method} ${path}: ${e.stack || e.message}`);
    return json({ ok: false, error: e.message }, 502);
  }
}
