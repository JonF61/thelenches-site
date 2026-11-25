// Website updates link to their own pages (25 Nov 2026); older snapshots keep one home-page link.
const assert = require('assert');
const { render } = require('../scripts/newsletter/render.js');
const base = { issueDate: '2026-11-26', subjectTeaser: [], events: [], notices: [], news: [], roads: [], elsewhere: [],
  onThisDay: null, cartoon: null, where: null, regulars: [], bins: { expired: true, groups: [] },
  siteUpdates: [{ key: 's:a', text: 'First.', url: 'https://example.org/' }, { key: 's:b', text: 'Planning.', url: 'https://thelenches.org.uk/living-here/planning/' }] };
const html = (r) => (typeof r === 'string' ? r : r.html);
const old = render(base);
assert(!html(old).includes('href="https://thelenches.org.uk/living-here/planning/"'), 'older snapshot: no per-entry link');
assert.strictEqual((html(old).match(/Have a look at/g) || []).length, 1);
const neu = render({ ...base, siteUpdateLinks: true });
assert(html(neu).includes('href="https://thelenches.org.uk/living-here/planning/"'));
assert(html(neu).includes('>thelenches.org.uk/living-here/planning</a>'));
assert(html(neu).includes('href="https://example.org/"'));
assert(neu.text.includes('Planning. Have a look at https://thelenches.org.uk/living-here/planning/'));
console.log('site update links ok');
