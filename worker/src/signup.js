// worker/src/signup.js
// Newsletter sign-up form (src/_includes/signup.njk and the home page's sign-up card) ->
// Sign-ups tab, then repository_dispatch "signup" (action "send") so signup.yml emails a
// confirmation link from website@ (double opt-in; scripts/signup).
//   POST /s   public, never behind Cloudflare Access (same rule as /a, /u and /f).
//             Order: same-site check, per-IP rate limit, honeypot, validation, Turnstile,
//             daily cap, one confirmation email per address per day, then one row.
// The confirmation link itself (GET/POST /s?t=TOKEN) is handled in index.js, next to /u.
// The page never says whether an address is already subscribed: every accepted request
// gets the same answer. Never logs the address: this repo's Actions logs are public, and
// the dispatch carries the row id only.
// Failed sign-ups (27 Nov 2026, Jon): any refused sign-up (or a failure the page reports) that
// carries something like an address adds a Sign-ups row with status "review" (result = why and
// the browser, in plain words) and dispatches signup.yml action "alert", which emails Jon at
// once; the panel's Summary lists them until he taps Reviewed. Honeypot hits never; at most
// REVIEW_DAY_CAP a day, one per address per day.

import { siteWords, ownDomains } from './sites.js';
import { getValues, appendValues, sheetGids, addTab, writeCells } from './admin/google.js';
import { tableFrom } from './admin/sheet.js';
import { dispatch } from './core.js';
import { recordFailure, code, browserOf } from './formfail.js';
import {
  EMAIL_RE, siteOrigin, formEnv, londonStamp, verifyTurnstile, allowed, plainPage, reply,
} from './feedback.js';

export const SIGNUP_TAB = 'Sign-ups';
export const SIGNUP_HEADERS = ['id', 'requested', 'email', 'status', 'sent_at', 'confirmed_at', 'result'];

const MAX_POST = 5000;
const MAX_EMAIL = 200;
const DAILY_CAP = 100;             // sign-ups a day in all; a flood waits for tomorrow
const REVIEW_DAY_CAP = 20;         // failed sign-ups flagged to Jon a day; a bot attack stops there
// Rows that are not a sign-up attempt for the daily cap or the one-email-a-day rule.
const NOT_TRIES = new Set(['failed', 'review', 'reviewed']);

// Why a sign-up failed, in plain words for Jon (the Sign-ups row's result, his email, the panel).
export const REVIEW_WHY = {
  origin: 'sent from a page we didn\'t recognise (often an app\'s own browser)',
  rate: 'too many tries in ten minutes',
  invalid: 'the address didn\'t look right: check for a typo',
  robot: 'the robot check failed',
  nojs: 'JavaScript was off, so the robot check couldn\'t run',
  cap: 'the day\'s limit of 100 sign-ups was reached',
  dispatch: 'GitHub didn\'t accept the request to send the confirmation email',
  save: 'the Sheet couldn\'t be written',
};
export const reviewWhy = (reason) => REVIEW_WHY[reason]
  || (String(reason).startsWith('page-') ? `it failed in their browser (${String(reason).slice(5)})` : String(reason));

export const SIGNUP_THANKS = 'Nearly done: check your inbox for an email from us and click the link to confirm. If it isn\'t there in a few minutes, look in your spam folder.';

const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const lc = (v) => String(v ?? '').trim().toLowerCase();

// Returns { ok: true, email } or { ok: false, error } (error is shown to the reader).
export function validateSignup(fields) {
  const email = oneLine(fields.email).toLowerCase();
  if (!email) return { ok: false, error: 'Please enter your email address.' };
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return { ok: false, error: 'That email address doesn\'t look right. Please check it.' };
  if (ownDomains().some((d) => email.endsWith(`@${d}`))) return { ok: false, error: 'Please use your own email address.' };
  return { ok: true, email };
}

// Something like an address worth showing Jon (a typo included), else ''.
export function reviewAddress(raw) {
  const e = oneLine(raw).toLowerCase();
  if (!e || e.length > MAX_EMAIL || /\s/.test(e) || !/^[^@]+@[^@]+$/.test(e)) return '';
  if (ownDomains().some((d) => e.endsWith(`@${d}`))) return '';
  return e;
}

function newId(ms) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0').slice(-1)).join('');
  return `su-${londonStamp(ms).slice(0, 10).replace(/-/g, '')}-${rand}`;
}

async function ensureTab(env) {
  const gids = await sheetGids(env);
  if (Object.prototype.hasOwnProperty.call(gids, SIGNUP_TAB)) return;
  await addTab(env, SIGNUP_TAB);
  await writeCells(env, [{ range: `'${SIGNUP_TAB}'!A1`, values: [SIGNUP_HEADERS] }]);
}

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Appends one row and dispatches the confirmation email.
// Returns { id } | { full: true } (today's cap) | { repeat: true } (this address already
// had a request today: nothing written or sent) | { failed: true } (GitHub refused).
export async function saveSignup(env, email, ms = Date.now()) {
  await ensureTab(env);
  const { headers, rows } = tableFrom(await getValues(env, `'${SIGNUP_TAB}'!A1:Z`));
  const missing = ['id', 'requested', 'email', 'status'].filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Sign-ups tab has no ${missing.join(', ')} column`);
  const today = londonStamp(ms).slice(0, 10);
  const todays = rows.filter((r) => String(r.requested || '').startsWith(today));
  const tries = todays.filter((r) => !NOT_TRIES.has(lc(r.status)));
  if (tries.some((r) => lc(r.email) === email)) return { repeat: true };
  if (tries.length >= DAILY_CAP) return { full: true };
  const id = newId(ms);
  const row = { id, requested: londonStamp(ms), email, status: 'new' };
  await appendValues(env, SIGNUP_TAB, [headers.map((h) => (row[h] === undefined ? '' : row[h]))]);
  if (await dispatch(env, 'signup', { action: 'send', id }, 2)) return { id };
  // Mark it failed so the reader can try again today.
  try {
    const after = tableFrom(await getValues(env, `'${SIGNUP_TAB}'!A1:Z`));
    const mine = after.rows.find((r) => r.id === id);
    if (mine) {
      await writeCells(env, [{ range: `'${SIGNUP_TAB}'!${colLetter(after.headers.indexOf('status'))}${mine._row}`, values: [['failed']] }]);
    }
  } catch (e) {
    console.error(`Sign-up ${id}: could not mark failed: ${e.message}`);
  }
  return { failed: true };
}

// A failed sign-up with an address: one "review" row and an alert to Jon (signup.yml action
// "alert"). Never throws: flagging must not change what the reader sees.
export async function flagForReview(env, raw, reason, ua, ms = Date.now()) {
  const email = reviewAddress(raw);
  if (!email) return false;
  try {
    await ensureTab(env);
    const { headers, rows } = tableFrom(await getValues(env, `'${SIGNUP_TAB}'!A1:Z`));
    const missing = ['id', 'requested', 'email', 'status', 'result'].filter((h) => !headers.includes(h));
    if (missing.length) throw new Error(`Sign-ups tab has no ${missing.join(', ')} column`);
    const today = londonStamp(ms).slice(0, 10);
    const todays = rows.filter((r) => String(r.requested || '').startsWith(today) && lc(r.status) === 'review');
    if (todays.some((r) => lc(r.email) === email) || todays.length >= REVIEW_DAY_CAP) return false;
    const id = newId(ms);
    const row = { id, requested: londonStamp(ms), email, status: 'review', result: `Didn't go through: ${reviewWhy(reason)} · ${browserOf(ua)}` };
    await appendValues(env, SIGNUP_TAB, [headers.map((h) => (row[h] === undefined ? '' : row[h]))]);
    if (!(await dispatch(env, 'signup', { action: 'alert', id }, 2))) console.error(`Failed sign-up ${id}: alert not dispatched (it shows on the panel).`);
    return true;
  } catch (e) {
    console.error(`Failed sign-up not flagged: ${e.message}`);
    return false;
  }
}

export async function handleSignup(request, env, { fetchImpl = fetch, now = Date.now } = {}) {
  env = formEnv(env, request);
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
    return plainPage(env, 'Newsletter sign-up', 'Use the newsletter sign-up form on any page of the website.', env.SITE_URL, 405);
  }

  const back = String(env.SITE_URL || '');
  const sentOrigin = request.headers.get('origin');
  const ua = request.headers.get('user-agent') || '';
  const record = (reason) => recordFailure(env, { stage: 'server', reason, ua, origin: sentOrigin, ms: now() });
  if (sentOrigin && sentOrigin !== origin) {
    await record('origin');
    try {
      const f = await request.formData();
      if (f.get('fail') !== '1' || f.get('email')) await flagForReview(env, String(f.get('email') || ''), 'origin', ua, now());
    } catch { /* nothing readable: nothing to flag */ }
    return reply(env, false, { ok: false, status: 403, message: `This form only works on ${siteWords(env).website}.`, back });
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_POST) {
    return reply(env, false, { ok: false, status: 413, message: 'That was too long to send.', back });
  }

  let fields;
  try {
    const form = await request.formData();
    fields = {};
    for (const k of ['email', 'website', 'js', 'cf-turnstile-response', 'fail', 'stage', 'reason']) {
      const v = form.get(k);
      fields[k] = typeof v === 'string' ? v : '';
    }
  } catch {
    await record('empty');
    return reply(env, false, { ok: false, status: 400, message: 'Nothing was received. Please try again.', back });
  }
  const ip = request.headers.get('cf-connecting-ip') || '';
  // The page reporting a failure that never reached us (fail=1, stage, reason, and since
  // 27 Nov the address typed, if any, for Jon's review; never in Form failures).
  // Its own memory-only limit, so a report never uses up the reader's real tries.
  if (fields.fail === '1') {
    if (await allowed(env, `fail|${ip}`, now(), 'FORMFAIL_LIMITER')) {
      await recordFailure(env, { stage: code(fields.stage) || 'page', reason: fields.reason, ua, origin: sentOrigin, ms: now() });
      await flagForReview(env, fields.email, `page-${code(fields.reason) || 'unknown'}`, ua, now());
    }
    return reply(env, true, { ok: true, status: 200, message: '' });
  }
  const js = fields.js === '1';
  const done = () => reply(env, js, { ok: true, title: 'Check your inbox', message: SIGNUP_THANKS, back });
  const fail = async (status, message, reason) => {
    await record(reason);
    await flagForReview(env, fields.email, reason, ua, now());
    return reply(env, js, { ok: false, status, title: 'Not sent', message, back });
  };

  if (!(await allowed(env, ip, now(), 'SIGNUP_LIMITER'))) return fail(429, 'You\'ve tried several times in a short time. Please wait ten minutes and try again.', 'rate');

  // Honeypot: people never see this field; a bot that fills it is told it worked.
  if (fields.website.trim()) return done();

  const v = validateSignup(fields);
  if (!v.ok) return fail(400, v.error, 'invalid');

  if (!(await verifyTurnstile(env, fields['cf-turnstile-response'], ip, fetchImpl))) {
    return fail(403, js
      ? `We couldn't confirm you're not a robot. Please try again, or email ${siteWords(env).email} and ask to be added.`
      : `This form needs JavaScript turned on to check you're not a robot. Please email ${siteWords(env).email} and ask to be added instead.`, js ? 'robot' : 'nojs');
  }

  try {
    const saved = await saveSignup(env, v.email, now());
    if (saved.full) return fail(503, `We're receiving a lot of sign-ups today. Please try again tomorrow, or email ${siteWords(env).email}.`, 'cap');
    if (saved.failed) return fail(502, `Sorry, something went wrong. Please try again in a few minutes, or email ${siteWords(env).email}.`, 'dispatch');
    console.log(saved.repeat ? 'Sign-up repeated today: no second email.' : `Sign-up ${saved.id} saved; confirmation dispatched.`);
  } catch (e) {
    console.error(`Sign-up not saved: ${e.message}`);
    return fail(502, `Sorry, something went wrong. Please try again later, or email ${siteWords(env).email}.`, 'save');
  }
  return done();
}
