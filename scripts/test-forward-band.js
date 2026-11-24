// Offline test for the newsletter's "forward this" band (24 Nov 2026, Jon: Harvington only): select.js
// puts site.json forwardBand in the model as `forward`; render.js shows it just above Coming up (HTML
// and text); a site without it, and an older snapshot without `forward`, render exactly as before.
// Usage: node scripts/test-forward-band.js   and   SITE=harvington node scripts/test-forward-band.js
'use strict';

const assert = require('assert');
const { SITE, siteConfig } = require('../lib/site');
const { select, forwardBandFor } = require('./newsletter/select');
const { render } = require('./newsletter/render');

const base = { pending: [], bins: {}, siteupdates: { entries: [] }, issues: [], settings: {}, sources: [], onthisday: { entries: {} }, jpegFor: () => '' };
const whatson = { notices: [], events: [{ date: '2026-11-27', title: 'Quiz — Village Hall', body: 'From 7pm.' }] };
const m = select({ ...base, whatson, issueDate: '2026-11-26' });
const band = siteConfig().forwardBand;

assert.strictEqual(forwardBandFor({}), null);
assert.strictEqual(forwardBandFor({ forwardBand: { heading: 'x' } }), null, 'needs a body');

if (SITE === 'harvington') {
  assert.ok(band, 'Harvington has forwardBand');
  assert.deepStrictEqual(m.forward, { heading: band.heading, body: band.body, button: band.button, url: band.url });
  const out = render(m);
  const at = out.html.indexOf(band.heading);
  assert.ok(at > 0 && at < out.html.indexOf('Coming up'), 'band above Coming up');
  assert.ok(out.html.includes('href="https://harvingtonvillage.org.uk/newsletter/"'), 'sign-up link');
  assert.ok(out.text.indexOf(band.heading.toUpperCase()) < out.text.indexOf('COMING UP') || !/COMING UP/.test(out.text), 'text version');
  assert.ok(out.text.includes('Sign up for the newsletter: https://harvingtonvillage.org.uk/newsletter/'));
} else {
  assert.ok(!band, 'the Lenches has no forwardBand');
  assert.ok(!('forward' in m), 'no forward key in the Lenches model');
}
// An older snapshot (no `forward`) renders the same as before the band existed.
const old = { ...m }; delete old.forward;
const withBand = render({ ...old, forward: { heading: 'H', body: 'B', button: 'Go', url: '/newsletter/' } });
assert.notStrictEqual(render(old).html, withBand.html);
assert.ok(!render(old).html.includes('>H</div>'));
console.log(`test-forward-band (${SITE}): all passed`);
