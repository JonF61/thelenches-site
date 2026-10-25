// scripts/test-sheettab.js
// Offline test: the Read Sheet tab output (scripts/sheettab) — refused tabs, ranges,
// email masking and the CSV with row numbers. No Google calls.
// Run: node scripts/test-sheettab.js
'use strict';

const assert = require('assert');
const { isRefused, allowedColumns, redactColumns, parseRange, maskEmails, toCsv, colLetters, colIndex } = require('./sheettab/index');

for (const t of ['Subscribers', 'do not send', ' Sends ', 'REPLIES', 'Feedback', 'Deleted Contacts']) assert.ok(isRefused(t), t);
for (const t of ['Settings', 'Pending', 'Contacts', 'Reply feedback', 'Feedback log']) assert.ok(!isRefused(t), t);

assert.ok(allowedColumns(' contacts ').includes('name'));
assert.ok(!allowedColumns('Contacts').includes('profile') && !allowedColumns('Contacts').includes('notes'));
assert.strictEqual(allowedColumns('Settings'), null);
assert.deepStrictEqual(
  redactColumns([['Ann', 'Sends quiz nights', '', 'lead']], ['name', 'profile', 'notes', 'status'], allowedColumns('Contacts')),
  [['Ann', '(hidden)', '', 'lead']]);
assert.deepStrictEqual(
  redactColumns([['Me', 'x', '', 'Ignore'], ['Bob', '', '', 'lead']], ['name', 'profile', 'notes', 'status'], allowedColumns('Contacts')),
  [['(ignored row)'], ['Bob', '', '', 'lead']]);
assert.deepStrictEqual(redactColumns([['Me']], ['name'], allowedColumns('Contacts')), [['Me']], 'no status column read: not skipped');

assert.deepStrictEqual(parseRange(''), { range: '', startRow: 1, startCol: 'A', endCol: '' });
assert.deepStrictEqual(parseRange('a1:f20'), { range: 'A1:F20', startRow: 1, startCol: 'A', endCol: 'F' });
assert.deepStrictEqual(parseRange('C5:E'), { range: 'C5:E', startRow: 5, startCol: 'C', endCol: 'E' });
assert.deepStrictEqual(parseRange('B:D'), { range: 'B:D', startRow: 1, startCol: 'B', endCol: 'D' });
assert.throws(() => parseRange('Subscribers!A1:B2'));
assert.throws(() => parseRange("A1'"));

assert.strictEqual(colLetters(1), 'A');
assert.strictEqual(colLetters(27), 'AA');
assert.strictEqual(colIndex('AA'), 27);

assert.strictEqual(maskEmails('Write to jon.smith@example.co.uk now'), 'Write to j***@example.co.uk now');
assert.strictEqual(maskEmails('a@b.org, clerk@harvington-pc.gov.uk'), 'a***@b.org, c***@harvington-pc.gov.uk');
assert.strictEqual(maskEmails('https://harvington-pc.gov.uk/feed/'), 'https://harvington-pc.gov.uk/feed/');

const csv = toCsv({
  rows: [['Harvington PC', 'https://harvington-pc.gov.uk/feed/', 'ignore'], ['Quote "x", y', 'me@x.com']],
  header: ['name', 'url', 'mode'],
  startRow: 5,
  startCol: 'B',
  maxRows: 50,
});
assert.strictEqual(csv, [
  'row,B,C,D',
  '1,name,url,mode',
  '5,Harvington PC,https://harvington-pc.gov.uk/feed/,ignore',
  '6,"Quote ""x"", y",m***@x.com,',
].join('\n'));

const capped = toCsv({ rows: [['h'], ['a'], ['b'], ['c']], header: null, startRow: 1, startCol: 'A', maxRows: 2 });
assert.strictEqual(capped, 'row,A\n1,h\n2,a\n# 2 more rows not shown (max rows 2)');

console.log('test-sheettab: all passed');
