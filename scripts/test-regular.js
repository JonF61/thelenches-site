// Regular activities (8 Nov): extract.js flags ongoing classes and groups; holdRegular keeps them pending with a note.
process.env.ANTHROPIC_API_KEY = 'x';
const assert = require('assert');
const { normalise, holdRegular, REGULAR_NOTE, SYSTEM } = require('./ingest/extract.js');
const [a, b] = normalise([
  { title: 'Pilates — Church Lench Village Hall', village: 'Church Lench', category: 'event', regular: true, summary: 'Every Wednesday.' },
  { title: 'Quiz night — The Lenches Club', village: 'Ab Lench', category: 'event', summary: 'One night only.' },
], 0);
assert.strictEqual(a.regular, true);
assert.strictEqual(b.regular, false);
let notes = [];
assert.deepStrictEqual(holdRegular(a, { status: 'auto', byTrust: true }, notes), { status: 'pending', byTrust: true });
assert.deepStrictEqual(notes, [REGULAR_NOTE]);
notes = [];
assert.deepStrictEqual(holdRegular(b, { status: 'auto' }, notes), { status: 'auto' });
assert.deepStrictEqual(notes, []);
assert.ok(/regular is true/.test(String(SYSTEM)));
console.log('ok');
