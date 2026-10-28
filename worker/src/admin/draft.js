// worker/src/admin/draft.js
// The panel's Newsletter draft: reads the "Newsletter draft" tab that
// scripts/newsletter/draft.js rewrites (newsletter-draft.yml), and serves its copy of the
// next issue on its own page (/admin/draft), shown in a frame on the panel. Read-only, apart
// from Refresh, which only asks GitHub to run newsletter-draft.yml (it sends nothing).
//   draftMeta(rows)   { as_of, issue_date, mode, status, subject, items, ... } from the tab
//   draftHtml(rows)   the issue's html (the html_N cells joined, base64, inflated)
//   draftPage(html)   the Response for /admin/draft: no scripts, images from the site only,
//                     links open in a new tab, framed by the panel only

export const DRAFT_TAB = 'Newsletter draft';
export const DRAFT_RANGE = `'${DRAFT_TAB}'!A1:B60`;
const META_KEYS = ['as_of', 'issue_date', 'mode', 'status', 'subject', 'items', 'events', 'notices', 'roads', 'elsewhere', 'held', 'cutoff'];
const NUMBERS = new Set(['items', 'events', 'notices', 'roads', 'elsewhere', 'held']);

const str = (v) => String(v ?? '').trim();
const pairs = (rows) => (rows || []).slice(1).filter((r) => str(r[0])).map((r) => [str(r[0]), String(r[1] ?? '')]);

export function draftMeta(rows) {
  const out = {};
  for (const [k, v] of pairs(rows)) if (META_KEYS.includes(k)) out[k] = NUMBERS.has(k) ? Number(v) || 0 : str(v);
  return out.as_of ? out : null;
}

export async function draftHtml(rows) {
  const parts = pairs(rows).filter(([k]) => /^html_\d+$/.test(k))
    .sort((a, b) => Number(a[0].slice(5)) - Number(b[0].slice(5))).map(([, v]) => v.trim());
  if (!parts.length) return '';
  const bytes = Uint8Array.from(atob(parts.join('')), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

const DRAFT_CSP = [
  "default-src 'none'", 'img-src https://thelenches.org.uk data:', "style-src 'unsafe-inline'",
  "form-action 'none'", "frame-ancestors 'self'", 'sandbox allow-popups allow-popups-to-escape-sandbox',
].join('; ');

const EMPTY = '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Newsletter draft</title></head>'
  + '<body style="font-family:system-ui,sans-serif;color:#555;padding:24px">No draft yet. Tap Refresh on the panel; it takes a minute or two.</body></html>';

// Links open in a new tab (the frame never navigates away).
export function draftPage(html) {
  const body = html ? (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}<base target="_blank">`) : `<base target="_blank">${html}`) : EMPTY;
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': DRAFT_CSP,
    },
  });
}
