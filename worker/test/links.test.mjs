// worker/test/links.test.mjs: SEO → Inbound links (admin/links.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLinkEdit, linkPartners, LINK_STATUSES } from '../src/admin/links.js';

const row = { id: 'arch', name: 'ARCH', status: 'To ask', notes: '', email: '' };

test('planLinkEdit: status, notes and email only, cleaned and checked', () => {
  assert.deepEqual(planLinkEdit(row, { field: 'status', value: 'Asked', expected: 'To ask' }, '2026-11-26'),
    { field: 'status', expected: 'To ask', value: 'Asked', also: { asked_at: '2026-11-26' } });
  assert.equal(planLinkEdit({ ...row, status: 'Asked' }, { field: 'status', value: 'Asked', expected: 'Asked' }, 'd').also, null);
  assert.equal(planLinkEdit(row, { field: 'status', value: 'Maybe' }).status, 400);
  assert.equal(planLinkEdit(row, { field: 'url', value: 'x' }).status, 400);
  assert.equal(planLinkEdit(row, { field: 'link_found_at', value: 'x' }).status, 400, 'the check columns are the check\'s');
  assert.equal(planLinkEdit(row, { field: 'email', value: 'not an address' }).status, 400);
  assert.equal(planLinkEdit(row, { field: 'email', value: ' info@arch.org.uk ' }).value, 'info@arch.org.uk');
  assert.equal(planLinkEdit(row, { field: 'email', value: '' }).value, '', 'clearing is allowed');
  assert.equal(planLinkEdit(row, { field: 'notes', value: 'x'.repeat(501) }).status, 400);
  assert.equal(planLinkEdit(null, { field: 'notes', value: 'x' }).status, 404);
});

test('linkPartners: order, counts, blank status reads To ask, missing tab', () => {
  const t = linkPartners({ headers: ['id'], rows: [
    { id: 'a', name: 'Zed', status: 'Linking' }, { id: 'b', name: 'Bee', status: '' }, { id: 'c', name: 'Cee', status: 'Declined' },
    { id: 'd', name: 'Dee', status: 'Link gone' }, { id: '', name: '' },
  ] });
  assert.deepEqual(t.partners.map((p) => p.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(t.counts, { 'To ask': 1, 'Link gone': 1, Linking: 1, Declined: 1 });
  assert.equal(t.partners[0]._status, '', 'expected value is the raw cell');
  assert.equal(t.made, true);
  assert.deepEqual(t.statuses, LINK_STATUSES);
  assert.equal(linkPartners({ headers: [], rows: [] }).made, false);
});
