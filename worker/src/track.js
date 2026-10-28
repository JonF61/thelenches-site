// worker/src/track.js
// Anonymous newsletter counts (28 Oct 2026; privacy page section 11). Public routes, never
// behind Cloudflare Access:
//   GET /c?t=<signed { a: "c", i: issue date, u: url }>  a link in a sent newsletter: counts
//       one click for that issue and link, then sends the reader straight on (302)
//   GET /o?i=<issue date>                                  the newsletter's 1x1 image: counts
//       one open for that issue
// Each count is a Workers Analytics Engine data point (binding NL_STATS, dataset
// lenches_newsletter): blobs [kind, issue, url], no address, no subscriber id, no IP.
// The links are signed by scripts/newsletter/track.js with APPROVAL_SIGNING_KEY, so /c can't
// be used to send people to other sites. A count that fails never stops the redirect.

export const DATASET = 'lenches_newsletter';
const ISSUE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_URL = 2000;
const SITE = 'https://thelenches.org.uk/';
const enc = new TextEncoder();
const dec = new TextDecoder();

// 1x1 transparent GIF.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

// { i, u } from a valid click token, else null.
export async function verifyClick(token, secret) {
  if (!secret) return null;
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body)))) return null;
    const p = JSON.parse(dec.decode(b64urlToBytes(body)));
    const u = String((p && p.u) || '');
    if (!p || p.a !== 'c' || !ISSUE.test(String(p.i || '')) || !/^https?:\/\//i.test(u) || u.length > MAX_URL) return null;
    return { i: p.i, u };
  } catch {
    return null;
  }
}

function count(env, blobs) {
  try {
    if (env.NL_STATS) env.NL_STATS.writeDataPoint({ blobs, doubles: [1], indexes: [blobs[1]] });
  } catch (e) {
    console.error(`Count failed: ${e.message}`);
  }
}

export async function handleClick(request, env) {
  const url = new URL(request.url);
  const p = await verifyClick(url.searchParams.get('t'), env.APPROVAL_SIGNING_KEY);
  if (!p) {
    return new Response(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Link not recognised</title></head>`
      + `<body style="font-family:system-ui,sans-serif;padding:24px">This link isn't recognised. You can find everything on <a href="${SITE}">thelenches.org.uk</a>.</body></html>`,
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  }
  count(env, ['click', p.i, p.u]);
  return new Response(null, { status: 302, headers: { location: p.u, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

export function handleOpen(request, env) {
  const i = String(new URL(request.url).searchParams.get('i') || '');
  if (ISSUE.test(i)) count(env, ['open', i, '']);
  return new Response(GIF, {
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', 'x-robots-tag': 'noindex' },
  });
}
