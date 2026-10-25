// scripts/test-contacts.js
// Offline test: which emails count as someone writing to website@, grouping, contributions
// and how a Contacts row is merged (scripts/contacts). No Google or Claude calls.
// Run: node scripts/test-contacts.js
'use strict';

const assert = require('assert');
const c = require('./contacts/contacts');
const { buildText } = require('./contacts/profile');
const { addressOf } = require('./ingest/google');

const T = '2026-10-25';
const day = (s) => Date.parse(`${s}T10:00:00Z`);
const msg = (o) => ({
  fromAddress: addressOf(o.from), auto: {}, recipients: c.WEBSITE, subject: 'Quiz night',
  internalDate: day('2026-10-01'), text: 'Hello', attachments: [], ...o,
});

// Who counts.
assert.strictEqual(c.skipReason(msg({ from: 'Ann <ann@example.com>' })), '');
assert.strictEqual(c.skipReason(msg({ from: 'Club <club@gmail.com>', recipients: `x@y.com, ${c.WEBSITE}` })), '');
assert.strictEqual(c.skipReason(msg({ from: 'notifications@mailerlite.com' })), 'excluded sender');
assert.strictEqual(c.skipReason(msg({ from: 'x@facebookmail.com' })), 'excluded sender');
assert.strictEqual(c.skipReason(msg({ from: 'maureen@thelenches.org.uk' })), 'excluded sender');
assert.strictEqual(c.skipReason(msg({ from: 'no-reply@shop.com' })), 'excluded sender');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', auto: { autoSubmitted: 'auto-replied' } })), 'automated');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', auto: { autoSubmitted: 'no' } })), '');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', subject: 'Out of office: back Monday' })), 'automated');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', recipients: 'jon@thelenches.org.uk' })), 'not to website@');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', recipients: 'undisclosed-recipients:;' }), true), '', 'Pipeline label counts (Bcc)');
const big = Array.from({ length: 12 }, (_, i) => `p${i}@x.com`).join(', ');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', recipients: `${big}, ${c.WEBSITE}`, inReplyTo: '<1@x>' })), 'reply-all to a list');
assert.strictEqual(c.skipReason(msg({ from: 'a@b.com', recipients: `${big}, ${c.WEBSITE}` })), '', 'an original broadcast counts');
assert.ok(!c.excludedAddress('davejet35@googlemail.com'));

// Names and grouping.
assert.strictEqual(c.displayName('"Ann Hughes" <ann@example.com>'), 'Ann Hughes');
assert.strictEqual(c.displayName('ann@example.com'), '');
assert.strictEqual(c.displayName('"ann@example.com" <ann@example.com>'), '');
const groups = c.groupBySender([
  msg({ from: 'Ann H <ANN@example.com>', internalDate: day('2026-10-05') }),
  msg({ from: 'ann@example.com', internalDate: day('2026-09-01') }),
  msg({ from: 'Bob <bob@x.com>' }),
]);
assert.strictEqual(groups.size, 2);
const ann = groups.get('ann@example.com');
assert.strictEqual(ann.messages.length, 2);
assert.strictEqual(ann.messages[0].internalDate, day('2026-09-01'), 'oldest first');
assert.strictEqual(ann.name, 'Ann H');

// Contributions from Pending.
const pending = [
  { from: 'Ann H <ann@example.com>', received: '2026-09-01 10:00', title: 'Harvest supper', category: 'event', status: 'published' },
  { from: 'ann@example.com', received: '2026-10-05 09:00', title: 'Quiz night', category: 'event', status: 'pending' },
  { from: 'ann@example.com', received: '2026-10-05 09:00', title: '', category: 'event' },
  { from: 'bob@x.com', received: '2026-10-01', title: 'Lost cat', category: 'notice' },
];
const contrib = c.contributionsFor('ann@example.com', pending, addressOf);
assert.strictEqual(contrib.count, 2);
assert.strictEqual(contrib.list, '2026-10-05 Quiz night (event, pending); 2026-09-01 Harvest supper (event, published)');

// New row.
const profile = { name: 'Ann Hughes', organisation: 'Lenches WI', village: 'Church Lench', role: 'secretary', profile: 'Sends WI events.' };
const row = c.mergeRow(null, ann, contrib, profile, '2026-10-25 09:00', T);
assert.strictEqual(row.status, 'contributor');
assert.strictEqual(row.profile_source, 'auto');
assert.strictEqual(row.first_contact, '2026-09-01');
assert.strictEqual(row.last_contact, '2026-10-05');
assert.strictEqual(row.message_count, 2);
assert.strictEqual(row.name, 'Ann Hughes');
assert.strictEqual(row.organisation, 'Lenches WI');
assert.ok(!('notes' in row), 'notes never written');
const lead = c.mergeRow(null, groups.get('bob@x.com'), { list: '', count: 0 }, null, 'now', T);
assert.strictEqual(lead.status, 'lead');
assert.strictEqual(lead.name, 'Bob', 'display name when no profile');

// Existing row: only new messages counted, manual profile kept, lead promoted.
const existing = { email: 'ann@example.com', name: 'Ann', profile: 'Hand-written', profile_source: 'manual', status: 'lead', first_contact: '2026-08-01', last_contact: '2026-09-01', message_count: '5' };
const upd = c.mergeRow(existing, ann, contrib, profile, 'now', T);
assert.strictEqual(upd.message_count, 6, 'only the 5 Oct email is new');
assert.strictEqual(upd.first_contact, '2026-08-01');
assert.strictEqual(upd.last_contact, '2026-10-05');
assert.strictEqual(upd.status, 'contributor');
assert.ok(!('profile' in upd) && !('name' in upd), 'manual profile left alone');
const auto = c.mergeRow({ ...existing, profile_source: 'auto', status: 'dormant' }, ann, contrib, profile, 'now', T);
assert.strictEqual(auto.profile, 'Sends WI events.');
assert.strictEqual(auto.status, 'contributor', 'a dormant contact who writes again wakes up');
const kept = c.mergeRow({ ...existing, status: 'VIP' }, ann, contrib, profile, 'now', T);
assert.ok(!('status' in kept), 'a status set by hand is kept');
const old = c.mergeRow(null, { email: 'o@x.com', name: '', messages: [msg({ from: 'o@x.com', internalDate: day('2019-05-01') })] }, { list: '', count: 0 }, null, 'now', T);
assert.strictEqual(old.status, 'dormant');

// Dormant after a year without an email.
assert.strictEqual(c.autoStatus(0, '2025-10-24', T), 'dormant');
assert.strictEqual(c.autoStatus(3, '2025-10-26', T), 'contributor');
assert.strictEqual(c.autoStatus(0, '2026-10-01', T), 'lead');
assert.strictEqual(c.statusFor('lead', 0, '2019-01-01', T), 'dormant');
assert.strictEqual(c.statusFor('Lead', 0, '2026-10-01', T), null, 'unchanged');
assert.strictEqual(c.statusFor('ignore', 0, '2019-01-01', T), null);
assert.strictEqual(c.statusFor('dormant', 2, '2026-10-20', T), 'contributor');
assert.ok(c.locked({ status: 'Ignore' }));
assert.ok(!c.locked(null) && !c.locked({ status: 'lead' }));

// Claude input carries what we know and the emails, within budget.
const text = buildText(ann, { ...existing, profile: 'Old profile' }, contrib.list);
assert.ok(text.includes('Old profile') && text.includes('Quiz night (event, pending)') && text.includes('Subject: Quiz night'));
const huge = { ...ann, messages: Array.from({ length: 40 }, (_, i) => msg({ from: 'ann@example.com', internalDate: day('2026-01-01') + i * 864e5, text: 'x'.repeat(5000), subject: `S${i}` })) };
const t2 = buildText(huge, null, '');
assert.ok(t2.length < 30000 && t2.includes('Subject: S39') && !t2.includes('Subject: S0\n'), 'newest kept under budget');

console.log('test-contacts: all passed');
