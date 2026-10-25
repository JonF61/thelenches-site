// worker/src/feedback.js
// Reader feedback form (every site page, src/_includes/feedback.njk) -> Feedback tab.
//   POST /f   public, never behind Cloudflare Access (same rule as /a and /u: readers
//             have no Access login). Order: same-site check, per-IP rate limit, honeypot,
//             validation, Turnstile, daily cap, then one appended row. Nothing is emailed:
//             Jon sees new rows in the admin panel's Feedback screen. Claude's rating and
//             commentary are added later by the ingestion run (scripts/readerfeedback).
// The page's script sends js=1 and gets JSON back (CORS, site origin only). Without
// JavaScript the form still posts here and gets a plain page back; Turnstile needs
// JavaScript, so that page explains and offers the email address instead.
// The tab is created here on the first submission (at the end, header row only); columns
// are read by header name, so Jon can add columns at the end later.

import { getValues, appendValues, sheetGids, addTab, writeCells } from './admin/google.js';
import { tableFrom } from './admin/sheet.js';

export const FEEDBACK_TAB = 'Feedback';
export const FEEDBACK_HEADERS = ['id', 'received', 'type', 'page_url', 'page_title', 'message', 'email', 'rating',
  'commentary', 'status', 'notes', 'decided', 'implemented', 'reply_draft', 'reply_sent'];
// Stored type -> label (the form's pills).
export const FEEDBACK_TYPES = { update: 'Suggest an update', correction: 'Correction', other: 'Other feedback' };

const MAX_POST = 20000;            // bytes of form data
const MAX_MESSAGE = 2000;
const MIN_MESSAGE = 3;
const MAX_EMAIL = 200;
const MAX_TITLE = 200;
const MAX_URL = 500;
const DAILY_CAP = 100;             // rows a day in all; a flood waits for tomorrow
// Fallback limit when the FEEDBACK_LIMITER binding is missing (per Worker instance only).
const MEMORY_LIMIT = 5;
const MEMORY_WINDOW_MS = 10 * 60 * 1000;
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TZ = 'Europe/London';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const multiLine = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n').trim();

export function siteOrigin(env) {
  try { return new URL(String(env.SITE_URL || '')).origin; } catch { return ''; }
}

export function londonStamp(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Checks and cleans one submission. fields: plain object of form values.
// Returns { ok: true, value } or { ok: false, error } (error is shown to the reader).
export function validateFeedback(fields, origin) {
  const type = oneLine(fields.type);
  if (!FEEDBACK_TYPES[type]) return { ok: false, error: 'Please choose what kind of feedback this is.' };
  const message = multiLine(fields.message);
  if (message.length < MIN_MESSAGE) return { ok: false, error: 'Please write your message.' };
  if (message.length > MAX_MESSAGE) return { ok: false, error: `Please keep your message under ${MAX_MESSAGE} characters.` };
  const email = oneLine(fields.email).toLowerCase();
  if (email && (email.length > MAX_EMAIL || !EMAIL_RE.test(email))) {
    return { ok: false, error: 'That email address doesn\'t look right. Check it, or leave it empty.' };
  }
  let pageUrl = oneLine(fields.page_url);
  try {
    const u = new URL(pageUrl);
    if (!origin || u.origin !== origin) throw new Error('other site');
    u.hash = '';
    pageUrl = u.href;
  } catch {
    return { ok: false, error: 'This form only works on pages of this website.' };
  }
  if (pageUrl.length > MAX_URL) return { ok: false, error: 'This form only works on pages of this website.' };
  const pageTitle = oneLine(fields.page_title).slice(0, MAX_TITLE);
  return { ok: true, value: { type, message, email, page_url: pageUrl, page_title: pageTitle } };
}

// Cloudflare Turnstile. Returns true only for a token Cloudflare confirms.
export async function verifyTurnstile(env, token, ip, fetchImpl = fetch) {
  const secret = String(env.TURNSTILE_SECRET || '');
  const response = String(token || '');
  if (!secret || !response || response.length > 2048) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', response);
  if (ip) form.append('remoteip', ip);
  try {
    const r = await fetchImpl(TURNSTILE_VERIFY, { method: 'POST', body: form });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.success === true;
  } catch (e) {
    console.error(`Turnstile check failed: ${e.message}`);
    return false;
  }
}

const memoryHits = new Map(); // ip -> [ms, ...]

export function resetMemoryLimit() { memoryHits.clear(); }

// True when this IP may submit now. The FEEDBACK_LIMITER binding (wrangler.toml) counts
// across Cloudflare; without it, a per-instance memory count still stops a quick burst.
export async function allowed(env, ip, now = Date.now()) {
  const key = ip || 'unknown';
  if (env.FEEDBACK_LIMITER && typeof env.FEEDBACK_LIMITER.limit === 'function') {
    try {
      const { success } = await env.FEEDBACK_LIMITER.limit({ key });
      if (!success) return false;
    } catch (e) {
      console.error(`Rate limiter failed: ${e.message}`);
    }
  }
  const hits = (memoryHits.get(key) || []).filter((t) => now - t < MEMORY_WINDOW_MS);
  if (hits.length >= MEMORY_LIMIT) {
    memoryHits.set(key, hits);
    return false;
  }
  hits.push(now);
  memoryHits.set(key, hits);
  if (memoryHits.size > 5000) memoryHits.clear();
  return true;
}

function newId(ms) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0').slice(-1)).join('');
  return `fb-${londonStamp(ms).slice(0, 10).replace(/-/g, '')}-${rand}`;
}

// Creates the Feedback tab (at the end, header row only) if it isn't there yet.
async function ensureTab(env) {
  const gids = await sheetGids(env);
  if (Object.prototype.hasOwnProperty.call(gids, FEEDBACK_TAB)) return;
  await addTab(env, FEEDBACK_TAB);
  await writeCells(env, [{ range: `'${FEEDBACK_TAB}'!A1`, values: [FEEDBACK_HEADERS] }]);
}

// Appends one row (columns by header name; RAW, so nothing typed is ever a formula).
// Returns { id }, or throws.
// { full: true } when today's cap is reached (nothing written).
export async function saveFeedback(env, value, ms = Date.now()) {
  await ensureTab(env);
  const { headers, rows } = tableFrom(await getValues(env, `'${FEEDBACK_TAB}'!A1:Z`));
  const today = londonStamp(ms).slice(0, 10);
  if (rows.filter((r) => String(r.received || '').startsWith(today)).length >= DAILY_CAP) return { full: true };
  const id = newId(ms);
  const row = {
    id, received: londonStamp(ms), type: value.type, page_url: value.page_url, page_title: value.page_title,
    message: value.message, email: value.email, status: 'new',
  };
  const missing = ['id', 'message', 'status'].filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Feedback tab has no ${missing.join(', ')} column`);
  await appendValues(env, FEEDBACK_TAB, [headers.map((h) => (row[h] === undefined ? '' : row[h]))]);
  return { id };
}

/* ----------------------------------------------------------- responses -- */

function plainPage(env, title, text, back, status) {
  const backLink = back ? `<p><a href="${esc(back)}">Back to the page</a></p>` : '';
  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#F6F1E4;color:#2b2b2b;margin:0;padding:24px}
main{max-width:520px;margin:40px auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{color:#3F5233;font-size:1.3rem;margin-top:0}a{color:#3F5233}
</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${backLink}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

function reply(env, js, { ok, status = 200, title, message, back }) {
  if (js) {
    const origin = siteOrigin(env);
    return new Response(JSON.stringify({ ok, message }), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
      },
    });
  }
  return plainPage(env, title || (ok ? 'Thank you' : 'Not sent'), message, back, status);
}

export async function handleFeedback(request, env, { fetchImpl = fetch, now = Date.now } = {}) {
  const origin = siteOrigin(env);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST',
        'access-control-max-age': '86400', vary: 'Origin',
      },
    });
  }
  if (request.method !== 'POST') {
    return plainPage(env, 'Feedback form', 'Use the "Suggest an update" form at the foot of any page on the website.', env.SITE_URL, 405);
  }

  const sentOrigin = request.headers.get('origin');
  if (sentOrigin && sentOrigin !== origin) return reply(env, false, { ok: false, status: 403, message: 'This form only works on the Lenches website.' });
  if (Number(request.headers.get('content-length') || 0) > MAX_POST) {
    return reply(env, false, { ok: false, status: 413, message: 'That was too long to send.' });
  }

  let fields;
  try {
    const form = await request.formData();
    fields = {};
    for (const k of ['type', 'message', 'email', 'page_url', 'page_title', 'website', 'js', 'cf-turnstile-response']) {
      const v = form.get(k);
      fields[k] = typeof v === 'string' ? v : '';
    }
  } catch {
    return reply(env, false, { ok: false, status: 400, message: 'Nothing was received. Please try again.' });
  }
  const js = fields.js === '1';
  let back = '';
  try { back = new URL(fields.page_url).origin === origin ? fields.page_url : ''; } catch { back = ''; }
  back = back || String(env.SITE_URL || '');
  const fail = (status, message) => reply(env, js, { ok: false, status, message, back });

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await allowed(env, ip, now()))) return fail(429, 'You\'ve sent several messages in a short time. Please wait ten minutes and try again.');

  // Honeypot: people never see this field; a bot that fills it is told it worked.
  const thanks = 'Thank you, we\'ve got your message.';
  if (fields.website.trim()) return reply(env, js, { ok: true, message: thanks, back });

  const v = validateFeedback(fields, origin);
  if (!v.ok) return fail(400, v.error);

  if (!(await verifyTurnstile(env, fields['cf-turnstile-response'], ip, fetchImpl))) {
    return fail(403, js
      ? 'We couldn\'t confirm you\'re not a robot. Please try again, or email website@thelenches.org.uk.'
      : 'This form needs JavaScript turned on to check you\'re not a robot. Please email website@thelenches.org.uk instead.');
  }

  try {
    const saved = await saveFeedback(env, v.value, now());
    if (saved.full) return fail(503, 'We\'re receiving a lot of messages today. Please try again tomorrow, or email website@thelenches.org.uk.');
    console.log(`Feedback ${saved.id} saved (${v.value.type}).`);
  } catch (e) {
    console.error(`Feedback not saved: ${e.message}`);
    return fail(502, 'Sorry, something went wrong and your message wasn\'t saved. Please try again later, or email website@thelenches.org.uk.');
  }
  const done = v.value.email ? `${thanks} We'll email you to let you know what happens.` : thanks;
  return reply(env, js, { ok: true, message: done, back });
}
