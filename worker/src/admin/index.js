// worker/src/admin/index.js
// Admin panel, served under /admin by the approvals Worker. Cloudflare Access sits in
// front; every request here (pages, API, images) is checked again with verifyAccess,
// so the workers.dev URL can't skip it. The Sheet stays the source of truth.
//   GET  /admin, /admin/app.js, /admin/app.css   the panel (ui/client.js, ui/css.js)
//   GET  /admin/api/session         { email, csrf }
//   GET  /admin/api/state           Pending, Replies (awaiting and still owed; sent: the latest
//                                   100 sent, for the Sent history), Photos (all
//                                   in Drive) and the Lenches Photos folders, holiday mode,
//                                   latest newsletter, Health, watchdog, Google account;
//                                   each Photos row's _pages: the public pages it is on
//                                   (photopages.js, from the site's photo-pages.json)
//                                   each Pending event with no image: _suggest, its rows in
//                                   Image suggestions (thumbnails are data: JPEGs made by the
//                                   pipeline; the browser never loads anything from outside)
//                                   photoFolders: [{ id, parent, names }] live from Drive,
//                                   for the Photos menu and the drop/Move to… targets
//                                   feedback: Feedback rows still needing Jon (feedback.js)
//   GET  /admin/api/mail-images?m=  every image in one email (for a Pending item)
//   GET  /admin/api/mail-text?m=    one email's from, subject, date and text (Replies: their
//                                   email beside Holly's draft; shown as plain text only)
//   POST /admin/api/edit            { tab, key, field, expected, value }: one plain field
//                                   edit, refused (409, current value) if the cell changed
//   POST /admin/api/action          { kind: pending|reply|photo, id, action, reason?, body?,
//                                   expected? }: decisions go through core.js decide(),
//                                   the same path as the signed email links
//   POST /admin/api/action          kind feedback: approve, reject (reason?), postpone (date), done
//                                   (Mark implemented), send, edit (body), skip: also decide()
//   POST /admin/api/feedback-note   { id, expected, note }: a timestamped note appended to
//                                   the Feedback row's notes (stale-checked, never overwrites)
//   POST /admin/api/suggest         { id, sid, expected }: Choose a suggested image (sid = an
//                                   Image suggestions id) or "None of these" (sid "none") for a
//                                   Pending event with no image: a stale-checked image_choice
//                                   write (actions.js planSuggest); an organiser's or Pexels
//                                   image is also queued once for Lenches Photos (Image fetch)
//   GET  /admin/api/contacts        the Contacts tab, ignore rows left out (contacts.js)
//   POST /admin/api/contact         { email, field, expected, value }: one stale-checked edit of
//                                   a contact's name, organisation, village, role, profile (each
//                                   also sets profile_source "manual"), notes or status
//   POST /admin/api/contact-delete  { email, expected }: removes the contact's row (status still as
//                                   loaded) and logs it in Deleted contacts (made if missing)
//   GET  /admin/api/outreach        who is due a nudge (outreach.mjs outreachLists: seasonal, gone
//                                   quiet, leads, and those held back), from Contacts + Replies
//   POST /admin/api/nudge           { email }: Draft nudge, if planNudge allows it today, goes
//                                   through decide() (action nudge, id = idFor(email)); Holly's
//                                   draft then waits in Replies for the usual Approve / Edit
//   (Snooze, Never nudge and Clear are /admin/api/contact writes of next_nudge.)
//   GET  /admin/api/orgs            organisation outreach (orgoutreach.mjs orgLists): each
//                                   organisation in contacts.json `outreach` and its state, from
//                                   Replies, Contacts and the Org outreach tab, plus a Gmail
//                                   search per due one (emailed us in 3 months = regular contact)
//   POST /admin/api/orgcheck        { id }: Draft check / Draft chaser, if planOrgCheck allows it
//                                   today, through decide() (action orgcheck, id = the slug)
//   POST /admin/api/orgnext         { id, expected, value }: Done / Snooze / Never / Clear, one
//                                   stale-checked next_check write (the tab and row are made if
//                                   missing)
//   POST /admin/api/orgemails       { id, expected, value }: the organisation's other addresses
//                                   (Org outreach other_emails, comma separated; same rules)
//   GET  /admin/api/lessons         the Holly lessons tab, newest first (lessons.js)
//   POST /admin/api/lesson          { op: add, value } (a new approved lesson; the tab is made
//                                   if missing) | { op: edit, id, expected, value } (stale-
//                                   checked) | { op: delete, id, expected } (row removed if its
//                                   text is still as loaded) | { op: decide, id, action:
//                                   approve|reject } (a proposed lesson, through decide())
//   GET  /admin/api/photo-file?id=  a Photos file's live Drive name and folder, and the
//                                   Lenches Photos folders it can move to
//   GET  /admin/api/photo-group?id= every copy in a possible-duplicate group
//   GET  /admin/api/photo-name?id=&name=  the name a rename would save as (core-N if the
//                                   name is in use anywhere under Lenches Photos)
//                                   toDelete: every file in To delete, with where it came
//                                   from and when it moved (photofiles.js binList)
//   GET  /admin/api/photo-tidy      the one-off tidy list: files in a Rejected folder, or
//                                   marked rejected outside To delete (nothing moves)
//   POST /admin/api/photo-file      { op: rename|move|discard|restore, ... }: Drive file
//                                   management, stale-checked, inside Lenches Photos only
//                                   (photofiles.js); nothing is ever created, binned or deleted
//   GET  /admin/page?p=/privacy/    Edit page: the live page with the in-page editor
//                                   (pageedit.js; footer "Edit page" link on the site)
//   POST /admin/api/page-save       { path, changes }: wording and link edits to that page's
//                                   .njk file, one commit to main (pageedit.js savePage)
//   GET  /admin/api/summary         the Summary page's own sections (summary.js): next newsletter,
//                                   failing runs, subscriber counts, coming up this week, outreach
//                                   due, lessons awaiting approval, dev tasks, visitors (visitors.js;
//                                   { off } until its secrets are set) (each { error } alone
//                                   if its source can't be read); the rest comes from /api/state
//   GET  /admin/draft               Newsletter draft: the next issue as it would be built now (or
//                                   its frozen copy once built), from the Newsletter draft tab
//                                   (draft.js; scripts/newsletter/draft.js), framed by the panel
//   GET  /admin/api/draft           that draft's meta only (as_of, issue_date, mode, counts)
//   POST /admin/api/draft-refresh   runs newsletter-draft.yml now (repository_dispatch); sends nothing
//   POST /admin/api/newsletter      { action: rebuild|test, issue_date } through decide():
//                                   rebuild (nlquiet) sends nothing; test (nltest) sends only the
//                                   preview, with its Send button, to preview_to (Jon)
//   GET  /admin/api/nlstats?i=DATE  Newsletter stats (nlstats.js): sent issues with sent, bounced,
//                                   and anonymous opens and clicks; for one issue, opens by day and
//                                   hour and the most-clicked links (totals only, never per person)
//   GET  /admin/api/runs            Activity: the latest 20 GitHub Actions runs (runs.js; read-only)
//   GET  /admin/api/build-status?sha=&at=&p=&text=  whether an Edit page commit is live: its
//                                   site build succeeded AND the page (fresh copy) shows text
//   GET  /admin/img/mail/MSG/PART   a Pending image (email attachment)
//   GET  /admin/img/drive/ID[?size=N]  a Photos image (Drive thumbnail, else the file)
// Nothing here can send the newsletter to subscribers (Test send emails Jon's preview only) or change repository code, except Edit page's
// wording edits to page templates (src/*.njk, pageedit.js). Otherwise the only GitHub call
// is decide(), for the item and reply actions listed in actions.js, the Feedback
// actions in feedback.js, outreach's nudge (a draft only; it never sends) and approving or
// rejecting a proposed Holly lesson.

import { ACTIONS, decide, github, dispatch } from '../core.js';
import { verifyAccess } from './access.js';
import { makeCsrf, checkCsrf, sameOrigin } from './csrf.js';
import {
  getValues, sheetGids, gmailImage, gmailImageParts, gmailText, gmailAny, driveImage, serviceAccountEmail, appendValues, addTab, deleteRow, writeCells,
} from './google.js';
import { readTable, readSettingsPairs, editCell, checkedWrite, colLetter } from './sheet.js';
import {
  planPending, planReply, planPhoto, planSuggest, trustKeyFor, truthy, hasOwnImage, SUGGEST_TAB, SUGGEST_SOURCES,
  planNewsletter,
} from './actions.js';
import { owedReplies } from './owed.js';
import {
  fileInfo, folderList, dupMembers, previewName, renameFile, moveFile, discardFile, restoreFile, binList, tidyList,
} from './photofiles.js';
import { photoPages, pagesFor, eventEnd } from './photopages.js';
import { feedbackRows, planFeedback, planNote } from './feedback.js';
import { FEEDBACK_TAB } from '../feedback.js';
import {
  CONTACTS_TAB, DELETED_TAB, DELETED_HEADERS, contactRows, planContact, planDelete, addressesOf,
} from './contacts.js';
import { outreachLists, planNudge, idFor, sentRows } from './outreach.mjs';
import {
  ORG_TAB, ORG_HEADERS, orgEntries, orgLists, planOrgCheck, planNext, planOtherEmails, dueOrgs, recentQuery,
} from './orgoutreach.mjs';
// The site's own data, bundled at deploy (deploy-worker.yml also deploys when these change).
import contactsData from '../../../src/_data/contacts.json' with { type: 'json' };
import councilData from '../../../src/_data/council.json' with { type: 'json' };
import schoolsData from '../../../src/_data/schools.json' with { type: 'json' };
import healthData from '../../../src/_data/health.json' with { type: 'json' };
import transportData from '../../../src/_data/transport.json' with { type: 'json' };
import {
  LESSONS_TAB, LESSON_HEADERS, lessonRows, cleanLesson, newLessonRow, planLessonDecision,
} from './lessons.js';
import { CLIENT_CSS } from './ui/css.js';
import { CLIENT_JS, UI_VERSION } from './ui/client.js';
import { PAGEEDIT_JS, PAGEEDIT_CSS, PAGEEDIT_VERSION } from './ui/pageedit.js';
import { editorPage, savePage, showsText } from './pageedit.js';
import { recentRuns, buildStatus } from './runs.js';
import {
  nextIssue, failingRuns, subscriberChanges, lastSentDate, comingWeek, comingUpFile, devTasks,
} from './summary.js';
import { visitors } from './visitors.js';
import { nlStats } from './nlstats.js';
import { DRAFT_TAB, DRAFT_RANGE, draftMeta, draftHtml, draftPage } from './draft.js';

const MAX_BODY = 60000;
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
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
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

// Organisers' images: Image fetch rows saved to Drive, by Drive file id. end = the
// event's last day (end date, else date; '' if the row has no event), for "Past events".
function organiserImages(t, onSite) {
  const out = {};
  if (t.error) return out;
  for (const r of t.rows) {
    const id = String(r.drive_file_id || '').trim();
    if (id) out[id] = { event: r.event || '', source_page: r.source_page || '', credit: r.credit || '', end: eventEnd(onSite, r.event) };
  }
  return out;
}

// Suggestion fields the panel shows (never the run's working columns).
const SUGGEST_FIELDS = ['id', 'source', 'rank', 'caption', 'credit', 'page', 'licence', 'people', 'thumb', 'alt', 'status'];
const THUMB = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

// Image suggestions by Pending id: { id: [suggestion, ...] } ("none" rows give an empty list).
function suggestionsByItem(t) {
  const out = {};
  if (!t || t.error) return out;
  for (const r of t.rows) {
    const item = String(r.item || '').trim();
    if (!item) continue;
    out[item] = out[item] || [];
    if (!SUGGEST_SOURCES[r.source]) continue;
    const s = pick(r, SUGGEST_FIELDS);
    if (!THUMB.test(String(s.thumb || ''))) s.thumb = '';
    out[item].push(s);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
  return out;
}

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

// The Feedback tab; none yet (made by the first submission) reads as empty.
async function readFeedback(env) {
  try {
    return await readTable(env, FEEDBACK_TAB);
  } catch (e) {
    if (e.status === 400 && /Unable to parse range/i.test(e.message)) return { headers: [], rows: [] };
    throw e;
  }
}

// The Newsletter draft tab's rows; none yet (made by its first run) reads as empty.
async function readDraft(env, range) {
  try {
    return await getValues(env, range);
  } catch (e) {
    if (e.status === 400 && /Unable to parse range/i.test(e.message)) return [];
    throw e;
  }
}

async function state(env, email) {
  const photosRead = readTable(env, 'Photos');
  const [pending, replies, photos, settings, health, issues, gids, sources, web, dog, folders, onSite, bin, sugg, fb, draftRows] = await settled([
    readTable(env, 'Pending'), readTable(env, 'Replies'), photosRead,
    readSettingsPairs(env), readTable(env, 'Health'), readTable(env, 'Issues'), sheetGids(env),
    readSources(env), readTable(env, 'Image fetch'), watchdog(env), folderList(env), photoPages(env),
    binList(env, photosRead), readTable(env, SUGGEST_TAB), readFeedback(env), readDraft(env, `'${DRAFT_TAB}'!A1:B13`),
  ]);
  const suggested = suggestionsByItem(sugg);
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
        // Suggested images: only for events with no image of their own that the run has looked at.
        _suggest: String(r.category || '').trim().toLowerCase() === 'event' && !hasOwnImage(r) && suggested[r.id] ? suggested[r.id] : null,
      })),
    };
  }
  const owed = replies.error ? replies : owedReplies(replies.rows).map(({ holding, draft }) => ({
    holding: pick(holding, REPLY_FIELDS),
    draft: draft ? pick(draft, REPLY_FIELDS) : null,
  }));
  const fromWeb = organiserImages(web, onSite);
  return {
    email,
    sheetId: String(env.SHEET_ID || ''),
    gids: gids.error ? {} : gids,
    holiday: holiday.error ? holiday : { value: holiday.value, on: String(holiday.value).trim().toUpperCase() === 'TRUE' },
    newsletter,
    // The Newsletter draft's meta (null until its first run).
    draft: draftRows.error ? draftRows : draftMeta(draftRows),
    health: health.error ? health : filled(health).slice(-7).reverse(),
    watchdog: dog,
    // The Google service account in use (the panel is admins only, behind Access).
    googleAccount: serviceAccountEmail(env),
    pending: pend,
    replies: replies.error ? replies : { headers: replies.headers, rows: replies.rows.filter((r) => r.status === 'awaiting') },
    // The latest 100 sent replies and outreach emails (Replies screen, Sent history).
    sent: replies.error ? [] : sentRows(replies.rows),
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
    toDelete: bin,
    feedback: feedbackRows(fb, ukToday()),
    // Today in the UK, for the Past events filter.
    today: ukToday(),
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
    const row = matches.length === 1 ? matches[0] : null;
    // The chosen suggested image's people value, for the People OK check.
    const choice = row && !hasOwnImage(row) ? String(row.image_choice || '').trim() : '';
    let choicePeople = '';
    if (choice && choice !== 'none') {
      const s = (await readTable(env, SUGGEST_TAB)).rows.filter((x) => String(x.id) === choice && String(x.item) === id);
      choicePeople = s.length === 1 ? String(s[0].people || '') : '';
    }
    plan = planPending({ action, id }, row, { hasPeopleOk: headers.includes('people_ok'), sources, choicePeople });
  } else if (kind === 'reply') {
    plan = planReply({ action, id, reason: body.reason, body: body.body });
  } else if (kind === 'feedback') {
    const { rows } = await readFeedback(env);
    const matches = rows.filter((r) => id && r.id === id);
    plan = planFeedback({ action, id, date: body.date, body: body.body, reason: body.reason }, matches.length === 1 ? matches[0] : null, ukToday());
  } else {
    return json({ ok: false, error: `Unknown kind "${kind}"` }, 400);
  }
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  if (!(await decide(env, plan.p, plan.reason || '', plan.body || ''))) {
    return json({ ok: false, error: 'GitHub did not accept the request. Nothing has changed; try again in a few minutes.' }, 502);
  }
  return json({ ok: true, message: `${ACTIONS[plan.p.a][1]}. It takes a minute or two to show in the Sheet.` });
}

async function doNote(env, body) {
  const id = String(body.id ?? '');
  const { rows } = await readFeedback(env);
  const matches = rows.filter((r) => id && r.id === id);
  const plan = planNote({ note: body.note, expected: body.expected }, matches.length === 1 ? matches[0] : null);
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  const r = await checkedWrite(env, {
    tab: FEEDBACK_TAB, keyCol: 'id', key: id, field: 'notes', expected: body.expected, value: plan.value,
  });
  return r.ok ? json({ ok: true, value: r.value, message: 'Note added.' }) : json(r, r.status);
}

async function doSuggest(env, body) {
  const id = String(body.id ?? '');
  const sid = String(body.sid ?? '');
  const [{ headers, rows }, sugg] = await Promise.all([
    readTable(env, 'Pending'), sid === 'none' ? { rows: [] } : readTable(env, SUGGEST_TAB),
  ]);
  const matches = rows.filter((r) => id && r.id === id);
  const found = sugg.rows.filter((r) => sid && String(r.id) === sid);
  const plan = planSuggest({ id, sid }, matches.length === 1 ? matches[0] : null, found.length === 1 ? found[0] : null,
    { hasChoice: headers.includes('image_choice'), hasPeopleOk: headers.includes('people_ok') });
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  const r = await checkedWrite(env, {
    tab: 'Pending', keyCol: 'id', key: id, field: 'image_choice', expected: body.expected, value: plan.value, onlyStatus: 'pending',
  });
  if (!r.ok) return json(r, r.status);
  if (plan.value === 'none') return json({ ok: true, value: r.value, message: 'No image for this item.' });
  let message = 'Chosen. It becomes the image when you approve the item.';
  if (plan.save) {
    try {
      const fetchHeaders = (await readTable(env, 'Image fetch')).headers;
      if (!fetchHeaders.includes('url')) throw new Error('the Image fetch tab has no url column');
      await appendValues(env, 'Image fetch', [fetchHeaders.map((h) => (h && plan.save[h] !== undefined ? plan.save[h] : ''))]);
      await checkedWrite(env, { tab: SUGGEST_TAB, keyCol: 'id', key: sid, field: 'status', expected: found[0].status || '', value: 'saved' });
      message += ' A copy goes to Lenches Photos within the hour.';
    } catch (e) {
      console.error(`Suggest save ${sid}: ${e.message}`);
      message += ` Saving a copy to Lenches Photos failed (${e.message}): choose it again to retry.`;
    }
  }
  return json({ ok: true, value: r.value, message });
}

async function doContact(env, body) {
  const email = String(body.email ?? '');
  const { rows } = await readTable(env, CONTACTS_TAB);
  const matches = rows.filter((r) => email && String(r.email ?? '') === email);
  const plan = planContact({ field: body.field, value: body.value }, matches.length === 1 ? matches[0] : null);
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  const r = await checkedWrite(env, {
    tab: CONTACTS_TAB, keyCol: 'email', key: email, field: plan.field, expected: body.expected, value: plan.value, also: plan.also,
  });
  if (!r.ok) return json(r, r.status);
  return json({ ok: true, value: r.value, profileSource: plan.also ? plan.also.profile_source : undefined, message: 'Saved.' });
}

// The Deleted contacts tab's headers, making the tab on the first delete.
async function deletedHeaders(env) {
  try {
    const { headers } = await readTable(env, DELETED_TAB);
    if (headers.includes('email') && headers.includes('deleted_at')) return headers;
    if (headers.some(Boolean)) throw new Error('the Deleted contacts tab has no email / deleted_at headers');
  } catch (e) {
    if (!(e.status === 400 && /Unable to parse range/i.test(e.message))) throw e;
    await addTab(env, DELETED_TAB);
  }
  await appendValues(env, DELETED_TAB, [DELETED_HEADERS]);
  return DELETED_HEADERS;
}

async function doContactDelete(env, body) {
  const email = String(body.email ?? '');
  const find = async () => (await readTable(env, CONTACTS_TAB)).rows.filter((r) => email && String(r.email ?? '') === email);
  let matches = await find();
  const plan = planDelete({ expected: body.expected }, matches.length === 1 ? matches[0] : null);
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  // Logged first: if the row delete then fails, the log alone changes nothing visible.
  // Every address the row stands for (other_emails too), so none of them brings it back.
  const headers = await deletedHeaders(env);
  const at = new Date().toISOString();
  await appendValues(env, DELETED_TAB, addressesOf(matches[0]).map((e) => headers.map((h) => ({ email: e, deleted_at: at })[h] ?? '')));
  // Re-found just before deleting, so the row number is current.
  matches = await find();
  if (matches.length !== 1) return json({ ok: false, error: 'The contact moved in the Sheet: reload the page' }, 409);
  const gids = await sheetGids(env);
  if (gids[CONTACTS_TAB] === undefined) return json({ ok: false, error: 'No Contacts tab' }, 404);
  await deleteRow(env, gids[CONTACTS_TAB], matches[0]._row);
  return json({ ok: true, message: 'Deleted from Contacts. Their newsletter subscription is unchanged.' });
}

async function outreach(env) {
  const [contacts, replies] = await Promise.all([readTable(env, CONTACTS_TAB), readTable(env, 'Replies')]);
  const live = contactRows(contacts).rows;
  return { today: ukToday(), hasNextNudge: contacts.headers.includes('next_nudge'), ...(await outreachLists(live, replies.rows, ukToday())) };
}

// The Summary page's sections not in /api/state. Contacts and Replies are read once for
// both outreach counts; organisations take the same Gmail look-ups as their own screen.
async function summary(env) {
  const today = ukToday();
  const [issues, pending, subs, dns, lessons, contacts, replies, orgTab, runs, coming, seen, sends] = await settled([
    readTable(env, 'Issues'), readTable(env, 'Pending'), readTable(env, 'Subscribers'), readTable(env, 'Do Not Send'),
    readLessons(env), readTable(env, CONTACTS_TAB), readTable(env, 'Replies'), readOrgTab(env), recentRuns(env, 50), comingUpFile(env), visitors(env), readTable(env, 'Sends'),
  ]);
  const fail = (t) => (t && t.error ? { error: t.error } : null);
  const issueRows = issues.error ? [] : issues.rows;
  let outreachDue;
  let orgsDue;
  if (contacts.error || replies.error) {
    outreachDue = fail(contacts) || fail(replies);
    orgsDue = outreachDue;
  } else {
    const o = await outreachLists(contactRows(contacts).rows, replies.rows, today);
    outreachDue = { seasonal: o.seasonal.length, quiet: o.quiet.length, lead: o.lead.length };
    if (orgTab.error) orgsDue = fail(orgTab);
    else {
      try {
        const { lists } = orgLists(ORGS, await orgContext(env, [replies, contacts, orgTab]));
        orgsDue = { due: lists.due.length, chase: lists.chase.length };
      } catch (e) {
        orgsDue = { error: e.message };
      }
    }
  }
  return {
    today,
    issue: issues.error ? fail(issues) : nextIssue({ today, issues: issueRows, pending: pending.error ? [] : pending.rows, coming: coming.error ? null : coming }),
    failing: runs.error ? fail(runs) : failingRuns(runs),
    subscribers: subs.error || dns.error ? (fail(subs) || fail(dns)) : subscriberChanges(subs.rows, dns.rows, lastSentDate(today, issueRows)),
    coming: comingWeek(coming, today),
    outreach: outreachDue,
    orgs: orgsDue,
    lessons: lessons.error ? fail(lessons) : lessonRows(lessons).rows.filter((r) => r.status.toLowerCase() === 'proposed').map((r) => ({ id: r.id, lesson: r.lesson })),
    devTasks: devTasks(),
    visitors: seen,
    // The last newsletter sent: sent, bounced, opens, clicks (no per-issue detail).
    lastSent: issues.error || sends.error || dns.error ? null
      : ((await nlStats(env, { issues: issues.rows, sends: sends.rows, dns: dns.rows }, '', false)).issues[0] || null),
  };
}

async function doNudge(env, body) {
  const email = String(body.email ?? '');
  const [contacts, replies] = await Promise.all([readTable(env, CONTACTS_TAB), readTable(env, 'Replies')]);
  const matches = contacts.rows.filter((r) => email && String(r.email ?? '') === email);
  const plan = planNudge(matches.length === 1 ? matches[0] : null, replies.rows, ukToday());
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  if (!(await decide(env, { a: 'nudge', i: await idFor(email) }))) {
    return json({ ok: false, error: 'GitHub did not accept the request. Nothing has changed; try again in a few minutes.' }, 502);
  }
  return json({ ok: true, message: 'Draft requested. Holly emails you the draft to approve in a minute or two.' });
}

// Organisation outreach.
const ORGS = orgEntries({ contacts: contactsData, council: councilData, schools: schoolsData, health: healthData, transport: transportData });

// The Org outreach tab, or { headers: [], rows: [], missing: true } if it doesn't exist yet.
async function readOrgTab(env) {
  try {
    return await readTable(env, ORG_TAB);
  } catch (e) {
    if (e.status === 400 && /Unable to parse range/i.test(e.message)) return { headers: [], rows: [], missing: true };
    throw e;
  }
}

// pre: the Replies, Contacts and Org outreach tables when already read (Summary).
async function orgContext(env, pre = null) {
  const [replies, contacts, tab] = pre || await Promise.all([readTable(env, 'Replies'), readTable(env, CONTACTS_TAB), readOrgTab(env)]);
  const ctx = { replies: replies.rows, contacts: contacts.rows, orgRows: tab.rows, hasTab: tab.headers.includes('next_check'), today: ukToday() };
  // In regular contact: those otherwise due (or held by a date) who emailed us from any of their
  // addresses in the last 3 months (one Gmail search each, only for those; a few dozen at most).
  const due = dueOrgs(ORGS, ctx);
  const found = await Promise.all(due.map((d) => gmailAny(env, recentQuery(d.addresses))));
  return { ...ctx, recent: new Set(due.filter((d, i) => found[i]).map((d) => d.id)) };
}

async function doOrgCheck(env, body) {
  const id = String(body.id ?? '');
  const ctx = await orgContext(env);
  const org = ORGS.find((o) => o.id === id) || null;
  const plan = planOrgCheck(org, { ...ctx, orgRow: ctx.orgRows.find((r) => String(r.id ?? '') === id) || null });
  if (plan.error) return json({ ok: false, ...plan }, plan.status);
  if (!(await decide(env, { a: 'orgcheck', i: id }))) {
    return json({ ok: false, error: 'GitHub did not accept the request. Nothing has changed; try again in a few minutes.' }, 502);
  }
  return json({ ok: true, message: `${plan.kind === 'chase' ? 'Chaser' : 'Check'} requested. Holly emails you the draft to approve in a minute or two.` });
}

// One stale-checked Org outreach cell for organisation `id`. Makes the tab, its headers, a
// missing header (at the end) or the organisation's row as needed.
async function orgWrite(env, id, field, expected, value) {
  let { headers, rows, missing } = await readOrgTab(env);
  if (!headers.some(Boolean)) {
    if (missing) await addTab(env, ORG_TAB);
    await appendValues(env, ORG_TAB, [ORG_HEADERS]);
    headers = ORG_HEADERS;
    rows = [];
  } else if (!headers.includes('id')) {
    return json({ ok: false, error: 'The Org outreach tab has no id header' }, 400);
  } else if (!headers.includes(field)) {
    await writeCells(env, [{ range: `'${ORG_TAB}'!${colLetter(headers.length)}1`, values: [[field]] }]);
    headers = [...headers, field];
  }
  if (!rows.some((r) => String(r.id ?? '') === id)) {
    if (String(expected ?? '') !== '') return json({ ok: false, error: 'Changed in the Sheet since you loaded the page', current: '' }, 409);
    await appendValues(env, ORG_TAB, [headers.map((h) => ({ id, [field]: value })[h] ?? '')]);
    return json({ ok: true, value });
  }
  const r = await checkedWrite(env, { tab: ORG_TAB, keyCol: 'id', key: id, field, expected, value });
  return r.ok ? json({ ok: true, value: r.value }) : json(r, r.status);
}

async function doOrgNext(env, body) {
  const id = String(body.id ?? '');
  if (!ORGS.some((o) => o.id === id)) return json({ ok: false, error: 'No such organisation: reload the page' }, 404);
  const plan = planNext(body.value);
  if (plan.error) return json({ ok: false, ...plan }, 400);
  return orgWrite(env, id, 'next_check', body.expected, plan.value);
}

async function doOrgEmails(env, body) {
  const id = String(body.id ?? '');
  if (!ORGS.some((o) => o.id === id)) return json({ ok: false, error: 'No such organisation: reload the page' }, 404);
  const plan = planOtherEmails(body.value);
  if (plan.error) return json({ ok: false, ...plan }, 400);
  return orgWrite(env, id, 'other_emails', body.expected, plan.value);
}

// The Holly lessons tab, or an empty list if it doesn't exist yet.
async function readLessons(env) {
  try {
    return await readTable(env, LESSONS_TAB);
  } catch (e) {
    if (e.status === 400 && /Unable to parse range/i.test(e.message)) return { headers: [], rows: [] };
    throw e;
  }
}

const ukNow = () => {
  const d = new Date();
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${ukToday()} ${t}`;
};

async function doLesson(env, body) {
  const op = String(body.op || '');
  const id = String(body.id ?? '');
  if (op === 'add') {
    const c = cleanLesson(body.value);
    if (c.error) return json({ ok: false, ...c }, c.status);
    let t = await readLessons(env);
    if (!t.headers.includes('lesson')) {
      if (t.headers.some(Boolean)) return json({ ok: false, error: 'The Holly lessons tab has no lesson column' }, 409);
      if (!t.headers.length) await addTab(env, LESSONS_TAB).catch(() => {});
      await appendValues(env, LESSONS_TAB, [LESSON_HEADERS]);
      t = { headers: LESSON_HEADERS, rows: [] };
    }
    const { row, values } = newLessonRow(t.headers, t.rows, c.value, ukToday(), ukNow());
    await appendValues(env, LESSONS_TAB, [values]);
    return json({ ok: true, row, message: 'Lesson added. Holly uses it from the next run.' });
  }
  const t = await readLessons(env);
  const matches = t.rows.filter((r) => id && String(r.id ?? '') === id);
  const row = matches.length === 1 ? matches[0] : null;
  if (op === 'edit') {
    const c = cleanLesson(body.value);
    if (c.error) return json({ ok: false, ...c }, c.status);
    const r = await checkedWrite(env, { tab: LESSONS_TAB, keyCol: 'id', key: id, field: 'lesson', expected: body.expected, value: c.value });
    return r.ok ? json({ ok: true, value: r.value, message: 'Lesson saved.' }) : json(r, r.status);
  }
  if (op === 'delete') {
    if (!row) return json({ ok: false, error: 'No such lesson: reload the page' }, 404);
    if (String(row.lesson ?? '') !== String(body.expected ?? '')) {
      return json({ ok: false, error: 'Changed in the Sheet since you loaded the page', current: String(row.lesson ?? '') }, 409);
    }
    const gids = await sheetGids(env);
    if (gids[LESSONS_TAB] === undefined) return json({ ok: false, error: 'No Holly lessons tab' }, 404);
    await deleteRow(env, gids[LESSONS_TAB], row._row);
    return json({ ok: true, message: 'Lesson deleted.' });
  }
  if (op === 'decide') {
    const plan = planLessonDecision({ action: body.action, id }, row);
    if (plan.error) return json({ ok: false, ...plan }, plan.status);
    if (!(await decide(env, plan.p))) {
      return json({ ok: false, error: 'GitHub did not accept the request. Nothing has changed; try again in a few minutes.' }, 502);
    }
    return json({ ok: true, message: `${ACTIONS[plan.p.a][1]}. It takes a minute or two to show.` });
  }
  return json({ ok: false, error: `Unknown op "${op}"` }, 400);
}

const fromResult = (r) => (r.ok ? json(r) : json(r, r.status));

// Photos file management: one operation per request.
const FILE_OPS = {
  rename: (env, b) => renameFile(env, { id: String(b.id || ''), expected: b.expected, name: b.name }),
  move: (env, b) => moveFile(env, { id: String(b.id || ''), expectedParent: b.expectedParent, to: b.to }),
  discard: (env, b) => discardFile(env, {
    id: String(b.id || ''), expected: b.expected, expectedParent: b.expectedParent, confirmPublished: b.confirmPublished === true,
  }),
  restore: (env, b) => restoreFile(env, { id: String(b.id || ''), expectedParent: b.expectedParent }),
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

async function mailText(env, url) {
  const m = String(url.searchParams.get('m') || '');
  if (!/^[A-Za-z0-9]{6,40}$/.test(m)) return json({ error: 'Bad message id' }, 400);
  return json(await gmailText(env, m));
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
      if (path === '/admin/pageedit.js') return asset(PAGEEDIT_JS, 'text/javascript');
      if (path === '/admin/pageedit.css') return asset(PAGEEDIT_CSS, 'text/css');
      if (path === '/admin/page') {
        const pg = await editorPage(env, {
          page: url.searchParams.get('p'), origin: url.origin, csrf: await makeCsrf(env, auth.email), version: PAGEEDIT_VERSION,
        });
        return new Response(pg.html, {
          status: pg.status,
          headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pg.csp },
        });
      }
      if (path === '/admin/draft') return draftPage(await draftHtml(await readDraft(env, DRAFT_RANGE)));
      if (path === '/admin/api/draft') return json({ meta: draftMeta(await readDraft(env, `'${DRAFT_TAB}'!A1:B13`)) });
      if (path === '/admin/api/mail-images') return await mailImages(env, url);
      if (path === '/admin/api/mail-text') return await mailText(env, url);
      if (path === '/admin/api/session') return json({ email: auth.email, csrf: await makeCsrf(env, auth.email) });
      if (path === '/admin/api/state') return json(await state(env, auth.email));
      if (path === '/admin/api/contacts') return json(contactRows(await readTable(env, CONTACTS_TAB)));
      if (path === '/admin/api/outreach') return json(await outreach(env));
      if (path === '/admin/api/orgs') return json(orgLists(ORGS, await orgContext(env)));
      if (path === '/admin/api/lessons') return json(lessonRows(await readLessons(env)));
      if (path === '/admin/api/summary') return json(await summary(env));
      if (path === '/admin/api/nlstats') {
        const [issues, sends, dns] = await Promise.all([readTable(env, 'Issues'), readTable(env, 'Sends'), readTable(env, 'Do Not Send')]);
        return json(await nlStats(env, { issues: issues.rows, sends: sends.rows, dns: dns.rows }, String(url.searchParams.get('i') || '')));
      }
      if (path === '/admin/api/runs') return json({ runs: await recentRuns(env, 20) });
      if (path === '/admin/api/build-status') {
        const st = await buildStatus(env, url.searchParams.get('sha'), url.searchParams.get('at'));
        // Built is not yet visible: wait until the published page shows the new wording.
        if (st.ok && st.state === 'live' && !(await showsText(env, url.searchParams.get('p'), url.searchParams.get('text')))) {
          st.state = 'building';
          st.phase = 'publishing';
        }
        return fromResult(st);
      }
      if (path === '/admin/api/photo-file') return fromResult(await fileInfo(env, String(url.searchParams.get('id') || '')));
      if (path === '/admin/api/photo-group') return fromResult(await dupMembers(env, String(url.searchParams.get('id') || '')));
      if (path === '/admin/api/photo-tidy') return fromResult(await tidyList(env));
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
      if (path === '/admin/api/suggest') return await doSuggest(env, body);
      if (path === '/admin/api/feedback-note') return await doNote(env, body);
      if (path === '/admin/api/contact') return await doContact(env, body);
      if (path === '/admin/api/contact-delete') return await doContactDelete(env, body);
      if (path === '/admin/api/nudge') return await doNudge(env, body);
      if (path === '/admin/api/orgcheck') return await doOrgCheck(env, body);
      if (path === '/admin/api/orgnext') return await doOrgNext(env, body);
      if (path === '/admin/api/orgemails') return await doOrgEmails(env, body);
      if (path === '/admin/api/lesson') return await doLesson(env, body);
      if (path === '/admin/api/photo-file') return await doFileOp(env, body);
      if (path === '/admin/api/draft-refresh') {
        if (!(await dispatch(env, 'newsletter-draft', {}, 2))) return json({ ok: false, error: 'GitHub did not accept the request. Try again in a few minutes.' }, 502);
        return json({ ok: true, message: 'Refreshing: the new draft shows in a minute or two.' });
      }
      if (path === '/admin/api/newsletter') {
        const plan = planNewsletter({ action: body.action, issueDate: body.issue_date }, ukToday());
        if (plan.error) return json({ ok: false, error: plan.error }, plan.status);
        if (!(await decide(env, plan.p))) return json({ ok: false, error: 'GitHub did not accept the request. Try again in a few minutes.' }, 502);
        return json({ ok: true, message: plan.p.a === 'nlquiet'
          ? 'Rebuilding: nothing is sent. The draft shows the new build in a few minutes.'
          : 'Test send started: the preview should reach your inbox in a few minutes.' });
      }
      if (path === '/admin/api/page-save') return fromResult(await savePage(env, body));
      return json({ ok: false, error: 'Not found' }, 404);
    }
    return new Response('Method not allowed', { status: 405, headers: SECURITY_HEADERS });
  } catch (e) {
    console.error(`Admin ${request.method} ${path}: ${e.stack || e.message}`);
    return json({ ok: false, error: e.message }, 502);
  }
}
