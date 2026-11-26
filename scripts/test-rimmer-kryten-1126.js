// scripts/test-rimmer-kryten-1126.js: offline checks for Rimmer's findings sent to Kryten on 25 Nov 2026:
// a submission's 24-hour time cell shown as the site writes times (select.js niceTime), a multi-day
// hand-written event's Google Calendar link covering its days (endDate kept in the model), and Rimmer
// seeing a Google Maps search's place (scripts/rimmer/index.js htmlToText). Run: node scripts/test-rimmer-kryten-1126.js
'use strict';
const assert = require('assert/strict');
const { niceTime } = require('./newsletter/select');
const { googleCalendarLink } = require('../lib/anchors');
const { htmlToText } = require('./rimmer/index');
const { mapUrl } = require('../lib/planning');

assert.equal(niceTime('16:00-18:00'), '4pm to 6pm');
assert.equal(niceTime('10:00-12:00'), '10am to noon');
assert.equal(niceTime('19:30'), '7.30pm');
assert.equal(niceTime('19:15-'), '7.15pm');
assert.equal(niceTime('19:30-23:00'), '7.30pm to 11pm');
assert.equal(niceTime('00:00'), 'midnight');
assert.equal(niceTime('7.30pm'), '7.30pm');
assert.equal(niceTime('From 2pm'), 'From 2pm');
assert.equal(niceTime('25:00'), '25:00');
assert.equal(niceTime(''), '');

const ev = { date: '2026-12-06', endDate: '2026-12-24', title: 'Handbell ringing — Harvington', body: 'Morrisons Wed 9 Dec, 5–8pm.' };
const url = new URL(googleCalendarLink(ev));
assert.equal(url.searchParams.get('dates'), '20261206/20261225');
const one = new URL(googleCalendarLink({ ...ev, endDate: undefined }));
assert.match(one.searchParams.get('dates'), /T/);

const t = htmlToText(`<p><a href="${mapUrl('1 Main Street, Norton')}">Map</a></p>`);
assert.match(t, /Map \(Google Maps search: 1 Main Street, Norton, Worcestershire\)/);
assert.match(htmlToText('<a href="https://www.google.com/maps/search/">Map</a>'), /no place given/);
console.log('rimmer 25 Nov findings: all tests passed');
