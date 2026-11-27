// worker/src/formsite.js
// Which site a public form post (/s, /f, /r, /sg) is for, and whether its origin is ours.
// Normally the Origin (or Referer) header names the site (sites.js siteFromRequest) and
// each handler refuses any other origin. 27 Nov 2026 (Jon): 57 sign-ups from the Facebook
// app (iPhone, iPad, Android) were refused as "origin" in three days: its built-in browser
// sends an Origin that is neither site (most likely "null"). For such a post we ask
// Cloudflare Turnstile instead: its answer names the hostname the robot check was solved
// on, so a post whose check passes on one of our sites is that site's, and the handler is
// told the check is already done (a Turnstile token works only once). A post whose check
// fails, or names another host, goes on to the handler as before and is refused there.
import { SITES, siteIds, siteFromRequest, publicEnv } from './sites.js';
import { TURNSTILE_VERIFY } from './feedback.js';

const hostOf = (u) => { try { return new URL(String(u || '')).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// True when the Origin header is missing or one of our sites (with or without www).
export function knownOrigin(request) {
  const sent = request.headers.get('origin');
  if (!sent) return true;
  const host = hostOf(sent);
  return Boolean(host) && siteIds().some((id) => hostOf(SITES[id].url) === host);
}

// The site whose address has this hostname, or ''.
export const siteForHost = (host) => {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  return (h && siteIds().find((id) => hostOf(SITES[id].url) === h)) || '';
};

// Cloudflare's answer for a token: { success, hostname } (success false on any failure).
export async function turnstileAnswer(env, token, ip, fetchImpl = fetch) {
  const secret = String(env.TURNSTILE_SECRET || '');
  const response = String(token || '');
  if (!secret || !response || response.length > 2048) return { success: false };
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', response);
  if (ip) form.append('remoteip', ip);
  try {
    const r = await fetchImpl(TURNSTILE_VERIFY, { method: 'POST', body: form });
    if (!r.ok) return { success: false };
    const j = await r.json();
    return { success: Boolean(j && j.success === true), hostname: String((j && j.hostname) || '') };
  } catch (e) {
    console.error(`Turnstile check failed: ${e.message}`);
    return { success: false };
  }
}

// The env a public form handler should run with.
export async function formRequestEnv(request, env, { fetchImpl = fetch } = {}) {
  const usual = publicEnv(env, siteFromRequest(request));
  if (request.method !== 'POST' || knownOrigin(request)) return usual;
  let token = '';
  try {
    const v = (await request.clone().formData()).get('cf-turnstile-response');
    token = typeof v === 'string' ? v : '';
  } catch { return usual; }
  if (!token) return usual;
  const ip = request.headers.get('cf-connecting-ip') || '';
  const a = await turnstileAnswer(env, token, ip, fetchImpl);
  const site = a.success ? siteForHost(a.hostname) : '';
  if (!site) return usual; // refused at the handler's origin check, as before
  // FORM_ORIGIN = the origin the browser sent, so the handler's origin check and its CORS
  // reply both accept it; TURNSTILE_OK tells verifyTurnstile the check has passed;
  // FORM_SITE_ORIGIN is the site's own address (the feedback form's page_url must be on it).
  return Object.assign(Object.create(publicEnv(env, site)), {
    FORM_ORIGIN: request.headers.get('origin'), TURNSTILE_OK: true, FORM_SITE_ORIGIN: new URL(SITES[site].url).origin,
  });
}
