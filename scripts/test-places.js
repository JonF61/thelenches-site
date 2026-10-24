// scripts/test-places.js
// Offline test: the shared places list (lib/places.js) as used by the photos run's folder
// meaning (photos/meaning.js) and the event-image folder choice (eventimages villageFor).
// Run: node scripts/test-places.js
'use strict';

const assert = require('assert');
const { PLACES, placeName, placesIn, isLench } = require('../lib/places');
const { meaning } = require('./photos/meaning');
const { villageFor } = require('./eventimages/index');

// Variants, case and hyphens.
assert.strictEqual(placeName('Abbots Lench'), 'Ab Lench');
assert.strictEqual(placeName("abbot's lench"), 'Ab Lench');
assert.strictEqual(placeName('Abbot’s Lench'), 'Ab Lench');
assert.strictEqual(placeName("Sheriff's Lench"), 'Sheriffs Lench');
assert.strictEqual(placeName("Abbot's Morton"), 'Abbots Morton');
assert.strictEqual(placeName('bidford on avon'), 'Bidford-on-Avon');
assert.strictEqual(placeName('Bidford'), 'Bidford-on-Avon');
assert.strictEqual(placeName('STRATFORD ON AVON'), 'Stratford-upon-Avon');
assert.strictEqual(placeName('Stratford upon Avon'), 'Stratford-upon-Avon');
assert.strictEqual(placeName('Middle Littleton'), 'The Littletons');
assert.strictEqual(placeName('Droitwich'), 'Droitwich Spa');
assert.strictEqual(placeName('Great Malvern'), 'Malvern');
assert.strictEqual(placeName('Upton upon Severn'), 'Upton-upon-Severn');
assert.strictEqual(placeName('Hinton-on-the-Green'), 'Hinton on the Green');
assert.strictEqual(placeName('General'), '');
assert.strictEqual(placeName('Lenches Club'), '');
assert.ok(isLench('Abbots Lench') && !isLench('Harvington'));
assert.strictEqual(new Set(PLACES).size, PLACES.length, 'no place listed twice');

// Text: longest name wins where two overlap; list order otherwise.
assert.deepStrictEqual(placesIn('Open gardens at Wood Norton'), ['Wood Norton']);
assert.deepStrictEqual(placesIn('Walk from Bidford-on-Avon to Marlcliff'), ['Bidford-on-Avon', 'Marlcliff']);
assert.deepStrictEqual(placesIn('Evesham then Church Lench'), ['Church Lench', 'Evesham']);
assert.deepStrictEqual(placesIn('Nortonville and Broadwayish'), [], 'whole words only');

// Photos folders: a place (any variant) is a village under its first name; else a subject.
const m = (p) => { const x = meaning(p.split('/').filter(Boolean)); return [x.village, x.subject]; };
assert.deepStrictEqual(m("Abbot's Lench/Church"), ['Ab Lench', 'Church']);
assert.deepStrictEqual(m('Fladbury/Events'), ['Fladbury', 'Events']);
assert.deepStrictEqual(m('stratford-upon-avon'), ['Stratford-upon-Avon', '']);
assert.deepStrictEqual(m('Amphitheatre/Shows'), ['', 'Amphitheatre']);

// Event images: the title's " — Place" tail first, then any place in title or body.
assert.strictEqual(villageFor({ title: "Quiz night — Abbot's Lench" }), 'Ab Lench');
assert.strictEqual(villageFor({ title: 'Craft fair — Cleeve Prior' }), 'Cleeve Prior');
assert.strictEqual(villageFor({ title: 'Bonfire', body: 'At the rugby club, Bidford on Avon.' }), 'Bidford-on-Avon');
assert.strictEqual(villageFor({ title: 'Panto', body: 'Tickets online.' }), 'General');

console.log('test-places: all passed');
