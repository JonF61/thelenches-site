// scripts/test-logsafe.js — public log lines never carry contact details (lib/logsafe.js).
'use strict';
const assert = require('assert');
const { scrub, outcomeNote } = require('../lib/logsafe');

assert.strictEqual(outcomeNote('No items: Contact: Emma, 07933 779918, info@x.org.uk.'), 'No items (reason in the Log tab)');
assert.strictEqual(outcomeNote('Spam: buy now from sales@spam.example (2 item(s) not added)'), 'Spam (details in the Log tab)');
assert.strictEqual(outcomeNote('Unusable attachment(s): Jane Smith CV.pdf, scan.heic'), 'Unusable attachment(s): 2');
assert.strictEqual(outcomeNote('Holding reply: held for you (a correction) | Ack dropped: over the sender limit'),
  'Holding reply: held for you (a correction) | Ack dropped: over the sender limit', 'fixed notes kept');
assert.strictEqual(outcomeNote(''), '');
for (const p of ['07933 779918', '01386 870221', '+44 7933 779918', '(01386) 870 221', '01386870221']) {
  assert.strictEqual(scrub(`ring ${p} today`), 'ring [phone] today', p);
}
assert.strictEqual(scrub('Write to A.Person@Example.co.uk.'), 'Write to [email].');
for (const keep of ['ages 2–4', '8.30am–3.30pm', 'Sat 12 and Tue 22 Dec, 10am–1pm', 'in 2026', 'WR11 4UE']) {
  assert.strictEqual(scrub(keep), keep, keep);
}
console.log('test-logsafe: all passed');
