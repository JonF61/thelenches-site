// Offline test for scripts/sponsorcontacts (mocked fetch and Sheet).
'use strict';
const assert = require('assert');
const { run, guesses, looksLike } = require('./sponsorcontacts');

assert.ok(guesses('Nigel Poole & Partners').includes('https://www.nigelpoole.co.uk'));
assert.deepStrictEqual(guesses('QualitySolicitors Parkinson Wright').slice(0, 1), ['https://www.parkinsonwright.co.uk']);
assert.ok(looksLike('<p>Nigel Poole &amp; Partners, 23 High Street, Pershore</p>', 'Nigel Poole & Partners', 'Pershore'));
assert.ok(!looksLike('<p>Kind Ltd, Leeds</p>', 'Kind Wealth', 'Evesham'));
assert.ok(!looksLike('<p>Nigel Poole &amp; Partners, London</p>', 'Nigel Poole & Partners', 'Pershore'));

const pages = {
  'https://www.knownsite.co.uk': '<a href="/contact">Contact</a>',
  'https://www.knownsite.co.uk/contact': '<a href="mailto:info@knownsite.co.uk">Email</a>',
  'https://www.nigelpoole.co.uk': '<h1>Nigel Poole &amp; Partners</h1> Pershore <a href="mailto:pershore@nigelpoole.co.uk">x</a>',
  'https://www.coxhodgetts.co.uk': '<h1>Cox &amp; Hodgetts</h1> Bristol',
};
const fetchMock = async (u) => {
  const body = pages[u.replace(/\/+$/, '')];
  return body ? { ok: true, headers: { get: () => 'text/html' }, text: async () => body } : { ok: false };
};
const rows = [
  { _row: 2, name: 'Has Email', town: 'Evesham', email: 'a@b.co.uk', website: '', notes: '' },
  { _row: 3, name: 'Known Site', town: 'Evesham', email: '', website: 'knownsite.co.uk', notes: '' },
  { _row: 4, name: 'Nigel Poole & Partners', town: 'Pershore', email: '', website: '', notes: 'Partnership' },
  { _row: 5, name: 'Cox & Hodgetts', town: 'Evesham', email: '', website: '', notes: '' },
];
const writes = [];
const g = { readTable: async () => rows, updateRow: async (tab, row, f) => writes.push({ tab, row, f }) };
const logs = []; const orig = console.log; console.log = (m) => logs.push(m);
run({ g, fetch: fetchMock }).then((res) => {
  console.log = orig;
  assert.deepStrictEqual(res, { looked: 3, found: 2, sites: 1 });
  assert.deepStrictEqual(writes, [
    { tab: 'Sponsors', row: 3, f: { email: 'info@knownsite.co.uk' } },
    { tab: 'Sponsors', row: 4, f: { email: 'pershore@nigelpoole.co.uk', website: 'nigelpoole.co.uk', notes: 'Partnership; Website guessed by the finder: check it is the right firm' } },
  ]);
  assert.ok(!logs.join('\n').includes('@'), 'logs never print an address');
  console.log('test-sponsorcontacts: ok');
}).catch((e) => { console.log = orig; console.error(e); process.exit(1); });
