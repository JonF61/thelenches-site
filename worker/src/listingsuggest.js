// worker/src/listingsuggest.js
// "Suggest a tradesperson" / "Suggest somewhere to eat" forms at the foot of Local trades and
// Where to eat (src/_includes/suggest-form.njk) -> a Listing suggestions row, then
// repository_dispatch "listing-suggest" (action "send") so listing-suggest.yml emails a confirmation link from
// website@ (scripts/listingsuggest). The row waits for nothing until that link's button is pressed
// (GET/POST /sg?t=, below); then it shows on the panel's Suggestions screen for Jon.
//   POST /sg  public, never behind Cloudflare Access (same rule as /a, /u, /f, /s and /r).
//             Order: same-site check, per-IP rate limit (SUGGEST_LIMITER), honeypot,
//             validation, Turnstile, daily cap, one request per address per day, one row.
// Every accepted request gets the same answer. Never logs the address, name or why: the
// dispatch carries the row id only.

import { getValues, appendValues, sheetGids, addTab, writeCells } from './admin/google.js';
import { tableFrom } from './admin/sheet.js';
import { dispatch, ACTIONS } from './core.js';
import { londonStamp, verifyTurnstile, allowed, reply, plainPage, siteOrigin } from './feedback.js';
import { validateSignup } from './signup.js';
import { emailKey } from './recommend.js';
import { SUGGEST_TAB, SUGGEST_HEADERS, KINDS, LIMITS } from './admin/suggestions.mjs';

const MAX_POST = 8000;
const DAILY_CAP = 50;   // suggestions a day in all

export const SUGGEST_THANKS = 'Nearly done: check your inbox for an email from us and click the link to confirm your suggestion. If it isn\'t there in a few minutes, look in your spam folder.';

const lc = (v) => String(v ?? '').trim().toLowerCase();
const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const multiLine = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// The form's fields checked. Returns { ok, value } or { ok: false, error }.
export function validateSuggestion(fields) {
  const kind = String(fields.kind || '');
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return { ok: false, error: 'Please reload the page and try again.' };
  const name = oneLine(fields.name);
  const trade = oneLine(fields.trade);
  const contact = oneLine(fields.contact);
  const area = oneLine(fields.area);
  const why = multiLine(fields.why);
  const what = kind === 'trades' ? 'their trade' : 'what type of place it is';
  if (name.length < 2) return { ok: false, error: 'Please give their name.' };
  if (trade.length < 2) return { ok: false, error: `Please say ${what}.` };
  if (contact.length < 5) return { ok: false, error: 'Please give a phone number or website.' };
  for (const [k, v] of Object.entries({ name, trade, contact, area, why })) {
    if (v.length > LIMITS[k]) return { ok: false, error: 'One of the boxes is too long. Please shorten it.' };
  }
  const v = validateSignup(fields);
  if (!v.ok) return v;
  return { ok: true, value: { kind, name, trade, contact, area, why, email: v.email } };
}

function newId(ms) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0').slice(-1)).join('');
  return `sg-${londonStamp(ms).slice(0, 10).replace(/-/g, '')}-${rand}`;
}

async function ensureTab(env) {
  const gids = await sheetGids(env);
  if (Object.prototype.hasOwnProperty.call(gids, SUGGEST_TAB)) return;
  await addTab(env, SUGGEST_TAB);
  await writeCells(env, [{ range: `'${SUGGEST_TAB}'!A1`, values: [SUGGEST_HEADERS] }]);
}

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Appends one row and dispatches the confirmation email.
// Returns { id } | { full: true } | { repeat: true } (nothing written or sent) | { failed: true }.
export async function saveSuggestion(env, value, ms = Date.now()) {
  await ensureTab(env);
  const { headers, rows } = tableFrom(await getValues(env, `'${SUGGEST_TAB}'!A1:Z`));
  const missing = ['id', 'requested', 'kind', 'name', 'email', 'key', 'status'].filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`${SUGGEST_TAB} tab has no ${missing.join(', ')} column`);
  const key = await emailKey(value.email);
  const today = londonStamp(ms).slice(0, 10);
  const todays = rows.filter((r) => String(r.requested || '').startsWith(today) && lc(r.status) !== 'failed');
  if (todays.some((r) => r.key === key)) return { repeat: true };
  if (todays.length >= DAILY_CAP) return { full: true };
  const id = newId(ms);
  const row = { ...value, id, requested: londonStamp(ms), key, status: 'new' };
  await appendValues(env, SUGGEST_TAB, [headers.map((h) => (row[h] === undefined ? '' : row[h]))]);
  if (await dispatch(env, 'listing-suggest', { action: 'send', id }, 2)) return { id };
  try {
    const after = tableFrom(await getValues(env, `'${SUGGEST_TAB}'!A1:Z`));
    const r = after.rows.find((x) => x.id === id);
    if (r) await writeCells(env, [{ range: `'${SUGGEST_TAB}'!${colLetter(after.headers.indexOf('status'))}${r._row}`, values: [['failed']] }]);
  } catch (e) {
    console.error(`Suggestion ${id}: could not mark failed: ${e.message}`);
  }
  return { failed: true };
}

export async function handleSuggest(request, env, { fetchImpl = fetch, now = Date.now } = {}) {
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
    return plainPage(env, 'Suggest', 'Use the Suggest form on the Local trades or Where to eat page.', env.SITE_URL, 405);
  }

  const back = String(env.SITE_URL || '');
  const sentOrigin = request.headers.get('origin');
  if (sentOrigin && sentOrigin !== origin) return reply(env, false, { ok: false, status: 403, message: 'This form only works on the Lenches website.', back });
  if (Number(request.headers.get('content-length') || 0) > MAX_POST) {
    return reply(env, false, { ok: false, status: 413, message: 'That was too long to send.', back });
  }

  let fields;
  try {
    const form = await request.formData();
    fields = {};
    for (const k of ['kind', 'name', 'trade', 'contact', 'area', 'why', 'email', 'website', 'js', 'cf-turnstile-response']) {
      const v = form.get(k);
      fields[k] = typeof v === 'string' ? v : '';
    }
  } catch {
    return reply(env, false, { ok: false, status: 400, message: 'Nothing was received. Please try again.', back });
  }
  const js = fields.js === '1';
  const done = () => reply(env, js, { ok: true, title: 'Check your inbox', message: SUGGEST_THANKS, back });
  const fail = (status, message) => reply(env, js, { ok: false, status, title: 'Not sent', message, back });

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await allowed(env, ip, now(), 'SUGGEST_LIMITER'))) return fail(429, 'You\'ve tried several times in a short time. Please wait ten minutes and try again.');

  if (fields.website.trim()) return done();   // honeypot

  const v = validateSuggestion(fields);
  if (!v.ok) return fail(400, v.error);

  if (!(await verifyTurnstile(env, fields['cf-turnstile-response'], ip, fetchImpl))) {
    return fail(403, js
      ? 'We couldn\'t confirm you\'re not a robot. Please try again.'
      : 'This form needs JavaScript turned on to check you\'re not a robot.');
  }

  try {
    const saved = await saveSuggestion(env, v.value, now());
    if (saved.full) return fail(503, 'We\'re receiving a lot of suggestions today. Please try again tomorrow.');
    if (saved.failed) return fail(502, 'Sorry, something went wrong. Please try again in a few minutes.');
    console.log(saved.repeat ? 'Suggestion repeated today: no second email.' : `Suggestion ${saved.id} saved; confirmation dispatched.`);
  } catch (e) {
    console.error(`Suggestion not saved: ${e.message}`);
    return fail(502, 'Sorry, something went wrong. Please try again later.');
  }
  return done();
}

// The link in the confirmation email (scripts/listingsuggest). GET shows a button, so a mail scanner
// opening the link sends nothing; the button's POST fires "listing-suggest" (confirm).
// page, esc, invalidPage and failedPage come from index.js (its page shell).
export async function handleSuggestConfirm(request, env, { verifyToken, page, esc, invalidPage, failedPage }) {
  const url = new URL(request.url);
  const site = String(env.SITE_URL || 'https://thelenches.org.uk/').replace(/\/+$/, '');
  let token = url.searchParams.get('t');
  if (request.method === 'POST' && !token) {
    try { token = (await request.formData()).get('t'); } catch { token = ''; }
  }
  const p = await verifyToken(token, env.APPROVAL_SIGNING_KEY);
  if (!p || (!p.expired && p.a !== 'sug')) return invalidPage();
  const kind = Object.prototype.hasOwnProperty.call(KINDS, p.k) ? KINDS[p.k] : KINDS.trades;
  const pageUrl = esc(`${site}${kind.page}`);
  if (p.expired) {
    return page('Link expired',
      `<h1>Link expired</h1><p>This link has expired. You can send your suggestion again on <a href="${pageUrl}">the website</a>.</p>`, 410);
  }
  if (request.method === 'GET') {
    return page(ACTIONS.sug[0], `
<h1>Send your suggestion?</h1>
<p>For the ${esc(kind.label)} page of thelenches.org.uk.</p>
<form method="post" action="/sg?t=${esc(token)}">
  <button class="approve" type="submit">Yes, send my suggestion</button>
</form>`);
  }
  if (request.method === 'POST') {
    if (!(await dispatch(env, 'listing-suggest', { action: 'confirm', id: p.i }, 2))) return failedPage();
    return page('Thank you', `
<h1>Thank you</h1>
<p>Thank you, we'll take a look at your suggestion.</p>
<p><a href="${pageUrl}">Back to ${esc(kind.label)}</a></p>`);
  }
  return new Response('Method not allowed', { status: 405 });
}
