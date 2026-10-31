// node --test scripts/sheetwrite — offline, with a fake Sheets client.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run, parseValues, targetRange } = require('./index.js');

function fakeSheets(tabs) {
  const A = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range) => {
    const m = range.match(/^'((?:[^']|'')*)'(?:!(.*))?$/);
    const tab = m[1].replace(/''/g, "'");
    if (!m[2]) return { tab };
    const [a, b] = m[2].split(':');
    const p = (x) => { const r = x.match(/^([A-Z]+)(\d*)$/); return { c: A(r[1]), r: r[2] ? Number(r[2]) - 1 : null }; };
    const s = p(a), e = b ? p(b) : s;
    return { tab, c0: s.c, r0: s.r == null ? 0 : s.r, c1: e.c, r1: e.r == null ? Infinity : e.r };
  };
  return {
    tabs,
    spreadsheets: {
      get: async () => ({ data: { sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) } }),
      batchUpdate: async ({ requestBody }) => { for (const q of requestBody.requests) tabs[q.addSheet.properties.title] = []; },
      values: {
        get: async ({ range }) => {
          const q = parse(range); const t = tabs[q.tab];
          if (q.c0 == null) return { data: { values: t.map((r) => r.slice()) } };
          const out = [];
          for (let i = q.r0; i <= Math.min(q.r1, t.length - 1); i++) out.push((t[i] || []).slice(q.c0, q.c1 + 1));
          while (out.length && out[out.length - 1].every((v) => v === '' || v == null)) out.pop();
          return { data: { values: out } };
        },
        update: async ({ range, valueInputOption, requestBody }) => {
          assert.equal(valueInputOption, 'RAW');
          const q = parse(range); const t = tabs[q.tab];
          requestBody.values.forEach((row, i) => { const r = (t[q.r0 + i] = t[q.r0 + i] || []); row.forEach((v, j) => { r[q.c0 + j] = v; }); });
        },
      },
    },
  };
}

const quiet = () => {};
const base = () => ({ Contacts: [['email', 'name', 'status'], ['a@x.org', 'Ann', 'organiser']], Subscribers: [['email']] });

test('parseValues', () => {
  assert.deepEqual(parseValues('official'), [['official']]);
  assert.deepEqual(parseValues('["a","b"]'), [['a', 'b']]);
  assert.deepEqual(parseValues('[["a"],["b"]]'), [['a'], ['b']]);
  assert.equal(parseValues(''), null);
});

test('targetRange refuses row 1 and sizes the block', () => {
  assert.throws(() => targetRange('A1', [['x']]), /Row 1/);
  assert.equal(targetRange('B5', [['x', 'y']]).a1, 'B5:C5');
});

test('append writes the next row, logs it, and undo clears it', async () => {
  const s = fakeSheets(base());
  const out = [];
  const r = await run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'append', tab: 'Contacts', values: '["k@c.org","Kate","official"]' }, log: (l) => out.push(l) });
  assert.equal(r.range, 'A3:C3');
  assert.deepEqual(s.tabs.Contacts[2], ['k@c.org', 'Kate', 'official']);
  const log = s.tabs['Kryten log'];
  assert.equal(log[0][0], 'id');
  assert.equal(log[1][7], 'done');
  assert.ok(out.join('\n').includes('k***@c.org') && !out.join('\n').includes('k@c.org'));
  await run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'undo', undoId: r.id }, log: quiet });
  assert.deepEqual(s.tabs.Contacts[2], ['', '', '']);
  assert.match(s.tabs['Kryten log'][1][7], /^undone/);
  await assert.rejects(run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'undo', undoId: r.id }, log: quiet }), /nothing to undo/);
});

test('set is stale-checked', async () => {
  const s = fakeSheets(base());
  await assert.rejects(run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'set', tab: 'Contacts', range: 'C2', values: 'official' }, log: quiet }), /not blank/);
  await assert.rejects(run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'set', tab: 'Contacts', range: 'C2', values: 'official', expect: 'lead' }, log: quiet }), /not what was expected/);
  const r = await run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'set', tab: 'Contacts', range: 'C2', values: 'official', expect: 'organiser' }, log: quiet });
  assert.equal(s.tabs.Contacts[1][2], 'official');
  s.tabs.Contacts[1][2] = 'changed by Jon';
  await assert.rejects(run({ sheets: s, spreadsheetId: 'x', inputs: { action: 'undo', undoId: r.id }, log: quiet }), /has changed/);
  assert.equal(s.tabs.Contacts[1][2], 'changed by Jon');
});

test('refuses protected tabs, formulas and too many cells', async () => {
  const s = fakeSheets(base());
  const go = (inputs) => run({ sheets: s, spreadsheetId: 'x', inputs, log: quiet });
  await assert.rejects(go({ action: 'append', tab: 'Subscribers', values: 'a@b.c' }), /never written/);
  await assert.rejects(go({ action: 'append', tab: 'Kryten log', values: 'x' }), /never written/);
  await assert.rejects(go({ action: 'set', tab: 'Contacts', range: 'D2', values: '=IMPORTXML("x")' }), /Formulas/);
  await assert.rejects(go({ action: 'set', tab: 'Contacts', range: 'D2', values: JSON.stringify([Array(51).fill('x')]) }), /more than 50/);
  assert.equal(s.tabs['Kryten log'], undefined);
});
