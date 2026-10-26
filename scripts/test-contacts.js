// scripts/test-contacts.js
// Offline test: which emails count as someone writing to website@, grouping, contributions
// and how a Contacts row is merged (scripts/contacts). No Google or Claude calls.
// Run: node scripts/test-contacts.js
'use strict';

const assert = require('assert');
const c = require('./contacts/contacts');
const { buildText, classifyText, STATUS_ENUM } = require('./contacts/profile');
const { addressOf } = require('./ingest/google');

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
const profile = { name: 'Ann Hughes', organisation: 'Lenches WI', village: 'Church Lench', role: 'secretary', profile: 'Sends WI events.', status: 'organiser' };
const row = c.mergeRow(null, ann, contrib, profile, '2026-10-25 09:00');
assert.strictEqual(row.status, 'organiser', "Claude's choice");
assert.strictEqual(row.profile_source, 'auto');
assert.strictEqual(row.first_contact, '2026-09-01');
assert.strictEqual(row.last_contact, '2026-10-05');
assert.strictEqual(row.message_count, 2);
assert.strictEqual(row.name, 'Ann Hughes');
assert.strictEqual(row.organisation, 'Lenches WI');
assert.ok(!('notes' in row), 'notes never written');
const bare = c.mergeRow(null, groups.get('bob@x.com'), { list: '', count: 0 }, null, 'now');
assert.ok(!('status' in bare), 'no status without Claude');
assert.strictEqual(bare.name, 'Bob', 'display name when no profile');

// Existing row: only new messages counted, manual profile kept, status never changed once set.
const existing = { email: 'ann@example.com', name: 'Ann', profile: 'Hand-written', profile_source: 'manual', status: 'lead', first_contact: '2026-08-01', last_contact: '2026-09-01', message_count: '5' };
const upd = c.mergeRow(existing, ann, contrib, profile, 'now');
assert.strictEqual(upd.message_count, 6, 'only the 5 Oct email is new');
assert.strictEqual(upd.first_contact, '2026-08-01');
assert.strictEqual(upd.last_contact, '2026-10-05');
assert.ok(!('status' in upd), 'a set status is kept');
assert.ok(!('profile' in upd) && !('name' in upd), 'manual profile left alone');
const auto = c.mergeRow({ ...existing, profile_source: 'auto', status: '' }, ann, contrib, profile, 'now');
assert.strictEqual(auto.profile, 'Sends WI events.');
assert.strictEqual(auto.status, 'organiser', 'a blank status is filled');
assert.ok(!('status' in c.mergeRow({ ...existing, status: 'dormant' }, ann, contrib, profile, 'now')), 'old phase-1 values kept too');

// Status rules.
assert.strictEqual(c.statusFor('', 'Media'), 'media');
assert.strictEqual(c.statusFor('', 'none'), null);
assert.strictEqual(c.statusFor('', 'dormant'), null, 'not a choice any more');
assert.strictEqual(c.statusFor('key contact', 'lead'), null);
assert.ok(c.shouldAdd({ status: 'lead' }) && !c.shouldAdd({ status: 'none' }) && !c.shouldAdd(null), 'only people Claude places');
assert.deepStrictEqual(STATUS_ENUM.filter((x) => x !== 'none').sort(), [...c.STATUSES].sort(), 'Claude chooses from the same list');

// Cut-off and deletions.
assert.strictEqual(c.CUTOFF, '2026-10-26');
assert.strictEqual(c.tooOld(msg({ from: 'a@b.com', internalDate: Date.parse('2026-10-25T23:30:00Z') })), 'before cut-off', '25 Oct 23:30 UK (GMT from 25 Oct)');
assert.strictEqual(c.tooOld(msg({ from: 'a@b.com', internalDate: Date.parse('2026-10-26T00:30:00Z') })), '', '26 Oct 00:30 UK');
const deleted = c.deletedMap([
  { email: 'Gone@x.com', deleted_at: '2026-11-20T10:00:00.000Z' },
  { email: 'gone@x.com', deleted_at: '2026-11-01T10:00:00.000Z' },
  { email: 'bad@x.com', deleted_at: 'soon' },
]);
assert.deepStrictEqual([...deleted.keys()], ['gone@x.com']);
assert.strictEqual(c.tooOld(msg({ from: 'gone@x.com', internalDate: Date.parse('2026-11-15T10:00:00Z') }), deleted), 'before deletion', 'latest deletion wins');
assert.strictEqual(c.tooOld(msg({ from: 'gone@x.com', internalDate: Date.parse('2026-11-21T10:00:00Z') }), deleted), '', 'new mail after deletion counts');
assert.strictEqual(c.tooOld(msg({ from: 'other@x.com', internalDate: Date.parse('2026-11-15T10:00:00Z') }), deleted), '');

// Ignore rows.
assert.ok(c.locked({ status: 'Ignore' }));
assert.deepStrictEqual(c.clearIgnored({ _row: 3, email: 'x@y.com', name: 'X', profile: 'p', notes: ' ', status: 'ignore', message_count: 2 }),
  { name: '', profile: '', message_count: '' });
assert.strictEqual(c.clearIgnored({ _row: 3, email: 'x@y.com', status: 'ignore', name: '' }), null, 'already clear');
assert.ok(!c.locked(null) && !c.locked({ status: 'lead' }));

// Reclassify reads only the row (notes included, as Jon's context).
const ct = classifyText({ name: 'Phil', role: 'former treasurer', notes: 'Left the board', email: 'p@x.com' });
assert.ok(ct.includes('notes: Left the board') && ct.includes('profile: (blank)') && !ct.includes('p@x.com'));

// Claude input carries what we know and the emails, within budget.
const text = buildText(ann, { ...existing, profile: 'Old profile' }, contrib.list);
assert.ok(text.includes('Old profile') && text.includes('Quiz night (event, pending)') && text.includes('Subject: Quiz night'));
const huge = { ...ann, messages: Array.from({ length: 40 }, (_, i) => msg({ from: 'ann@example.com', internalDate: day('2026-01-01') + i * 864e5, text: 'x'.repeat(5000), subject: `S${i}` })) };
const t2 = buildText(huge, null, '');
assert.ok(t2.length < 30000 && t2.includes('Subject: S39') && !t2.includes('Subject: S0\n'), 'newest kept under budget');

// other_emails: one person, two addresses, one row (26 Oct: duplicates merged).
const rowsTab = [
  { email: 'ann@example.com', other_emails: 'Ann.Work@Example.org; ann@example.com', status: 'organiser', last_contact: '2026-09-01', message_count: 4 },
  { email: 'bob@x.com', other_emails: '', status: 'lead' },
  { email: 'old@example.net', status: 'organiser' },
  { email: 'carl@x.com', other_emails: 'old@example.net' },
];
assert.deepStrictEqual(c.addressesOf(rowsTab[0]), ['ann@example.com', 'ann.work@example.org'], 'addresses: email first, lower-cased, no repeats');
const byAddr = c.rowsByAddress(rowsTab);
assert.strictEqual(byAddr.get('ann.work@example.org'), rowsTab[0], 'other address finds the row');
assert.strictEqual(byAddr.get('old@example.net'), rowsTab[2], "a row's own email beats another row's other_emails");
const joined = c.joinSenders(c.groupBySender([
  msg({ from: 'Ann <ann.work@example.org>', internalDate: day('2026-10-07') }),
  msg({ from: 'Ann H <ann@example.com>', internalDate: day('2026-10-06') }),
  msg({ from: 'New <new@x.com>', internalDate: day('2026-10-06') }),
]), byAddr);
assert.deepStrictEqual([...joined.keys()].sort(), ['ann@example.com', 'new@x.com'], 'both addresses join under the row');
const annJ = joined.get('ann@example.com');
assert.deepStrictEqual(annJ.messages.map((m) => m.internalDate), [day('2026-10-06'), day('2026-10-07')], 'oldest first');
const annRow = c.mergeRow(rowsTab[0], annJ, { list: '', count: 0 }, null, '2026-10-26 09:00');
assert.strictEqual(annRow.email, 'ann@example.com', "the row's own email is kept");
assert.strictEqual(annRow.message_count, 6, 'mail from both addresses counted');
assert.strictEqual(annRow.last_contact, '2026-10-07');
assert.ok(!('other_emails' in annRow), 'code never writes other_emails');
const both = c.contributionsFor(c.addressesOf(rowsTab[0]), [...pending, { from: 'Ann <ann.work@example.org>', received: '2026-10-07 08:00', title: 'Boules', category: 'event', status: 'pending' }], addressOf);
assert.strictEqual(both.count, 3, 'Pending items from either address');

console.log('test-contacts: all passed');
