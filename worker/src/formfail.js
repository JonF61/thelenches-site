// worker/src/formfail.js
// Anonymous record of newsletter sign-up failures (23 Nov 2026, Jon: Harvington readers said
// the form "wouldn't go through" and we couldn't see why). One row per failure in the
// posting site's **Form failures** tab (made by the Worker): when, which site, which form,
// where it failed (server = the Worker refused it; page = the reader's browser never got as
// far, e.g. the robot check didn't load), a short reason code and the browser family
// (e.g. "Facebook app (iPhone)"). Never the address, the IP or the full user agent.
// Failures in the Worker are recorded by signup.js; failures in the page are reported by
// signup-form.njk with a small POST /s carrying fail=1 (see handleSignup).
// 27 Nov 2026: an `origin` column (added at the end of an older tab) holds the Origin header
// the browser sent, cut to its scheme and host (or "null"), to show what a refused browser
// such as the Facebook app sends. A site address, never anything about the reader.
import { getValues, appendValues, sheetGids, addTab, writeCells } from './admin/google.js';
import { tableFrom } from './admin/sheet.js';
import { londonStamp } from './feedback.js';

export const FAIL_TAB = 'Form failures';
export const FAIL_HEADERS = ['at', 'site', 'form', 'stage', 'reason', 'browser', 'origin'];
const DAY_CAP = 200; // rows a day in all; a flood of reports stops there

// A reason or stage as sent: lower-case letters, digits, - and _ only, at most 40.
export const code = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 40);

// The Origin header as recorded: "null", "(none)", or scheme://host[:port], at most 80.
export function originNote(v) {
  if (v === null || v === undefined || v === '') return '(none)';
  const s = String(v).trim();
  if (s === 'null') return 'null';
  try { const u = new URL(s); return `${u.protocol}//${u.host}`.slice(0, 80); } catch { return '(unreadable)'; }
}

// "Facebook app (iPhone)", "Safari (Mac)", "Chrome (Android)" … from the user agent.
export function browserOf(ua) {
  const s = String(ua || '');
  const app = /FBAN|FBAV|FB_IAB|FBIOS/.test(s) ? 'Facebook app'
    : /Instagram/.test(s) ? 'Instagram app'
      : /\bwv\)|; wv\b/.test(s) ? 'Android app browser'
        : /Edg\//.test(s) ? 'Edge'
          : /SamsungBrowser/.test(s) ? 'Samsung Internet'
            : /Firefox|FxiOS/.test(s) ? 'Firefox'
              : /Chrome|CriOS/.test(s) ? 'Chrome'
                : /Safari/.test(s) ? 'Safari' : 'other';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : '';
  return os ? `${app} (${os})` : app;
}

async function ensureTab(env) {
  const gids = await sheetGids(env);
  if (Object.prototype.hasOwnProperty.call(gids, FAIL_TAB)) return;
  await addTab(env, FAIL_TAB);
  await writeCells(env, [{ range: `'${FAIL_TAB}'!A1`, values: [FAIL_HEADERS] }]);
}

// Adds one row. Never throws: a failure to record must not change what the reader sees.
export async function recordFailure(env, { form = 'signup', stage, reason, ua, origin, ms = Date.now() }) {
  try {
    await ensureTab(env);
    const { headers, rows } = tableFrom(await getValues(env, `'${FAIL_TAB}'!A1:G`));
    if (!headers.includes('origin')) { // a tab made before 27 Nov: add the header at the end
      await writeCells(env, [{ range: `'${FAIL_TAB}'!${String.fromCharCode(65 + headers.length)}1`, values: [['origin']] }]);
      headers.push('origin');
    }
    const today = londonStamp(ms).slice(0, 10);
    if (rows.filter((r) => String(r.at || '').startsWith(today)).length >= DAY_CAP) return false;
    const row = {
      at: londonStamp(ms), site: String(env.SITE || 'lenches'), form: code(form),
      stage: code(stage), reason: code(reason) || 'unknown', browser: browserOf(ua), origin: originNote(origin),
    };
    await appendValues(env, FAIL_TAB, [headers.map((h) => (row[h] === undefined ? '' : row[h]))]);
    return true;
  } catch (e) {
    console.error(`Form failure not recorded: ${e.message}`);
    return false;
  }
}
