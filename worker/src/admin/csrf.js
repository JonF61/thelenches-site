// worker/src/admin/csrf.js
// CSRF protection for every admin POST: the request must come from the panel's own
// origin (Origin header, else Sec-Fetch-Site) AND carry a token from /admin/api/session.
// Token: "<issued ms>.<HMAC(APPROVAL_SIGNING_KEY, admin-csrf|email|issued)>", valid 12 hours,
// tied to the signed-in email. The "admin-csrf|" prefix keeps it apart from email-link
// tokens, which sign base64url JSON.

import { b64urlToBytes, bytesToB64url } from './b64.js';

const enc = new TextEncoder();
export const CSRF_TTL_MS = 12 * 3600000;

async function hmacKey(env) {
  if (!env.APPROVAL_SIGNING_KEY) throw new Error('APPROVAL_SIGNING_KEY is not set');
  return crypto.subtle.importKey('raw', enc.encode(env.APPROVAL_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const message = (email, ts) => enc.encode(`admin-csrf|${String(email).toLowerCase()}|${ts}`);

export async function makeCsrf(env, email, nowMs = Date.now()) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), message(email, nowMs));
  return `${nowMs}.${bytesToB64url(sig)}`;
}

export async function checkCsrf(env, email, token, nowMs = Date.now()) {
  const m = String(token || '').match(/^(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) return false;
  const ts = Number(m[1]);
  if (ts > nowMs + 60000 || nowMs - ts > CSRF_TTL_MS) return false;
  let sig;
  try {
    sig = b64urlToBytes(m[2]);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await hmacKey(env), sig, message(email, m[1]));
}

export function sameOrigin(request) {
  const own = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin) return origin === own;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
