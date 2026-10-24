// worker/src/admin/access.js
// Cloudflare Access check for every /admin request. Access puts a signed JWT in the
// Cf-Access-Jwt-Assertion header; we verify it ourselves (RS256 against the team's
// certs, audience, issuer, expiry) so the workers.dev URL can't be used to skip Access.
// Fails closed: missing settings, header or certs all mean "no".
//   ACCESS_TEAM_DOMAIN  e.g. "lenches.cloudflareaccess.com" (wrangler.toml)
//   ACCESS_AUD          the Access application's AUD tag (wrangler.toml)
//   ADMIN_EMAILS        allowed emails, comma separated (Worker secret: keeps them out of the repo)

import { b64urlToBytes, b64urlToJson } from './b64.js';

const enc = new TextEncoder();
const CERTS_TTL_MS = 3600000;
const REFETCH_GAP_MS = 60000;   // an unknown key id refetches the certs at most this often
const LEEWAY_S = 60;

let certCache = { domain: '', at: 0, keys: [] };

export function resetCertCache() {
  certCache = { domain: '', at: 0, keys: [] };
}

export const teamDomain = (env) => String(env.ACCESS_TEAM_DOMAIN || '').trim()
  .replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

export function allowedEmails(env) {
  return String(env.ADMIN_EMAILS || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}

async function loadKeys(domain, force) {
  const now = Date.now();
  const fresh = certCache.domain === domain && now - certCache.at < CERTS_TTL_MS;
  if (fresh && !(force && now - certCache.at > REFETCH_GAP_MS)) return certCache.keys;
  const r = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access certs: HTTP ${r.status}`);
  const keys = ((await r.json()).keys || []).filter((k) => k.kty === 'RSA' && k.kid);
  certCache = { domain, at: now, keys };
  return keys;
}

// Returns { email } when the request carries a valid Access JWT for an allowed email,
// else { error } (a short reason for the log; the visitor only ever sees 403).
export async function verifyAccess(request, env, nowS = Date.now() / 1000) {
  const domain = teamDomain(env);
  const aud = String(env.ACCESS_AUD || '').trim();
  const allowed = allowedEmails(env);
  if (!domain || !aud || !allowed.length) return { error: 'Access is not configured' };

  const token = request.headers.get('cf-access-jwt-assertion') || '';
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'no Access token' };

  let header;
  let claims;
  let sig;
  try {
    header = b64urlToJson(parts[0]);
    claims = b64urlToJson(parts[1]);
    sig = b64urlToBytes(parts[2]);
  } catch {
    return { error: 'malformed token' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { error: `bad alg ${header.alg}` };

  let jwk;
  try {
    jwk = (await loadKeys(domain, false)).find((k) => k.kid === header.kid)
      || (await loadKeys(domain, true)).find((k) => k.kid === header.kid);
  } catch (e) {
    return { error: e.message };
  }
  if (!jwk) return { error: 'unknown key id' };

  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { error: 'bad signature' };

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return { error: 'wrong audience' };
  if (claims.iss !== `https://${domain}`) return { error: 'wrong issuer' };
  if (!(Number(claims.exp) > nowS - LEEWAY_S)) return { error: 'expired' };
  if (claims.nbf && Number(claims.nbf) > nowS + LEEWAY_S) return { error: 'not yet valid' };
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !allowed.includes(email)) return { error: 'email not allowed' };
  return { email };
}
