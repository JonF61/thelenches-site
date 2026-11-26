// scripts/test-linkcheck.js: the Link partners check (scripts/linkcheck), offline.
'use strict';
const assert = require('assert');
const L = require('./linkcheck');

const D = ['thelenches.org.uk'];
assert.strictEqual(L.linksToUs('<a href="https://thelenches.org.uk/events/">x</a>', D), true);
assert.strictEqual(L.linksToUs("<a class=x href='http://www.thelenches.org.uk'>x</a>", D), true);
assert.strictEqual(L.linksToUs('<p>thelenches.org.uk</p><a href="https://notthelenches.org.uk/">x</a>', D), false, 'text or look-alike domain is not a link');
assert.deepStrictEqual(L.candidatePages(
  '<a href="/useful-links">Links</a><a href="/about">x</a><a href="/shop">Buy</a><a href="https://other.org/links">Links</a><a href="/files/a.pdf">Links</a><a href="/x">Village groups</a>',
  'https://club.org/'), ['https://club.org/useful-links', 'https://club.org/about', 'https://club.org/x']);

assert.strictEqual(L.nextStatus('', 'linking'), 'Linking');
assert.strictEqual(L.nextStatus('Asked', 'linking'), 'Linking');
assert.strictEqual(L.nextStatus('Declined', 'linking'), 'Declined', "Jon's Declined is kept");
assert.strictEqual(L.nextStatus('Linking', 'none'), 'Link gone');
assert.strictEqual(L.nextStatus('Linking', 'unreadable'), 'Linking', 'an unreadable site is not a lost link');
assert.strictEqual(L.nextStatus('', 'none'), 'To ask');

assert.deepStrictEqual(L.rowUpdate({ status: 'To ask', link_found_at: '', last_checked: '2026-11-23', check: 'No link found' }, { result: 'none', at: '' }, '2026-11-30'), { last_checked: '2026-11-30' });
assert.strictEqual(L.rowUpdate({ status: 'To ask', link_found_at: '', last_checked: '2026-11-30', check: 'No link found' }, { result: 'none', at: '' }, '2026-11-30'), null);
assert.deepStrictEqual(L.rowUpdate({ status: 'Asked' }, { result: 'linking', at: 'https://a.org/links' }, '2026-11-30'),
  { status: 'Linking', link_found_at: 'https://a.org/links', last_checked: '2026-11-30', check: 'Links to us' });

(async () => {
  const pages = {
    'https://a.org/': '<a href="/links">Useful links</a>',
    'https://a.org/links': '<a href="https://www.thelenches.org.uk/">The Lenches</a>',
    'https://b.org/': '<a href="/links">Links</a>',
    'https://b.org/links': 'none here',
  };
  const fetch = async (u) => (pages[u] !== undefined ? { ok: true, headers: { get: () => 'text/html' }, text: async () => pages[u] } : { ok: false });
  assert.deepStrictEqual(await L.checkSite('https://a.org/', D, { fetch }), { result: 'linking', at: 'https://a.org/links' });
  assert.deepStrictEqual(await L.checkSite('https://b.org/', D, { fetch }), { result: 'none', at: '' });
  assert.deepStrictEqual(await L.checkSite('https://gone.org/', D, { fetch }), { result: 'unreadable', at: '' });
  assert.deepStrictEqual(await L.checkSite('', D, { fetch }), { result: 'no-url', at: '' });
  assert.deepStrictEqual(await L.checkSite('https://www.facebook.com/groups/x', D, { fetch }), { result: 'facebook', at: '' });
  const seed = L.seedRows('lenches');
  assert.ok(seed.length >= 20 && seed.every((r) => r.id && r.name && r.status === 'To ask'));
  assert.ok(seed.every((r) => !/@/.test(JSON.stringify(r))), 'no email addresses in the public seed list');
  assert.deepStrictEqual(new Set(seed.map((r) => r.id)).size, seed.length, 'ids unique');
  console.log('test-linkcheck: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
