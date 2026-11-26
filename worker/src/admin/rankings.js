// SEO → Rankings (26 Nov 2026, Jon): where the site actually ranks in Google for each search phrase,
// from Ahrefs Rank Tracker (Jon's company Advanced plan, API v3). Search Console's "position" is an
// average over every time a page was shown, so it never says "we are 4th for X"; Rank Tracker checks
// the real results page for each tracked phrase, on phones and computers, from the phrase's location.
// The phrases are tracked in the Ahrefs project for the site's domain (set up by Jon in Ahrefs); the
// Worker secret AHREFS_API_KEY reads them. Read-only. Cached: the overview 12 hours, a phrase's top 10
// a day, so the panel uses only a few API units a week (the cost Ahrefs reports is shown on screen).

const API = 'https://api.ahrefs.com/v3';
const OVERVIEW_TTL = 12 * 3600000;
const SERP_TTL = 24 * 3600000;
const DEVICES = ['mobile', 'desktop'];
const FIELDS = 'keyword,location,position,position_prev,url,volume,serp_updated';

const cache = new Map();
export function resetRankCache() { cache.clear(); }
function cached(key, ttl) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < ttl ? hit.data : null;
}

const bare = (u) => String(u || '').toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/^\*\./, '')
  .replace(/^www\./, '').replace(/[/:].*$/, '').replace(/\*$/, '');

export function hostOf(env) {
  return bare(env.SITE_HOST || env.SITE_URL || 'https://thelenches.org.uk/');
}

// The Rank Tracker project for this host: same domain (www or not), with keywords; a whole-domain
// project before an exact-URL one, then the one tracking most phrases.
export function pickProject(projects, host) {
  const rank = { subdomains: 0, domain: 1, prefix: 2, exact: 3 };
  return (projects || [])
    .filter((p) => bare(p.url) === host && (p.keyword_count || 0) > 0)
    .sort((a, b) => (rank[a.mode] ?? 9) - (rank[b.mode] ?? 9) || (b.keyword_count || 0) - (a.keyword_count || 0))[0] || null;
}

async function call(env, path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  const r = await fetch(`${API}${path}?${qs}`, { headers: { authorization: `Bearer ${env.AHREFS_API_KEY}`, accept: 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    const why = body && (body.error || body.message);
    throw new Error(`${path}: HTTP ${r.status}${why ? ` (${String(why).slice(0, 200)})` : ''}`);
  }
  return { body: body || {}, units: Number(r.headers.get('x-api-units-cost-total-actual')) || 0 };
}

const ukDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const pathOf = (u, host) => {
  const s = String(u || '');
  if (!s) return '';
  return bare(s) === host ? (s.replace(/^https?:\/\/[^/]+/, '') || '/') : s;
};
const posOf = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);

async function projectFor(env, host) {
  const key = `project:${host}`;
  const hit = cached(key, OVERVIEW_TTL);
  if (hit) return hit;
  const { body, units } = await call(env, '/management/projects', { has_keywords: 'true' });
  const p = pickProject(body.projects, host);
  const data = p ? { id: Number(p.project_id), name: p.project_name || host, url: p.url, keywords: p.keyword_count || 0, units } : { units };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// The overview: one row per tracked phrase and location, with phone and computer positions now and a
// week ago, the ranking page and Ahrefs' monthly search estimate. Ranked phrases first, best first.
export async function rankings(env, { now = new Date() } = {}) {
  if (!env.AHREFS_API_KEY) return { off: true, why: 'The Ahrefs key isn’t in the Worker yet (the secret AHREFS_API_KEY in Cloudflare).' };
  const host = hostOf(env);
  const hit = cached(`overview:${host}`, OVERVIEW_TTL);
  if (hit) return hit;
  let data;
  try {
    const project = await projectFor(env, host);
    if (!project.id) {
      data = { off: true, why: `There’s no Ahrefs Rank Tracker project with search phrases for ${host} yet. Add the phrases in Ahrefs (Rank Tracker → Add keywords) and they show here after its first check.` };
    } else {
      const date = ukDay(now);
      const compared = ukDay(new Date(now.getTime() - 7 * 86400000));
      const res = await Promise.all(DEVICES.map((device) => call(env, '/rank-tracker/overview', {
        project_id: project.id, device, date, date_compared: compared, select: FIELDS, limit: 500,
      })));
      const rows = new Map();
      res.forEach(({ body }, i) => {
        for (const o of body.overviews || []) {
          const k = `${o.keyword}\u0000${o.location || ''}`;
          const row = rows.get(k) || { keyword: o.keyword, location: o.location || '', volume: o.volume ?? null, updated: '' };
          row[DEVICES[i]] = { position: posOf(o.position), prev: posOf(o.position_prev), page: pathOf(o.url, host) };
          if (o.serp_updated && o.serp_updated > row.updated) row.updated = o.serp_updated;
          if (row.volume == null && o.volume != null) row.volume = o.volume;
          rows.set(k, row);
        }
      });
      const best = (r) => Math.min(...DEVICES.map((d) => (r[d] && r[d].position) || 999));
      const keywords = [...rows.values()].sort((a, b) => best(a) - best(b) || a.keyword.localeCompare(b.keyword));
      // Phrases Ahrefs hasn't checked yet (just added) have no serp_updated: they read as unchecked, not
      // as "not in the top 100", and an overview with none checked is kept only an hour.
      data = {
        project: { id: project.id, name: project.name, url: project.url }, date, compared, keywords,
        checked: keywords.filter((k) => k.updated).length,
        updated: keywords.map((k) => k.updated).filter(Boolean).sort().pop() || '',
        units: project.units + res.reduce((n, r) => n + r.units, 0), fetchedAt: now.toISOString(),
      };
    }
  } catch (e) {
    data = { error: `Ahrefs: ${e.message}` };
  }
  if (!data.error) cache.set(`overview:${host}`, { at: data.keywords && !data.checked ? Date.now() - OVERVIEW_TTL + 3600000 : Date.now(), data });
  return data;
}

// One phrase's top 10 on Google (phone or computer), as Rank Tracker last saw it, with our result marked.
// Only a phrase the project tracks can be asked for, at the location it is tracked from.
export async function rankSerp(env, keyword, device, { now = new Date() } = {}) {
  if (!env.AHREFS_API_KEY) return { error: 'The Ahrefs key isn’t in the Worker yet.' };
  if (!DEVICES.includes(device)) return { error: 'Bad device' };
  const host = hostOf(env);
  const key = `serp:${host}:${device}:${keyword}`;
  const hit = cached(key, SERP_TTL);
  if (hit) return hit;
  let data;
  try {
    const project = await projectFor(env, host);
    if (!project.id) return { error: `No Ahrefs Rank Tracker project for ${host}.` };
    const kwKey = `keywords:${project.id}`;
    let kws = cached(kwKey, OVERVIEW_TTL);
    if (!kws) {
      kws = (await call(env, '/management/project-keywords', { project_id: project.id })).body.keywords || [];
      cache.set(kwKey, { at: Date.now(), data: kws });
    }
    const kw = kws.find((k) => k.keyword === keyword);
    if (!kw) return { error: 'That phrase isn’t tracked in Ahrefs.' };
    const { body, units } = await call(env, '/rank-tracker/serp-overview', {
      project_id: project.id, keyword, device, country: 'gb', language_code: kw.language_code, location_id: kw.location_id, top_positions: 10,
    });
    const positions = (body.positions || [])
      .map((p) => ({ position: posOf(p.position), url: String(p.url || ''), title: String(p.title || ''), type: (p.type || []).join(', '), dr: p.domain_rating ?? null }))
      .filter((p) => p.position)
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ ...p, ours: bare(p.url) === host }));
    data = { keyword, device, location: kw.location || '', positions, units, fetchedAt: now.toISOString() };
  } catch (e) {
    data = { error: `Ahrefs: ${e.message}` };
  }
  if (!data.error) cache.set(key, { at: Date.now(), data });
  return data;
}
