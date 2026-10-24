// worker/src/admin/photopages.js
// "On the website" links for the Photos panel. The site build writes photo-pages.json
// (lib/photopages.js): for each published photo slug, the public pages it appears on.
// The Worker only reads that public file; nothing new is published for the panel.
// pagesFor(list, row): [{ label, url }] (absolute, live site), [] = published but on no
// page, null = unknown (list unavailable, or the photo published after the list was built).

const FILE = 'photo-pages.json';
const SLUG = /^[a-z0-9-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const siteUrl = (env) => {
  const u = String(env.SITE_URL || 'https://thelenches.org.uk/');
  return u.endsWith('/') ? u : `${u}/`;
};

// The list, or { error }. Cached at the edge for 5 minutes.
export async function photoPages(env) {
  try {
    const r = await fetch(`${siteUrl(env)}${FILE}`, { cf: { cacheTtl: 300 } });
    if (!r.ok) return { error: `${FILE}: HTTP ${r.status}` };
    const j = await r.json();
    if (!j || typeof j.pages !== 'object' || !j.pages) return { error: `${FILE}: unreadable` };
    const ends = j.eventEnds && typeof j.eventEnds === 'object' ? j.eventEnds : {};
    return { generated: String(j.generated || ''), pages: j.pages, eventEnds: ends, base: siteUrl(env) };
  } catch (e) {
    return { error: `${FILE}: ${e.message}` };
  }
}

// Only links back to the site itself, with a plain label.
function clean(list, p) {
  if (!p || typeof p.url !== 'string' || typeof p.label !== 'string') return null;
  let u;
  try {
    u = new URL(p.url, list.base);
  } catch {
    return null;
  }
  if (u.origin !== new URL(list.base).origin) return null;
  return { label: p.label.slice(0, 120), url: u.href };
}

export function pagesFor(list, row) {
  if (!row || !String(row.published_at || '').trim()) return [];
  if (!list || list.error) return null;
  const slug = String(row.slug || '').trim();
  if (!SLUG.test(slug)) return null;
  // Published (or re-published) after the build that made the list: not in it yet.
  const at = String(row.published_at).trim();
  if (!ISO.test(list.generated) || (ISO.test(at) && at > list.generated)) return null;
  const found = list.pages[slug];
  return Array.isArray(found) ? found.map((p) => clean(list, p)).filter(Boolean) : [];
}

// The last day of an organiser's image's event: its end date if the build listed one
// (multi-day events), else the start date in the Image fetch key ("YYYY-MM-DD|Title").
// '' = no date known.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function eventEnd(list, key) {
  const k = String(key || '').trim();
  const start = k.slice(0, 10);
  if (!DAY.test(start)) return '';
  const end = list && !list.error && list.eventEnds ? String(list.eventEnds[k] || '') : '';
  return DAY.test(end) && end > start ? end : start;
}
