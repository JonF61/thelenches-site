// lib/logsafe.js
// Actions logs are public (the repo is public), so anything printed about a real person's
// email goes through here first (5 Nov, Jon: an ingest log printed a contact's name and
// mobile from Claude's "No items" note). The full text still goes to the private Log tab.
'use strict';

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
// UK phone numbers: 07xxx xxxxxx, 01386 870221, +44 7933 779918, (01386) 870 221 …
const PHONE = /(?:\+44\s?\(?0?\)?\s?|\(?0)\d[\d\s()-]{7,13}\d/g;

// Email addresses and phone numbers replaced with [email] / [phone].
function scrub(text) {
  return String(text ?? '').replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

// An ingest outcome note for the log: Claude's free-text reasons ("No items: …", "Spam: …")
// become their label only, as they quote and describe the sender; other parts are scrubbed.
function outcomeNote(note) {
  return String(note ?? '').split(' | ').filter(Boolean).map((part) => {
    if (/^No items:/.test(part)) return 'No items (reason in the Log tab)';
    if (/^Spam:/.test(part)) return 'Spam (details in the Log tab)';
    if (/^Unusable attachment\(s\):/.test(part)) return `Unusable attachment(s): ${part.split(':').slice(1).join(':').split(',').length}`;
    return scrub(part);
  }).join(' | ');
}

module.exports = { scrub, outcomeNote };
