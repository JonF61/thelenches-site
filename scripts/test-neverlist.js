// Never-list (lib/neverlist.json; Jon, 25 Nov 2026): matching, no listed entry on either site, suggestion refusal.
const assert = require('assert');
const fs = require('fs');
const { blocked, listedProblems } = require('../lib/neverlist');
const list = { entries: [{ name: 'JD Landscape & Groundwork Contractors', match: ['jd landscape'], phones: ['07789325879'], note: 'closed' }] };
assert(blocked({ name: 'JD Landscape & Groundwork Contractors' }, list));
assert(blocked({ name: 'JD Landscapes Ltd' }, list));
assert(blocked({ name: 'Someone', phone: '+44 7789 325879' }, list));
assert(!blocked({ name: 'AJD Landscape' }, list));
assert(!blocked({ name: 'Garraidoir Landscaping & Design', phone: '07413 837599' }, list));
assert.deepStrictEqual(listedProblems({ trades: [{ name: 'JD Landscapes' }, { name: 'Other' }] }, { places: [] }, list), ['trades: JD Landscapes']);
for (const s of fs.readdirSync('sites')) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  assert.deepStrictEqual(listedProblems(read(`sites/${s}/_data/trades.json`), read(`sites/${s}/_data/eat.json`)), [], `${s} lists a never-list business`);
}
(async () => {
  const S = await import('../worker/src/admin/suggestions.mjs');
  const r = S.cleanEntry('trades', { name: 'JD Landscapes', trade: 'Landscaping and groundworks', phone: '07789 325879' }, {});
  assert(r.error && /never-list/.test(r.error), 'cleanEntry refuses a never-list business');
  const ok = S.cleanEntry('trades', { name: 'New Plumber', trade: 'Plumbing', phone: '07000 000000' }, {});
  assert(ok.entry, 'an ordinary entry still passes');
  for (const x of [{ name: 'JD Landscapes Ltd' }, { name: 'AJD Landscape' }, { name: 'x', phone: '+44 7789 325879' }, { name: 'Garraidoir' }]) {
    assert.strictEqual(!!S.neverListed(x, list), !!blocked(x, list), `Worker and lib agree on ${x.name}`);
  }
  console.log('never-list ok');
})().catch((e) => { console.error(e); process.exit(1); });
