// worker/src/admin/index.js
// Admin panel, served under /admin by the approvals Worker. Cloudflare Access sits in
// front; every request here (pages, API, images) is checked again with verifyAccess,
// so the workers.dev URL can't skip it. The Sheet stays the source of truth.
//   GET  /admin, /admin/app.js, /admin/app.css   the panel (ui/client.js, ui/css.js)
//   GET  /admin/api/session         { email, csrf }
//   GET  /admin/api/state           Pending, Replies (awaiting and still owed), Photos (all
//                                   in Drive) and the Lenches Photos folders, holiday mode,
//                                   latest newsletter, Health, watchdog, Google account;
//                                   each Photos row's _pages: the public pages it is on
//                                   (photopages.js, from the site's photo-pages.json)
//                                   photoFolders: [{ id, parent, names }] live from Drive,
//                                   for the Photos menu and the drop/Move to… targets
//   GET  /admin/api/mail-images?m=  every image in one email (for a Pending item)
//   POST /admin/api/edit            { tab, key, field, expected, value }: one plain field
//                                   edit, refused (409, current value) if the cell changed
//   POST /admin/api/action          { kind: pending|reply|photo, id, action, reason?, body?,
//                                   expected? }: decisions go through core.js decide(),
//                                   the same path as the signed email links
//   GET  /admin/api/photo-file?id=  a Photos file's live Drive name and folder, and the
//                                   Lenches Photos folders it can move to
//   GET  /admin/api/photo-group?id= every copy in a possible-duplicate group
//   GET  /admin/api/photo-name?id=&name=  the name a rename would save as (core-N if the
//                                   name is in use anywhere under Lenches Photos)
//   POST /admin/api/photo-file      { op: rename|move|discard, ... }: Drive file
//                                   management, stale-checked, inside Lenches Photos only
//                                   (photofiles.js); nothing is ever created, binned or deleted
//   GET  /admin/img/mail/MSG/PART   a Pending image (email attachment)
//   GET  /admin/img/drive/ID[?size=N]  a Photos image (Drive thumbnail, else the file)
// Nothing here can send the newsletter or change repository code: the only GitHub call
// is decide(), for the item and reply actions listed in actions.js.

import { ACTIONS, decide, github } from '../core.js';
import { verifyAccess } from './access.js';
import { makeCsrf, checkCsrf, sameOrigin } from './csrf.js';
import { getValues, sheetGids, gmailImage, gmailImageParts, driveImage, serviceAccountEmail } from './google.js';
import { readTable, readSettingsPairs, editCell, checkedWrite } from './sheet.js';
import { planPending, planReply, planPhoto, trustKeyFor, truthy } from './actions.js';
import { owedReplies } from './owed.js';
import { fileInfo, folderList, dupMembers, previewName, renameFile, moveFile, discardFile } from './photofiles.js';
import { photoPages, pagesFor } from './photopages.js';
import { CLIENT_CSS } from './ui/css.js';
import { CLIENT_JS, UI_VERSION } from './ui/client.js';

const MAX_BODY = 20000;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
// Issues cells the status strip shows (never the snapshot or hashes).
const NEWSLETTER_FIELDS = ['_row', 'issue_id', 'issue_date', 'status', 'subject', 'sent_at', 'recipients', 'notes'];
const REPLY_FIELDS = ['_row', 'reply_id', 'message_id', 'to', 'type', 'status', 'subject', 'sent_at', 'created_at'];
const WATCHDOG_TITLE = 'Watchdog alert';
// Photos rows still waiting for a decision.
const PHOTO_WAITING = new Set(['', 'new']);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
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

// Watchdog: the Worker's own checks raise a GitHub issue titled "Watchdog alert" and
// close it when the next check passes. { open, since, problems } or { open: false, cleared }.
async function watchdog(env) {
  const r = await github(env, `/repos/${env.REPO}/issues?state=all&per_page=30`);
  if (!r.ok) throw new Error(`GitHub issues: HTTP ${r.status}`);
  const alerts = ((await r.json()) || []).filter((i) => i.title === WATCHDOG_TITLE && !i.pull_request);
  const open = alerts.find((i) => i.state === 'open');
  if (open) {
    const problems = String(open.body || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    return { open: true, since: open.created_at, problems };
  }
  const last = alerts.find((i) => i.closed_at);
  return { open: false, cleared: last ? last.closed_at : '' };
}

// Organisers' images: Image fetch rows saved to Drive, by Drive file id.
function organiserImages(t) {
  const out = {};
  if (t.error) return out;
  for (const r of t.rows) {
    const id = String(r.drive_file_id || '').trim();
    if (id) out[id] = { event: r.event || '', source_page: r.source_page || '', credit: r.credit || '' };
  }
  return out;
}

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

async function state(env, email) {
  const [pending, replies, photos, settings, health, issues, gids, sources, web, dog, folders, onSite] = await settled([
    readTable(env, 'Pending'), readTable(env, 'Replies'), readTable(env, 'Photos'),
    readSettingsPairs(env), readTable(env, 'Health'), readTable(env, 'Issues'), sheetGids(env),
    readSources(env), readTable(env, 'Image fetch'), watchdog(env), folderList(env), photoPages(env),
  ]);
  const holiday = settings.error ? settings : (settings.find((p) => p.key === 'holiday_mode') || { value: '' });
  const filled = (t) => t.rows.filter((r) => Object.entries(r).some(([k, v]) => k !== '_row' && v !== ''));

  let newsletter = issues.error ? issues : (filled(issues).pop() || null);
  if (newsletter && !newsletter.error) newsletter = pick(newsletter, NEWSLETTER_FIELDS);

  let pend = pending;
  if (!pending.error) {
    const src = sources.error ? [] : sources;
    pend = {
      headers: pending.headers,
      rows: pending.rows.filter((r) => r.status === 'pending').map((r) => ({
        ...r,
        _trust: trustKeyFor(r, src),
        _official: truthy(r.official),
        _offers: Boolean(String(r.own_text || '').trim()) && (truthy(r.official) || truthy(r.verbatim_requested)),
      })),
    };
  }
  const owed = replies.error ? replies : owedReplies(replies.rows).map(({ holding, draft }) => ({
    holding: pick(holding, REPLY_FIELDS),
    draft: draft ? pick(draft, REPLY_FIELDS) : null,
  }));
  const fromWeb = organiserImages(web);
  return {
    email,
    sheetId: String(env.SHEET_ID || ''),
    gids: gids.error ? {} : gids,
    holiday: holiday.error ? holiday : { value: holiday.value, on: String(holiday.value).trim().toUpperCase() === 'TRUE' },
    newsletter,
    health: health.error ? health : filled(health).slice(-7).reverse(),
    watchdog: dog,
    // The Google service account in use (the panel is admins only, behind Access).
    googleAccount: serviceAccountEmail(env),
    pending: pend,
    replies: replies.error ? replies : { headers: replies.headers, rows: replies.rows.filter((r) => r.status === 'awaiting') },
    owed,
    // Every photo still in Drive (for the folder views); _waiting = needs a decision.
    photos: photos.error ? photos : {
      headers: photos.headers,
      rows: photos.rows
        .filter((r) => r.drive_id && String(r.status || '').trim().toLowerCase() !== 'missing')
        .map((r) => ({
          ...r,
          _waiting: PHOTO_WAITING.has(String(r.status || '').trim().toLowerCase()),
          _organiser: fromWeb[r.drive_id] || null,
          _pages: pagesFor(onSite, r),
        })),
    },
    photoFolders: folders,
    photosRoot: String(env.PHOTOS_FOLDER_ID || '').trim(),
  };
}

// The panel: a static shell; everything else comes from the API.
const shell = () => new Response(`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Lenches admin</title>
<link rel="stylesheet" href="/admin/app.css?v=${UI_VERSION}">
<script src="/admin/app.js?v=${UI_VERSION}" defer></script>
</head><body><div id="app"><p class="loading">Loading…</p></div></body></html>`, {
  headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
});

const asset = (body, type) => new Response(body, {
  headers: { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8`, 'cache-control': 'private, max-age=300' },
});

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

const fromResult = (r) => (r.ok ? json(r) : json(r, r.status));

// Photos file management: one operation per request.
const FILE_OPS = {
  rename: (env, b) => renameFile(env, { id: String(b.id || ''), expected: b.expected, name: b.name }),
  move: (env, b) => moveFile(env, { id: String(b.id || ''), expectedParent: b.expectedParent, to: b.to }),
  discard: (env, b) => discardFile(env, {
    id: String(b.id || ''), expected: b.expected, expectedParent: b.expectedParent, confirmPublished: b.confirmPublished === true,
  }),
};

async function doFileOp(env, body) {
  const op = FILE_OPS[String(body.op || '')];
  if (!op) return json({ ok: false, error: `Unknown operation "${body.op}"` }, 400);
  return fromResult(await op(env, body));
}

/* --------------------------------------------------------------- images -- */

async function mailImages(env, url) {
  const m = String(url.searchParams.get('m') || '');
  if (!/^[A-Za-z0-9]{6,40}$/.test(m)) return json({ error: 'Bad message id' }, 400);
  return json({ images: await gmailImageParts(env, m) });
}

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
      if (path === '/admin') return shell();
      if (path === '/admin/app.js') return asset(CLIENT_JS, 'text/javascript');
      if (path === '/admin/app.css') return asset(CLIENT_CSS, 'text/css');
      if (path === '/admin/api/mail-images') return await mailImages(env, url);
      if (path === '/admin/api/session') return json({ email: auth.email, csrf: await makeCsrf(env, auth.email) });
      if (path === '/admin/api/state') return json(await state(env, auth.email));
      if (path === '/admin/api/photo-file') return fromResult(await fileInfo(env, String(url.searchParams.get('id') || '')));
      if (path === '/admin/api/photo-group') return fromResult(await dupMembers(env, String(url.searchParams.get('id') || '')));
      if (path === '/admin/api/photo-name') {
        return fromResult(await previewName(env, { id: String(url.searchParams.get('id') || ''), name: String(url.searchParams.get('name') || '') }));
      }
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
      if (path === '/admin/api/photo-file') return await doFileOp(env, body);
      return json({ ok: false, error: 'Not found' }, 404);
    }
    return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS });
  } catch (e) {
    console.error(`Admin ${request.method} ${path}: ${e.stack || e.message}`);
    return json({ ok: false, error: e.message }, 502);
  }
}
