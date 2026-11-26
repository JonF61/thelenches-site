// Offline test for long items in the newsletter (24 Nov 2026, Jon): select.js cuts a body over
// LONG_BODY characters at a sentence end near 500, adds "…" and `more` (the item's anchor on the
// website); render.js shows "Read more on the website" (HTML and text). Short items and older
// snapshots without `more` are unchanged.
// Usage: node scripts/test-long-items.js   and   SITE=harvington node scripts/test-long-items.js
'use strict';

const assert = require('assert');
const { SITE } = require('../lib/site');
const { select, shortenBody, LONG_BODY } = require('./newsletter/select');
const { render } = require('./newsletter/render');
const { anchorUrl, eventPageUrl } = require('../lib/anchors');

const sentence = 'The hall is now fully open and groups can return when they are able. ';
const long = sentence.repeat(14).trim();
assert.ok(long.length > LONG_BODY);
assert.strictEqual(shortenBody('Short body.'), null);
assert.strictEqual(shortenBody('x'.repeat(LONG_BODY)), null, 'at the limit: unchanged');
const cut = shortenBody(long);
assert.ok(cut.endsWith('able…'), `ends at a sentence: ${cut.slice(-20)}`);
assert.ok(cut.length >= 450 && cut.length <= 660, `length ${cut.length}`);
const noStops = 'word '.repeat(200).trim();
assert.ok(shortenBody(noStops).endsWith('word…'), 'no sentence end: cut at a space');

const base = { pending: [], bins: {}, siteupdates: { entries: [] }, issues: [], settings: {}, sources: [], onthisday: { entries: {} }, jpegFor: () => '' };
const notice = { title: "Reverend Caroline's letter from St Egwin's — November", body: long, added: '2026-11-22' };
const ev = { date: '2026-11-28', title: 'Quiz — Village Hall', body: long };
const short = { date: '2026-11-29', title: 'Bingo — Village Hall', body: 'From 7pm.' };
const m = select({ ...base, whatson: { notices: [notice], events: [ev, short] }, issueDate: '2026-11-26' });
const n = m.notices.find((x) => x.title === notice.title);
const e = m.events.find((x) => x.title === ev.title);
const s = m.events.find((x) => x.title === short.title);
assert.strictEqual(n.more, anchorUrl('notice', notice));
assert.strictEqual(e.more, eventPageUrl(ev)); // the event's own page where the site has them (SEO step 1)
assert.ok(!('more' in s) && s.body === 'From 7pm.', 'short item unchanged');
assert.ok(n.body.length < long.length);

const out = render(m);
assert.strictEqual(out.html.split('Read more on the website').length - 1, 2, 'two links in the HTML');
assert.ok(out.html.includes(`href="${n.more}"`));
assert.ok(out.text.includes(`Read more on the website: ${n.more}`));
assert.ok(out.text.includes(`Read more on the website: ${e.more}`));

// An older snapshot (no `more`) has no link.
const old = { ...m, notices: m.notices.map(({ more, ...r }) => r), events: m.events.map(({ more, ...r }) => r) };
assert.ok(!render(old).html.includes('Read more on the website'));
console.log(`test-long-items (${SITE}): all passed`);
