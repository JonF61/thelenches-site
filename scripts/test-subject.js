// Offline test for the newsletter subject line (11 Nov 2026): select.js subjectTeaser names up to two
// lead events (Lenches first, this week first, then by date); render.js builds
// "The Lenches Newsletter – 12 Nov: A, B and more"; old snapshots keep the date-only subject.
// Usage: node scripts/test-subject.js   (also prints the subject the current files give for 12 Nov)
'use strict';

const assert = require('assert');
const { select, shortName } = require('./newsletter/select');
const { render, subjectFor } = require('./newsletter/render');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };
const eq = (a, b, what) => { assert.strictEqual(a, b, what); checks += 1; };

eq(shortName("Liz's Quiz — Rous Lench Village Hall"), "Liz's Quiz", 'em dash');
eq(shortName('Bonfire and Fireworks Night - Bishampton'), 'Bonfire and Fireworks Night', 'hyphen');
eq(shortName('Pub night'), 'Pub night', 'no venue');
eq(shortName('Carols — Church: '), 'Carols', 'trailing');

const base = { pending: [], bins: {}, siteupdates: { entries: [] }, issues: [], settings: {}, sources: [], onthisday: { entries: {} }, jpegFor: () => '' };
const ev = (date, title, body = '') => ({ date, title, body });
const whatson = { notices: [{ title: 'Hall car park', body: 'Closed.' }], events: [
  ev('2026-11-13', 'Bingo — Norton Village Hall'),
  ev('2026-11-13', "Liz's Quiz — Rous Lench Village Hall"),
  ev('2026-11-21', 'Christmas Fayre — Church Lench Village Hall'),
  ev('2026-11-14', 'Craft with Community — St James\'s Church, Harvington'),
] };
const m = select({ ...base, whatson, issueDate: '2026-11-12' });
eq(m.subjectTeaser.join('|'), "Liz's Quiz|Christmas Fayre", 'Lenches first, this week first');
eq(render(m).subject, "The Lenches Newsletter – 12 Nov: Liz's Quiz, Christmas Fayre and more", 'subject with more');

const one = select({ ...base, whatson: { events: [ev('2026-11-13', "Liz's Quiz — Rous Lench Village Hall")], notices: [] }, issueDate: '2026-11-12' });
eq(render(one).subject, "The Lenches Newsletter – 12 Nov: Liz's Quiz", 'one item, no "and more"');

const two = select({ ...base, whatson: { events: [ev('2026-11-13', "Liz's Quiz — Rous Lench Village Hall"), ev('2026-11-21', 'Christmas Fayre — Church Lench Village Hall')], notices: [] }, issueDate: '2026-11-12' });
eq(render(two).subject, "The Lenches Newsletter – 12 Nov: Liz's Quiz and Christmas Fayre", 'two items only');

const none = select({ ...base, whatson: { events: [], notices: whatson.notices }, issueDate: '2026-11-12' });
eq(render(none).subject, 'The Lenches Newsletter – Thursday 12 November', 'no events = date only');
eq(subjectFor({ issueDate: '2026-11-05' }), 'The Lenches Newsletter – Thursday 5 November', 'old snapshot = date only');

const long = select({ ...base, whatson: { events: [ev('2026-11-13', 'A very long event name that goes on and on and on — Rous Lench'), ev('2026-11-14', 'Pub Night — Rous Lench Village Hall')], notices: [] }, issueDate: '2026-11-12' });
eq(long.subjectTeaser.join('|'), 'Pub Night', 'over-long names left out');

const dup = select({ ...base, whatson: { events: [ev('2026-11-13', 'Cash Bingo — The Lenches Club'), ev('2026-11-27', 'Cash Bingo — The Lenches Club')], notices: [] }, issueDate: '2026-11-12' });
eq(dup.subjectTeaser.join('|'), 'Cash Bingo', 'no repeats');
const andName = select({ ...base, whatson: { events: [ev('2026-11-13', "Liz's Quiz and pub night — Rous Lench Village Hall"), ev('2026-11-14', 'Bingo — Norton Village Hall')], notices: whatson.notices }, issueDate: '2026-11-12' });
eq(render(andName).subject, "The Lenches Newsletter – 12 Nov: Liz's Quiz and pub night, Bingo, and more", 'comma when a name has "and"');
ok(render(m).hash !== render(none).hash, 'subject is in the hash');

// What the current files would give for 12 Nov (hand-written items only; Pending rows not included).
const { loadWhatson } = require('../lib/whatson');
const real = select({ ...base, whatson: loadWhatson(), issueDate: '2026-11-12' });
console.log(`12 Nov (hand-written items only): ${render(real).subject}`);
console.log(`test-subject: ${checks} checks passed`);
