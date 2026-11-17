// scripts/test-newsletter-shared.js
// Offline test of scripts/newsletter/shared.js (17 Nov): a site's newsletter takes the other
// site's live Pending items for it, with their pictures, as its Events page does; its own copy
// wins; another site's counts are not used; items for one site only stay there; an unreadable
// Sheet leaves its items out; the draft editor never tags another site's items. No Google calls.
// Run: node scripts/test-newsletter-shared.js   (and with SITE=harvington)
'use strict';

const assert = require('assert');
const { SITE, otherSites } = require('../lib/site');
const { sharedPending } = require('./newsletter/shared');
const { select } = require('./newsletter/select');
const { buildDraft } = require('./newsletter/draft');

const other = otherSites()[0];
const ev = (id, title, extra = {}) => ({
  id, title, summary: 'All welcome.', category: 'event', status: 'approved', event_date: '2026-11-21',
  received: '2026-11-16 10:00', decided_at: '2026-11-16 11:00', image_url: `/images/items/${id}.webp`, alt_text: 'Poster', ...extra,
});
const theirs = [
  ev('o1', 'Wreath workshop — Club', { newsletter_count: '9', flyer_count: '9' }),
  ev('o2', 'Only for them — Hall', { sites: other }),
  ev('o3', 'Waiting — Hall', { status: 'pending' }),
  ev('o4', 'Same event — Hall', { summary: 'Their copy.' }),
];
const own = [
  ev('m1', 'Same event — Hall', { summary: 'Our copy.' }),
  ev('m2', 'Ours elsewhere only — Hall', { sites: other }),
];

(async () => {
  const g = { readOtherTable: async (s, tab) => { assert.strictEqual(tab, 'Pending'); assert.strictEqual(s, other); return theirs.map((r) => ({ ...r, _site: s })); } };
  const rows = await sharedPending(g, own);
  const ids = rows.map((r) => r.id);
  assert.deepStrictEqual(ids, ['o1', 'o4', 'm1'], 'live rows for this site, the other site first');
  assert.strictEqual(rows[0].newsletter_count, '', "the other site's counts are not used");
  assert.strictEqual(rows[0]._site, other);
  assert.strictEqual(theirs[0].newsletter_count, '9', 'the rows read are not changed');

  const jpegFor = (u) => `https://example.org${u.replace(/\.webp$/, '.jpg')}`;
  const base = {
    issueDate: '2026-11-19', cutoff: '', settings: {}, sources: [], jpegFor, issues: [],
    whatson: { events: [], notices: [] }, bins: {}, siteupdates: {}, onthisday: { entries: {} },
  };
  const model = select({ ...base, pending: rows });
  const wreath = model.events.find((e) => e.title === 'Wreath workshop — Club');
  assert.ok(wreath, "the other site's event is in the issue");
  assert.ok(wreath.image && /o1\.jpg$/.test(wreath.image.src), 'with its picture');
  const same = model.events.filter((e) => e.title === 'Same event — Hall');
  assert.strictEqual(same.length, 1);
  assert.strictEqual(same[0].body, 'Our copy.', "this site's own copy wins");
  assert.ok(!model.events.some((e) => /Only for them|Ours elsewhere|Waiting/.test(e.title)));

  // An unreadable Sheet: own rows only, with a warning.
  const warn = console.warn; let warned = '';
  console.warn = (m) => { warned += m; };
  const alone = await sharedPending({ readOtherTable: async () => { throw new Error('403'); } }, own);
  console.warn = warn;
  assert.deepStrictEqual(alone.map((r) => r.id), ['m1']);
  assert.ok(/unreadable/.test(warned));

  // The draft: shown, but only this site's own items get edit tags.
  const draft = buildDraft({ ...base, today: '2026-11-17', pending: own, shared: rows });
  assert.ok(draft.html.includes('Wreath workshop'));
  assert.ok(draft.html.includes('data-entry="p:m1"'), 'own item editable');
  assert.ok(!draft.html.includes('data-entry="p:o1"'), "another site's item not editable");

  console.log(`test-newsletter-shared (${SITE}): all passed`);
})().catch((err) => { console.error(err); process.exit(1); });
