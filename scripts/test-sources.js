// Offline tests for lib/sources.js: the Evesham Journal story filter (keepLocalStory, used by
// scripts/ingest/rss.js) and the source tag (localSource). Run by hand: node scripts/test-sources.js
'use strict';

const assert = require('assert');
const { keepLocalStory, localSource } = require('../lib/sources');

const kept = (title, text = '') => keepLocalStory({ title, text });

// Places: the five Lenches and Harvington, as before.
['Church Lench', 'Rous Lench', 'Ab Lench', 'Atch Lench', 'Sheriffs Lench', "Sheriff's Lench", 'Harvington']
  .forEach((p) => assert.ok(kept(`Fete planned in ${p}`), p));
// Places added: Inkberrow, Abbots Morton, Lenchwick, Radford, Norton, the Lenches.
['Inkberrow', 'Abbots Morton', 'Lenchwick', 'Radford', 'Norton', 'the Lenches']
  .forEach((p) => assert.ok(kept(`Village news from ${p}`), p));
assert.ok(kept('Pub reopens', 'The Coach and Horses near Norton and Lenchwick reopens.'), 'place in body');
assert.ok(kept('INKBERROW SHOP CLOSES'), 'case-insensitive');

// Not a match: Evesham alone, other towns, look-alike names.
assert.ok(!kept('Evesham market gets new stalls', 'Traders in Evesham High Street welcome the change.'), 'Evesham alone');
assert.ok(!kept('Pershore bridge repairs begin'), 'Pershore');
assert.ok(!kept('Chipping Norton festival line-up'), 'Chipping Norton');
assert.ok(!kept('Midsomer Norton school expands'), 'Midsomer Norton');
assert.ok(!kept('Stradford fan club'), 'no partial-word place');
assert.ok(!kept('Nortonville band tour'), 'no partial-word Norton');

// County-wide topics.
[
  'Landline switch-off to affect parts of Worcestershire',
  'What the digital phone switchover means for you',
  'BT digital voice upgrade: what to do',
  'Police warn of courier scam targeting the elderly',
  'Scammers pose as council staff',
  'Fraud warning issued by Trading Standards',
  'Fraudsters target pensioners',
  'Spate of burglaries across Wychavon',
  'Burglar jailed after break-ins',
  'House burgled while family away',
  'Flood warning issued for the River Avon',
  'Flooding closes roads across the county',
  'Thousands hit by power cuts after storm',
  'Power outage expected during network upgrade',
].forEach((t) => assert.ok(kept(t), t));
assert.ok(kept('Police advice', 'Residents are urged to watch out for doorstep scams this winter.'), 'topic in body');

// Not a topic match.
[
  'Worcestershire County Council faces £85m budget gap',
  'Worcestershire stockpiles salt for winter gritting',
  'Five Worcestershire shops fail underage vape tests',
  'Floodlights approved for football club',
  'Powerful performance at Evesham theatre',
].forEach((t) => assert.ok(!kept(t), t));

assert.ok(!keepLocalStory(null), 'null item');
assert.ok(!keepLocalStory({}), 'empty item');

// localSource: unchanged behaviour.
assert.strictEqual(localSource({ id: 'rss-abc-1', source: 'Evesham Journal' }), 'Evesham Journal');
assert.strictEqual(localSource({ id: 'rss-abc-1', source: 'News', link_url: 'https://www.eveshamjournal.co.uk/news/1' }), 'Evesham Journal');
assert.strictEqual(localSource({ id: 'abc-1', source: 'Evesham Journal' }), '', 'not an RSS row');
assert.strictEqual(localSource({ id: 'rss-abc-1', source: 'Wychavon' }), '', 'other feed');

// rss.js uses the same filter.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';
assert.strictEqual(require('./ingest/rss').aboutPlaces, keepLocalStory, 'rss.js uses keepLocalStory');

console.log('lib/sources.js tests passed.');
