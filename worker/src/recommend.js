// worker/src/recommend.js
// "Recommend" buttons on the Local trades and Where to eat cards (src/_includes/recommend.njk)
// -> Recommendations tab, then repository_dispatch "recommend" (action "send") so
// recommend.yml emails a confirmation link from website@ (scripts/recommend). Nothing
// counts until that link's button is pressed (GET/POST /r?t=, handled in index.js).
//   POST /r   public, never behind Cloudflare Access (same rule as /a, /u, /f and /s).
//             Order: same-site check, per-IP rate limit, honeypot, validation (the entry
//             must be listed), Turnstile, daily cap, one request per address per entry per
//             day and at most PER_EMAIL_DAY (25) a day in all, then one row.
// Every accepted request gets the same answer, so the page never says whether an address
// has recommended before (scripts/recommend sends an "already counted" email instead).
// `key` is a SHA-256 of the address, kept after the address itself is wiped so each address
// counts once per entry. Never logs the address: the dispatch carries the row id only.

import { getValues, appendValues, sheetGids, addTab, writeCells } from './admin/google.js';
import { tableFrom } from './admin/sheet.js';
import { dispatch } from './core.js';
import { londonStamp, verifyTurnstile, allowed, reply, plainPage, siteOrigin } from './feedback.js';
import { validateSignup } from './signup.js';
import tradesData from '../../src/_data/trades.json' with { type: 'json' };
import eatData from '../../src/_data/eat.json' with { type: 'json' };

export const RECOMMEND_TAB = 'Recommendations';
export const RECOMMEND_HEADERS = ['id', 'requested', 'kind', 'entry', 'email', 'key', 'status', 'sent_at', 'confirmed_at', 'result'];

export const LISTINGS = {
  trades: { entries: tradesData.trades, page: '/living-here/trades/', label: 'Local trades' },
  eat: { entries: eatData.places, page: '/living-here/eat/', label: 'Where to eat' },
};

const MAX_POST = 5000;
const DAILY_CAP = 200;      // recommendations a day in all
const PER_EMAIL_DAY = 25;   // requests a day from one address

export const RECOMMEND_THANKS = 'Nearly done: check your inbox for an email from us and click the link to confirm your recommendation. If it isn\'t there in a few minutes, look in your spam folder.';

const lc = (v) => String(v ?? '').trim().toLowerCase();

// The listed entry for kind + id, or null.
export function listedEntry(kind, id) {
  const l = Object.prototype.hasOwnProperty.call(LISTINGS, kind) ? LISTINGS[kind] : null;
  if (!l || !/^[a-z0-9-]{1,80}$/.test(String(id || ''))) return null;
  const e = l.entries.find((x) => x.id === id);
  return e ? { ...e, kind, page: l.page, label: l.label } : null;
}

export async function emailKey(email) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lenches-recommend|${lc(email)}`));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function newId(ms) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0').slice(-1)).join('');
  return `rc-${londonStamp(ms).slice(0, 10).replace(/-/g, '')}-${rand}`;
}

async function ensureTab(env) {
  const gids = await sheetGids(env);
  if (Object.prototype.hasOwnProperty.call(gids, RECOMMEND_TAB)) return;
  await addTab(env, RECOMMEND_TAB);
  await writeCells(env, [{ range: `'${RECOMMEND_TAB}'!A1`, values: [RECOMMEND_HEADERS] }]);
}

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Appends one row and dispatches the confirmation email.
// Returns { id } | { full: true } | { repeat: true } (nothing written or sent) | { failed: true }.
export async function saveRecommendation(env, { kind, entry, email }, ms = Date.now()) {
  await ensureTab(env);
  const { headers, rows } = tableFrom(await getValues(env, `'${RECOMMEND_TAB}'!A1:Z`));
  const missing = ['id', 'requested', 'kind', 'entry', 'email', 'key', 'status'].filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Recommendations tab has no ${missing.join(', ')} column`);
  const key = await emailKey(email);
  const today = londonStamp(ms).slice(0, 10);
  const todays = rows.filter((r) => String(r.requested || '').startsWith(today) && lc(r.status) !== 'failed');
  const mine = todays.filter((r) => r.key === key);
  if (mine.some((r) => r.kind === kind && r.entry === entry) || mine.length >= PER_EMAIL_DAY) return { repeat: true };
  if (todays.length >= DAILY_CAP) return { full: true };
  const id = newId(ms);
  const row = { id, requested: londonStamp(ms), kind, entry, email, key, status: 'new' };
  await appendValues(env, RECOMMEND_TAB, [headers.map((h) => (row[h] === undefined ? '' : row[h]))]);
  if (await dispatch(env, 'recommend', { action: 'send', id }, 2)) return { id };
  try {
    const after = tableFrom(await getValues(env, `'${RECOMMEND_TAB}'!A1:Z`));
    const r = after.rows.find((x) => x.id === id);
    if (r) await writeCells(env, [{ range: `'${RECOMMEND_TAB}'!${colLetter(after.headers.indexOf('status'))}${r._row}`, values: [['failed']] }]);
  } catch (e) {
    console.error(`Recommendation ${id}: could not mark failed: ${e.message}`);
  }
  return { failed: true };
}

export async function handleRecommend(request, env, { fetchImpl = fetch, now = Date.now } = {}) {
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
    return plainPage(env, 'Recommend', 'Use the Recommend button on the Local trades or Where to eat page.', env.SITE_URL, 405);
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
    for (const k of ['email', 'kind', 'entry', 'website', 'js', 'cf-turnstile-response']) {
      const v = form.get(k);
      fields[k] = typeof v === 'string' ? v : '';
    }
  } catch {
    return reply(env, false, { ok: false, status: 400, message: 'Nothing was received. Please try again.', back });
  }
  const js = fields.js === '1';
  const done = () => reply(env, js, { ok: true, title: 'Check your inbox', message: RECOMMEND_THANKS, back });
  const fail = (status, message) => reply(env, js, { ok: false, status, title: 'Not sent', message, back });

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await allowed(env, ip, now(), 'RECOMMEND_LIMITER'))) return fail(429, 'You\'ve tried several times in a short time. Please wait ten minutes and try again.');

  if (fields.website.trim()) return done();   // honeypot

  const entry = listedEntry(fields.kind, fields.entry);
  if (!entry) return fail(400, 'We couldn\'t find that entry. Please reload the page and try again.');
  const v = validateSignup(fields);
  if (!v.ok) return fail(400, v.error);

  if (!(await verifyTurnstile(env, fields['cf-turnstile-response'], ip, fetchImpl))) {
    return fail(403, js
      ? 'We couldn\'t confirm you\'re not a robot. Please try again.'
      : 'This button needs JavaScript turned on to check you\'re not a robot.');
  }

  try {
    const saved = await saveRecommendation(env, { kind: entry.kind, entry: entry.id, email: v.email }, now());
    if (saved.full) return fail(503, 'We\'re receiving a lot of recommendations today. Please try again tomorrow.');
    if (saved.failed) return fail(502, 'Sorry, something went wrong. Please try again in a few minutes.');
    console.log(saved.repeat ? 'Recommendation repeated today: no second email.' : `Recommendation ${saved.id} saved; confirmation dispatched.`);
  } catch (e) {
    console.error(`Recommendation not saved: ${e.message}`);
    return fail(502, 'Sorry, something went wrong. Please try again later.');
  }
  return done();
}
