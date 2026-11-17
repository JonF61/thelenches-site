// Tests for lib/placelabel.js (News page place labels). Run: node scripts/test-placelabel.js
'use strict';
const assert = require('assert');
const { placeLabel } = require('../lib/placelabel.js');
const H = ['Harvington', 'Norton', 'Lenchwick'];

assert.strictEqual(placeLabel({ village: 'Church Lench', title: 'x' }), 'Church Lench', 'no places: village as before');
assert.strictEqual(placeLabel({ title: 'x' }), '', 'no places, no village: nothing');
assert.strictEqual(placeLabel({ village: 'Lenches', title: 'Club closed' }, H), '', 'another community\'s label is left off');
assert.strictEqual(placeLabel({ village: 'Harvington', title: 'x' }, H), 'Harvington', 'own village kept');
assert.strictEqual(placeLabel({ village: 'Norton and Lenchwick', title: 'x' }, H), 'Norton and Lenchwick', 'own parish kept as written');
assert.strictEqual(placeLabel({ title: 'From tees to trees: Harvington Wood', body: '' }, H), 'Harvington', 'named in the title');
assert.strictEqual(placeLabel({ title: 'Survey', body: 'Lenchwick and Harvington readers' }, H), 'Lenchwick', 'first named in the body');
assert.strictEqual(placeLabel({ title: 'Church Lench fayre', body: 'At All Saints\'.' }, H), '', 'nothing of ours named');
assert.strictEqual(placeLabel({ title: 'Abbots Morton lights', body: '' }, H), '', 'Morton is not Norton');
assert.strictEqual(placeLabel({ place: 'Harvington', title: 'Survey', body: 'Norton' }, H), 'Harvington', 'place wins');
assert.strictEqual(placeLabel({ place: 'Harvington', village: 'Ab Lench', title: 'x' }), 'Ab Lench', 'the Lenches ignores place');
console.log('placelabel tests passed');
