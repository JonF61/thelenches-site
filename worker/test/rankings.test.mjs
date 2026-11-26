// worker/test/rankings.test.mjs: SEO → Rankings (admin/rankings.js, 26 Nov 2026) against a mocked
// Ahrefs API v3: project choice, phone and computer merged, week-ago dates, caching, the top 10, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankings, rankSerp, pickProject, hostOf, resetRankCache } from '../src/admin/rankings.js';

const env = { AHREFS_API_KEY: 'k', SITE_HOST: 'thelenches.org.uk', SITE_URL: 'https://thelenches.org.uk/' };
const now = new Date('2026-11-26T10:00:00Z');
const reply = (body, units = 0, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'x-api-units-cost-total-actual': String(units) } });
const PROJECTS = { projects: [
  { project_id: '1', project_name: 'Thelenches', url: 'https://www.thelenches.org.uk/', mode: 'subdomains', keyword_count: 0 },
  { project_id: '2', project_name: 'Thelenches', url: 'https://thelenches.org.uk/', mode: 'subdomains', keyword_count: 22 },
  { project_id: '3', project_name: 'Harvingtonvillage', url: 'https://harvingtonvillage.org.uk/', mode: 'subdomains', keyword_count: 5 },
] };

test('hostOf and pickProject: this domain, with phrases, whole-domain first', () => {
  assert.equal(hostOf({ SITE_URL: 'https://www.harvingtonvillage.org.uk/' }), 'harvingtonvillage.org.uk');
  assert.equal(pickProject(PROJECTS.projects, 'thelenches.org.uk').project_id, '2');
  assert.equal(pickProject(PROJECTS.projects, 'harvingtonvillage.org.uk').project_id, '3');
  assert.equal(pickProject([{ url: '*.thelenches.org.uk/*', mode: 'exact', keyword_count: 3 }, { url: 'thelenches.org.uk', mode: 'domain', keyword_count: 1, project_id: 'd' }], 'thelenches.org.uk').project_id, 'd');
  assert.equal(pickProject(PROJECTS.projects, 'example.org'), null);
});

test('rankings: phone and computer merged, best first, week-ago compare, cached', async () => {
  resetRankCache();
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    seen.push(u);
    assert.equal(init.headers.authorization, 'Bearer k');
    if (u.pathname === '/v3/management/projects') return reply(PROJECTS);
    assert.equal(u.pathname, '/v3/rank-tracker/overview');
    assert.equal(u.searchParams.get('project_id'), '2');
    assert.equal(u.searchParams.get('date'), '2026-11-26');
    assert.equal(u.searchParams.get('date_compared'), '2026-11-19');
    const mob = u.searchParams.get('device') === 'mobile';
    return reply({ overviews: [
      { keyword: 'pubs near Evesham', location: 'Evesham', position: null, position_prev: mob ? 40 : null, url: null, volume: 300 },
      { keyword: 'Lenches bin collection', location: 'Evesham', position: mob ? 2 : 3, position_prev: 3, url: 'https://thelenches.org.uk/bins/', volume: 10, serp_updated: '2026-11-25T04:00:00Z' },
    ] }, 50);
  };
  const d = await rankings(env, { now });
  assert.equal(d.project.id, 2);
  assert.equal(d.compared, '2026-11-19');
  assert.equal(d.keywords[0].keyword, 'Lenches bin collection');
  assert.deepEqual(d.keywords[0].mobile, { position: 2, prev: 3, page: '/bins/' });
  assert.deepEqual(d.keywords[0].desktop, { position: 3, prev: 3, page: '/bins/' });
  assert.deepEqual(d.keywords[1].mobile, { position: null, prev: 40, page: '' });
  assert.equal(d.updated, '2026-11-25T04:00:00Z');
  assert.equal(d.units, 100);
  assert.equal(d.checked, 1, 'a phrase with no serp_updated is not checked yet');
  const n = seen.length;
  await rankings(env, { now });
  assert.equal(seen.length, n, 'cached');
});

test('rankings: no key, no project, and an Ahrefs error', async () => {
  resetRankCache();
  assert.ok((await rankings({ SITE_HOST: 'thelenches.org.uk' })).off);
  globalThis.fetch = async () => reply(PROJECTS);
  const none = await rankings({ ...env, SITE_HOST: 'example.org' }, { now });
  assert.ok(none.off && /example\.org/.test(none.why));
  resetRankCache();
  globalThis.fetch = async () => reply({ error: 'Insufficient plan' }, 0, 403);
  const bad = await rankings(env, { now });
  assert.match(bad.error, /HTTP 403 \(Insufficient plan\)/);
});

test('rankSerp: only tracked phrases, at their location; ours marked, in order', async () => {
  resetRankCache();
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === '/v3/management/projects') return reply(PROJECTS);
    if (u.pathname === '/v3/management/project-keywords') return reply({ keywords: [{ keyword: 'walks near Evesham', location: 'Evesham', location_id: 77, language_code: 'en' }] });
    assert.equal(u.pathname, '/v3/rank-tracker/serp-overview');
    assert.equal(u.searchParams.get('location_id'), '77');
    assert.equal(u.searchParams.get('country'), 'gb');
    assert.equal(u.searchParams.get('top_positions'), '10');
    return reply({ positions: [
      { position: 2, url: 'https://www.thelenches.org.uk/living-here/walks/', title: 'Walks', type: ['organic'] },
      { position: 1, url: 'https://www.alltrails.com/x', title: 'AllTrails', type: ['organic'] },
    ] }, 30);
  };
  const s = await rankSerp(env, 'walks near Evesham', 'mobile', { now });
  assert.deepEqual(s.positions.map((p) => [p.position, p.ours]), [[1, false], [2, true]]);
  assert.match((await rankSerp(env, 'something else', 'mobile')).error, /isn’t tracked/);
  assert.match((await rankSerp(env, 'walks near Evesham', 'tablet')).error, /Bad device/);
});
